import { randomUUID } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { config } from './config.js';
import { Conductor } from './conductor.js';
import { converse, frontEnabled, progress, relay } from './front.js';
import { transcribe } from './stt.js';
import path from 'node:path';
import { RemoteSession, RemoteWatcher } from './remote.js';
import { VoiceLink } from './voice.js';
import { LocalSessionWatcher } from './watcher.js';
import { killAllClaudeCallProcesses } from './claude.js';
import { GuestChat } from './guest.js';
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
    // Laptop: a main Claude session (orchestrator) with topic sessions under it.
    // Its answers reach the owner through Gemini.
    this.local = new Conductor({
      onText: (text, label) => this.relay('Claude', text, label ? `Claude · ${label}` : 'Claude'),
      onError: (message, label) => this.say(label ? `**[${label}]** ${message}` : message),
      onToolUse: (name, summary, label) => {
        this.#noteActivity(label, name, summary);
        this.log(`🔧 [${label}] \`${name}\` ${summary ? `— ${String(summary).replace(/`/g, "'")}` : ''}`);
      },
      requestApproval: (req) => this.requestApproval(req),
    });
    this.activity = new Map(); // label -> { since, steps: [{ name, summary, at }] }
    this.lastProgress = { at: 0, text: '', stepAt: 0 };
    this.progressTimer = null;
    this.pendingConverse = 0; // utterances Gemini is still answering
    this.remote = config.serverSsh && config.serverTmux ? new RemoteSession(handlers(`[${config.serverName}]`)) : null;
    this.claude = this.local; // the session the owner is currently talking to
    // Other people in the voice channel: chat only, no tools, no access.
    this.guests = new GuestChat({
      onText: (text, name) => this.say(`**[untuk ${name}]** ${text}`, name ? `Untuk ${name}. ${text}` : text),
      onError: (message, name) => this.say(name ? `**[untuk ${name}]** ${message}` : message),
    });
    this.model = Object.keys(MODELS).find((k) => MODELS[k].id === config.claudeModel) ?? null;

    // Answers from every other Claude session are read aloud as soon as they exist.
    const sameDir = (a, b) => path.resolve(a ?? '').toLowerCase() === path.resolve(b ?? '').toLowerCase();
    this.localWatcher = new LocalSessionWatcher({
      // Skip the bot's own workers (Agent SDK sessions in the bot's folder).
      skip: (info) => String(info.entrypoint ?? '').startsWith('sdk') && sameDir(info.cwd, config.workspaceDir),
      onAnswer: ({ name, text }) => this.relay(`sesi Claude "${name}" di laptop`, text, `laptop · ${name}`),
    });
    this.remoteWatcher = this.remote
      ? new RemoteWatcher({
          onAnswer: (event) => {
            if (this.remote.isMine(event)) {
              this.remote.answered();
              this.relay(`Claude di ${config.serverName}`, event.text, config.serverName);
            } else {
              const name = event.name || event.tmux || 'lain';
              this.relay(`sesi Claude "${name}" di ${config.serverName}`, event.text, `${config.serverName} · ${name}`);
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
    const who = (userId) => ({ id: userId, name: voiceChannel.members.get(userId)?.displayName });
    voice.on('audio', (mono, userId) => this.#onAudio(mono, who(userId)));
    // Text after the wake word ("hey Gemini, ...") is handled like typed text.
    voice.on('utterance', (text, userId) => this.handleInput(text, 'voice', who(userId)));
    voice.on('wake', () => this.log('🛑 Wake word: bacaan dihentikan, saya mendengarkan.'));
    // News from Claude waits while someone is talking or Gemini is answering.
    voice.holdLow = () => voice.recording.size > 0 || this.pendingConverse > 0;
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
      this.local.warm();
      this.#startProgressLoop();
      this.localWatcher.start();
      this.remoteWatcher?.start();
      this.#postModelPicker();
      await this.say(
        frontEnabled
          ? `Halo, aku Gemini. Claude siap di belakangku, topiknya pakai ${this.modelName}. Silakan bicara.`
          : `Halo, Claude siap dengan model ${this.modelName}. Untuk ganti, bilang pakai Opus atau pakai Haiku, atau tekan tombol di chat.`,
      );
    } catch (err) {
      console.error('[bot] Gagal masuk voice channel:', err.message);
      this.voice = null;
      voice.leave();
    }
  }

  disconnect({ keepConversation = false } = {}) {
    clearInterval(this.progressTimer);
    this.progressTimer = null;
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
      this.guests.reset();
      const killed = killAllClaudeCallProcesses();
      console.log(`[bot] Panggilan ditutup: semua sesi ClaudeCall dihentikan (${killed} proses tersisa dimatikan).`);
    }
  }

  // ---- input ----------------------------------------------------------

  /** Someone spoke: Gemini hears the audio (Whisper if Gemini is unavailable). */
  async #onAudio(mono, from) {
    const isOwner = from.id === config.ownerUserId;
    const name = from.name || (isOwner ? 'Pemilik' : 'Tamu');
    this.pendingConverse += 1;
    let result;
    try {
      result = frontEnabled ? await this.#converse({ mono, name, isOwner }) : null;
      if (!result) {
        // Gemini can't take the audio (or failed): Whisper writes it down.
        const heard = await transcribe(mono, { quick: true });
        const answer = heard && frontEnabled ? await this.#converse({ text: heard, name, isOwner }) : null;
        result = answer ? { ...answer, heard } : { heard, say: '', forward: null, fallback: true };
      }
    } catch (err) {
      console.error('[bot] STT gagal:', err.message);
      return;
    } finally {
      this.pendingConverse -= 1;
    }
    await this.#process(result, 'voice', { ...from, name, isOwner });
  }

  async #converse(input) {
    try {
      return await converse(input);
    } catch (err) {
      console.error('[gemini] gagal, pakai cadangan:', err.message);
      return null;
    }
  }

  /**
   * Typed text, or what followed the wake word.
   * @param {string} text
   * @param {'voice'|'text'} source
   * @param {{id?: string, name?: string}} [from] who said it (default: the owner)
   */
  async handleInput(text, source, from = {}) {
    const clean = text.trim();
    if (!clean) return;
    const isOwner = !from.id || from.id === config.ownerUserId;
    const name = from.name || (isOwner ? 'Pemilik' : 'Tamu');
    this.pendingConverse += 1;
    let result;
    try {
      result = frontEnabled ? await this.#converse({ text: clean, name, isOwner }) : null;
    } finally {
      this.pendingConverse -= 1;
    }
    if (!result || !result.heard) result = { heard: clean, say: result?.say ?? '', forward: result?.forward ?? null, fallback: !result };
    await this.#process(result, source, { ...from, name, isOwner });
  }

  /**
   * Act on what was said. result: { heard, say, forward, fallback }.
   * fallback = Gemini was unavailable (Whisper heard it, nobody answered yet).
   */
  async #process({ heard, say, forward, fallback }, source, { name, isOwner }) {
    const clean = String(heard ?? '').trim();
    if (!clean) return;
    if (source === 'voice') this.log(`🎙️ **${isOwner ? 'Kamu' : name}:** ${clean}`);

    if (!isOwner) {
      // Guests only get to chat. Commands, approvals and tools are the owner's.
      if (fallback) this.guests.send(clean, name);
      else if (say) this.#geminiSays(say, name);
      return;
    }

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

    if (say) this.#geminiSays(say);
    const request = fallback ? clean : forward;
    if (!request) return;
    this.log(`➡️ Ke ${this.claude === this.local ? 'Claude' : `Claude di ${config.serverName}`}: ${request}`);
    if (fallback && this.inCall) {
      this.voice.speak(this.claude === this.local ? 'Oke, saya teruskan ke Claude.' : `Oke, saya teruskan ke ${config.serverName}.`);
    }
    if (this.claude === this.local) this.local.send(request);
    else await this.claude.send(request);
  }

  /** Gemini's own reply to what someone just said: spoken first. */
  // ---- progress while the line is quiet --------------------------------

  #noteActivity(label, name, summary) {
    const key = label || 'utama';
    const entry = this.activity.get(key) ?? { since: Date.now(), steps: [] };
    entry.steps.push({ name, summary: String(summary ?? '').slice(0, 160), at: Date.now() });
    if (entry.steps.length > 4) entry.steps.shift();
    this.activity.set(key, entry);
  }

  /** Plain text of what Claude is doing right now, or '' when nothing runs. */
  #statusText() {
    if (this.claude !== this.local || !this.local.busy) return '';
    const busy = new Set(this.local.busyLabels().map((l) => (l === 'sesi utama' ? 'utama' : l)));
    for (const key of [...this.activity.keys()]) if (!busy.has(key)) this.activity.delete(key);
    const now = Date.now();
    return [...busy]
      .map((label) => {
        const entry = this.activity.get(label);
        const name = label === 'utama' ? 'Claude (sesi utama)' : `topik "${label}"`;
        if (!entry) return `- ${name}: sedang berpikir, belum ada langkah.`;
        const mins = Math.round((now - entry.since) / 60_000);
        const steps = entry.steps.map((s) => `${s.name}${s.summary ? ` (${s.summary})` : ''}`).join('; ');
        return `- ${name}: sudah ${mins < 1 ? 'kurang dari semenit' : `${mins} menit`}, langkah terakhir: ${steps}`;
      })
      .join('\n');
  }

  /** When the line is quiet and Claude is still working, Gemini says what is going on. */
  #startProgressLoop() {
    clearInterval(this.progressTimer);
    this.lastProgress = { at: 0, text: '', stepAt: 0 };
    if (!frontEnabled || !config.idleProgressS) return;
    let asking = false;
    this.progressTimer = setInterval(async () => {
      const voice = this.voice;
      if (asking || !voice || this.pendingConverse > 0 || this.approval) return;
      const quietMs = voice.quietMs;
      const sinceLast = Date.now() - this.lastProgress.at;
      if (quietMs < config.idleProgressS * 1000 || sinceLast < config.idleProgressS * 1000) return;
      const status = this.#statusText();
      if (!status) return;
      // Something new happened, or it has been a while: worth an update.
      const latestStep = Math.max(0, ...[...this.activity.values()].flatMap((e) => e.steps.map((s) => s.at)));
      const isNew = latestStep > this.lastProgress.stepAt;
      if (!isNew && sinceLast < 60_000) return;
      asking = true;
      const heardBefore = voice.lastHeardAt;
      try {
        const text = await progress(status, this.lastProgress.text);
        this.lastProgress = { at: Date.now(), text: text || this.lastProgress.text, stepAt: latestStep };
        // Someone spoke meanwhile, or the call changed: drop the update.
        if (!text || this.voice !== voice || voice.lastHeardAt !== heardBefore || voice.recording.size > 0) return;
        this.log(`🟦 **Gemini (progres):** ${text}`);
        voice.speak(text, { priority: 2 });
      } catch (err) {
        this.lastProgress.at = Date.now();
        console.error('[gemini] update progres gagal:', err.message);
      } finally {
        asking = false;
      }
    }, 2_000);
  }

  #geminiSays(text, toName) {
    this.log(`🟦 **Gemini${toName ? ` → ${toName}` : ''}:** ${text}`);
    if (this.inCall) this.voice.speak(text, { priority: 0 });
  }

  /**
   * A message from Claude (or another session) for the owner: the full text
   * goes to the chat; Gemini says it in its own words, after anything that
   * answers what someone just said.
   */
  async relay(source, text, chatLabel) {
    this.log(`🤖 **[${chatLabel}]** ${text}`);
    if (!this.inCall) return;
    let spoken = `${source}: ${text}`;
    if (frontEnabled) {
      try {
        spoken = await relay(source, text);
        this.log(`🟦 **Gemini:** ${spoken}`);
      } catch (err) {
        console.error('[gemini] relay gagal, dibacakan langsung:', err.message);
      }
    }
    if (this.inCall) this.voice.speak(spoken, { priority: 1 });
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
