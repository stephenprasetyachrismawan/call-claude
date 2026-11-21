import { randomUUID } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { config } from './config.js';
import { ClaudeSession } from './claude.js';
import { VoiceLink } from './voice.js';
import { isResetCommand, isStopCommand, parseYesNo } from './safety.js';

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
    this.claude = new ClaudeSession({
      onText: (text) => this.say(text),
      onError: (message) => this.say(message),
      onToolUse: (name, summary) => this.log(`🔧 \`${name}\` ${summary ? `— ${summary.replace(/`/g, "'")}` : ''}`),
      requestApproval: (req) => this.requestApproval(req),
    });
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
    voice.on('stt-error', () => this.say('Maaf, suaramu gagal diproses. Coba ulangi.'));
    voice.on('closed', () => {
      if (this.voice === voice) this.voice = null;
    });
    this.voice = voice;

    try {
      await voice.join();
      console.log(`[bot] Masuk ke voice channel ${voiceChannel.name}`);
      await this.say('Halo, Claude siap. Silakan bicara.');
    } catch (err) {
      console.error('[bot] Gagal masuk voice channel:', err.message);
      this.voice = null;
      voice.leave();
    }
  }

  disconnect({ keepConversation = false } = {}) {
    if (this.voice) {
      this.voice.leave();
      this.voice = null;
      console.log('[bot] Keluar dari voice channel');
    }
    this.#settleApproval(false, 'panggilan berakhir');
    if (!keepConversation) this.claude.reset();
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

    if (isStopCommand(clean)) {
      if (this.claude.busy) {
        await this.claude.interrupt();
        await this.say('Oke, dihentikan.');
      } else {
        this.voice?.stopSpeaking();
      }
      return;
    }

    if (isResetCommand(clean)) {
      this.claude.reset();
      await this.say('Oke, kita mulai percakapan baru.');
      return;
    }

    const wasBusy = this.claude.busy;
    this.claude.send(clean);
    if (source === 'voice') this.voice?.speak(wasBusy ? 'Oke, nanti saya kerjakan juga.' : 'Sebentar.');
  }

  // ---- output ---------------------------------------------------------

  /** Post to the text channel and, during a call, read it aloud. */
  async say(text) {
    this.log(`🤖 ${text}`);
    if (this.inCall) await this.voice.speak(text);
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

  async requestApproval({ toolName, reason, summary }) {
    if (!this.textChannel && !this.inCall) return false;
    this.#settleApproval(false, 'diganti permintaan baru');

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

    if (this.inCall) this.voice.speak(`Claude mau ${reason}. ${spokenSummary(toolName, summary)} Boleh? Jawab ya atau tidak.`);
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
