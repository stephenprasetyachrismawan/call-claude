import { randomUUID } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { config } from './config.js';
import { Orchestrator } from './orchestrator.js';
import path from 'node:path';
import { RemoteSession, RemoteWatcher } from './remote.js';
import { VoiceLink } from './voice.js';
import { LocalSessionWatcher } from './watcher.js';
import { killAllClaudeCallProcesses } from './claude.js';
import {
  MODELS,
  isResetCommand,
  isStatusCommand,
  isStopCommand,
  parseModelCommand,
  parseSwitchCommand,
  parseYesNo,
} from './safety.js';

const DISCORD_LIMIT = 1900;

function chunkText(text) {
  const parts = [];
  let rest = String(text);
  while (rest.length > DISCORD_LIMIT) {
    let cut = rest.lastIndexOf('\n', DISCORD_LIMIT);
    if (cut < DISCORD_LIMIT / 2) cut = DISCORD_LIMIT;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.trim()) parts.push(rest);
  return parts;
}

/**
 * Ties together the owner's voice call, the text channel and Claude.
 * There is one owner, so there is one Assistant for the whole bot.
 */
export class Assistant {
  constructor(client) {
    this.client = client;
    this.voice = null;
    this.textChannel = null;
    this.approval = null; // { id, resolve, message, timer }
    this.approvalChain = Promise.resolve(); // one approval question at a time
    const handlers = (label) => ({
      onText: (text) => this.say(label ? `${label}: ${text}` : text, text),
      onError: (message) => this.say(message),
      onToolUse: (name, summary) =>
        this.log(`🔧 ${label ? `[${label}] ` : ''}\`${name}\` ${summary ? `— ${String(summary).replace(/`/g, "'")}` : ''}`),
      requestApproval: (req) => this.requestApproval(req),
    });
    // Laptop: a head that routes each utterance to a parallel worker per topic.
    this.local = new Orchestrator({
      onText: (text, label) => this.say(`**[${label}]** ${text}`, `Soal ${label}. ${text}`),
      onError: (message, label) => this.say(label ? `**[${label}]** ${message}` : message),
      onToolUse: (name, summary, label) =>
        this.log(`🔧 [${label}] \`${name}\` ${summary ? `— ${String(summary).replace(/`/g, "'")}` : ''}`),
      onRouted: (label, isNew, wasBusy) => {
        const ack = isNew
          ? `Oke, saya kerjakan soal ${label}.`
          : wasBusy
            ? `Oke, saya tambahkan ke soal ${label}.`
            : `Oke, lanjut soal ${label}.`;
        this.log(`🧭 ${ack}`);
        if (this.inCall) this.voice.speak(ack);
      },
      requestApproval: (req) => this.requestApproval(req),
    });
    this.remote = config.serverSsh && config.serverTmux ? new RemoteSession(handlers(`[${config.serverName}]`)) : null;
    this.claude = this.local; // the session the owner is currently talking to
    this.model = Object.keys(MODELS).find((k) => MODELS[k].id === config.claudeModel) ?? null;

    // Answers from every other Claude session are read aloud as soon as they exist.
    const sameDir = (a, b) => path.resolve(a ?? '').toLowerCase() === path.resolve(b ?? '').toLowerCase();
    this.localWatcher = new LocalSessionWatcher({
      // Skip the bot's own workers (Agent SDK sessions in the bot's folder).
      skip: (info) => String(info.entrypoint ?? '').startsWith('sdk') && sameDir(info.cwd, config.workspaceDir),
      onAnswer: ({ name, text }) => this.say(`**[laptop · ${name}]** ${text}`, `Dari sesi ${name}. ${text}`),
    });
    this.remoteWatcher = this.remote
      ? new RemoteWatcher({
          onAnswer: (event) => {
            if (this.remote.isMine(event)) {
              this.remote.answered();
              this.say(`**[${config.serverName}]** ${event.text}`, `Dari ${config.serverName}. ${event.text}`);
            } else {
              const name = event.name || event.tmux || 'lain';
              this.say(`**[${config.serverName} · ${name}]** ${event.text}`, `Dari sesi ${name} di ${config.serverName}. ${event.text}`);
            }
          },
        })
      : null;
  }

  get modelName() {
    return this.model ? MODELS[this.model].name : config.claudeModel;
  }

  /** Switch the model of all laptop workers (existing and new). */
  async setModel(key) {
    if (!MODELS[key]) return;
    this.model = key;
    this.local.setModel(MODELS[key].id);
    await this.say(`Oke, sekarang pakai ${MODELS[key].name}.`);
  }

  /** Buttons to pick the model, posted when a call starts. */
  async #postModelPicker() {
    if (!this.textChannel) return;
    const row = new ActionRowBuilder().addComponents(
      ...Object.entries(MODELS).map(([key, m]) =>
        new ButtonBuilder()
          .setCustomId(`model:${key}`)
          .setLabel(m.name)
          .setStyle(key === this.model ? ButtonStyle.Primary : ButtonStyle.Secondary),
      ),
    );
    await this.textChannel
      .send({ content: `🧠 Model sekarang: **${this.modelName}**. Pilih model lain:`, components: [row], allowedMentions: { parse: [] } })
      .catch(() => {});
  }

  get inCall() {
    return Boolean(this.voice?.connection);
  }

  // ---- call lifecycle -------------------------------------------------

  async connect(voiceChannel) {
    if (this.voice?.channel.id === voiceChannel.id) return;
    this.disconnect({ keepConversation: true });

    this.textChannel = config.textChannelId
      ? await this.client.channels.fetch(config.textChannelId).catch(() => null)
      : voiceChannel; // voice channels have their own text chat
    if (!this.textChannel?.isTextBased()) this.textChannel = voiceChannel;

    const voice = new VoiceLink(voiceChannel);
    voice.on('utterance', (text) => this.handleInput(text, 'voice'));
    voice.on('wake', () => this.log('🛑 "Hey Claude": bacaan dihentikan, saya mendengarkan.'));
    voice.on('stt-error', () => this.say('Maaf, suaramu gagal diproses. Coba ulangi.'));
    voice.on('closed', () => {
      if (this.voice !== voice) return;
      this.voice = null;
      console.log('[bot] Koneksi voice terputus');
      // Discord dropped us but the owner is still there: join again.
      setTimeout(() => {
        if (!this.voice && voiceChannel.members.has(config.ownerUserId)) this.connect(voiceChannel);
      }, 2_000);
    });
    this.voice = voice;

    try {
      await voice.join();
      console.log(`[bot] Masuk ke voice channel ${voiceChannel.name}`);
      this.local.router.warm();
      this.localWatcher.start();
      this.remoteWatcher?.start();
      this.#postModelPicker();
      await this.say(
        `Halo, Claude siap dengan model ${this.modelName}. Untuk ganti, bilang pakai Opus atau pakai Haiku, atau tekan tombol di chat.`,
      );
    } catch (err) {
      console.error('[bot] Gagal masuk voice channel:', err.message);
      this.voice = null;
      voice.leave();
    }
  }

  disconnect({ keepConversation = false } = {}) {
    this.localWatcher.stop();
    this.remoteWatcher?.stop();
    if (this.voice) {
      this.voice.leave();
      this.voice = null;
      console.log('[bot] Keluar dari voice channel');
    }
    this.#settleApproval(false, 'panggilan berakhir');
    if (!keepConversation) {
      // Call closed: stop every ClaudeCall session, foreground and background.
      this.local.reset();
      const killed = killAllClaudeCallProcesses();
      console.log(`[bot] Panggilan ditutup: semua sesi ClaudeCall dihentikan (${killed} proses tersisa dimatikan).`);
    }
  }

  // ---- input ----------------------------------------------------------

  async handleInput(text, source) {
    const clean = text.trim();
    if (!clean) return;
    if (source === 'voice') this.log(`🎙️ **Kamu:** ${clean}`);

    if (this.approval) {
      const answer = parseYesNo(clean);
      if (answer) this.#settleApproval(answer === 'yes', source === 'voice' ? 'lewat suara' : 'lewat chat');
      else await this.say('Jawab ya atau tidak dulu, ya.');
      return;
    }

    if (isStatusCommand(clean)) {
      const labels = this.claude === this.local ? this.local.busyLabels() : this.claude.busy ? [config.serverName] : [];
      await this.say(labels.length ? `Sedang dikerjakan: ${labels.join(', ')}.` : 'Tidak ada yang sedang dikerjakan.');
      return;
    }

    if (isStopCommand(clean)) {
      // Stops Claude's work. Speech already queued is still read to the end.
      if (this.claude.busy) {
        await this.claude.interrupt();
        await this.say('Oke, semua pekerjaan dihentikan.');
      } else {
        await this.say('Tidak ada pekerjaan yang sedang berjalan.');
      }
      return;
    }

    const model = parseModelCommand(clean);
    if (model) {
      await this.setModel(model);
      return;
    }

    const target = parseSwitchCommand(clean);
    if (target === 'server') {
      if (!this.remote) {
        await this.say('Server belum diatur. Isi SERVER_SSH dan SERVER_TMUX di file .env.');
      } else {
        this.claude = this.remote;
        await this.say(`Oke, sekarang kamu bicara dengan Claude di ${config.serverName}.`);
      }
      return;
    }
    if (target === 'laptop') {
      this.claude = this.local;
      await this.say('Oke, kembali ke Claude di laptop.');
      return;
    }

    if (isResetCommand(clean)) {
      this.claude.reset();
      await this.say('Oke, kita mulai percakapan baru.');
      return;
    }

    if (this.claude === this.local) {
      this.local.send(clean); // the head acknowledges once it has picked a topic
      return;
    }
    if (source === 'voice') this.voice?.speak(`Oke, saya teruskan ke ${config.serverName}.`);
    await this.claude.send(clean);
  }

  // ---- output ---------------------------------------------------------

  /** Post to the text channel and, during a call, read it aloud. */
  async say(text, spoken = text) {
    this.log(`🤖 ${text}`);
    if (this.inCall) await this.voice.speak(spoken);
  }

  log(text) {
    if (!this.textChannel) return;
    for (const part of chunkText(text)) {
      this.textChannel.send({ content: part, allowedMentions: { parse: [] } }).catch((err) => {
        console.error('[bot] Gagal kirim pesan:', err.message);
      });
    }
  }

  // ---- approvals ------------------------------------------------------

  /** Parallel workers may ask at the same time: ask one question at a time. */
  requestApproval(req) {
    const next = this.approvalChain.then(() => this.#askApproval(req));
    this.approvalChain = next.catch(() => {});
    return next;
  }

  async #askApproval({ toolName, reason, summary, consent }) {
    if (!this.textChannel && !this.inCall) return false;

    const id = randomUUID();
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`approve:${id}`).setLabel('Izinkan').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`deny:${id}`).setLabel('Tolak').setStyle(ButtonStyle.Danger),
    );
    const content =
      `⚠️ **Claude minta izin** untuk ${reason}\n` +
      `Tool: \`${toolName}\`\n\`\`\`\n${summary.replace(/```/g, "'''")}\n\`\`\`\n` +
      `Jawab **ya** / **tidak** lewat suara atau tekan tombol (${config.confirmTimeoutS} detik).`;

    const message = await this.textChannel
      ?.send({ content, components: [row], allowedMentions: { parse: [] } })
      .catch(() => null);

    const decision = new Promise((resolve) => {
      const timer = setTimeout(() => this.#settleApproval(false, 'waktu habis'), config.confirmTimeoutS * 1000);
      this.approval = { id, resolve, message, timer };
    });

    if (this.inCall) {
      const detail = consent ? `${summary.slice(0, 250)}.` : spokenSummary(toolName, summary);
      this.voice.speak(`Saya perlu izinmu untuk ${reason}. ${detail} Boleh? Jawab ya atau tidak.`);
    }
    return decision;
  }

  /** Called by the button handler. Returns false if the id is stale. */
  resolveApprovalButton(id, approved) {
    if (this.approval?.id !== id) return false;
    this.#settleApproval(approved, 'lewat tombol');
    return true;
  }

  #settleApproval(approved, how) {
    const pending = this.approval;
    if (!pending) return;
    this.approval = null;
    clearTimeout(pending.timer);
    pending.resolve(approved);
    const verdict = approved ? '✅ Diizinkan' : '❌ Ditolak';
    pending.message?.edit({ content: `${pending.message.content}\n\n${verdict} (${how})`, components: [] }).catch(() => {});
    if (this.inCall && how !== 'diganti permintaan baru') this.voice.speak(approved ? 'Oke, dijalankan.' : 'Oke, dibatalkan.');
  }
}

function spokenSummary(toolName, summary) {
  if (toolName === 'Bash' || toolName === 'PowerShell') {
    const short = summary.length > 90 ? `${summary.slice(0, 90)}` : summary;
    return `Perintahnya: ${short}.`;
  }
  return summary.length > 90 ? '' : `${summary}.`;
}
