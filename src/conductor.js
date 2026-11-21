import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { config } from './config.js';
import { ClaudeSession } from './claude.js';

const IDLE_CLOSE_MS = 30 * 60_000;
export const SILENT = '<diam>';

const MAIN_PROMPT = `
PERANMU: kamu adalah sesi utama (orkestrator) ClaudeCall.
- Pemilik tidak bicara langsung denganmu. Ia bicara dengan Gemini, dan Gemini meneruskan permintaannya kepadamu sebagai pesan "[Pemilik lewat Gemini]: ...". Jawabanmu dikirim ke Gemini, yang menyampaikannya ke pemilik dengan suara. Jadi tulis jawaban singkat dan jelas (1 sampai 3 kalimat), tanpa markdown.
- Kamu punya sesi topik di bawahmu (tool mcp__claudecall__start_topic, send_to_topic, list_topics, stop_topic). Pakai sesi topik untuk pekerjaan yang butuh lebih dari beberapa langkah, makan waktu, atau bisa jalan paralel (koding, riset, mengurus aplikasi). Pertanyaan cepat yang bisa kamu jawab dalam satu atau dua langkah, jawab sendiri.
- Saat membuka topik, beri tugas yang lengkap dan mandiri (sesi topik tidak melihat percakapan ini), lalu jawab pemilik singkat, misalnya "Oke, aku kerjakan soal X."
- Lanjutan dari pekerjaan yang sedang berjalan: kirim ke topik yang sama dengan send_to_topic, jangan buka topik baru.
- Laporan dari sesi topik datang sebagai pesan "[Laporan topik <id> · <label>]: ...". Rangkum untuk pemilik dalam 1 sampai 3 kalimat, diawali nama topiknya. Kalau sesi topik bertanya sesuatu yang harus dijawab pemilik, sampaikan pertanyaannya.
- Kalau tidak ada yang perlu disampaikan ke pemilik, balas persis: ${SILENT}
`.trim();

/**
 * The laptop side: a main Claude session (orchestrator, Sonnet by default)
 * that receives the owner's requests from Gemini and runs topic sessions
 * under it through in-process tools. Topic reports go back to the main
 * session, whose answers are handed to onText (and from there to Gemini).
 *
 * handlers: onText(text, label), onError(message, label), onToolUse(name, summary, label),
 *           requestApproval(req)
 */
export class Conductor {
  constructor(handlers) {
    this.handlers = handlers;
    this.topics = new Map(); // id -> { id, label, session, lastUsed }
    this.nextId = 1;
    this.model = config.claudeModel; // for topic sessions (model picker)
    this.main = null;
  }

  #mainSession() {
    if (this.main) return this.main;
    const server = createSdkMcpServer({
      name: 'claudecall',
      version: '1.0.0',
      tools: this.#tools(),
    });
    this.main = new ClaudeSession(
      {
        onText: (text) => {
          if (text.trim() !== SILENT) this.handlers.onText(text, '');
        },
        onError: (message) => this.handlers.onError(message, ''),
        onToolUse: (name, summary) => this.handlers.onToolUse?.(name, summary, 'utama'),
        requestApproval: (req) => this.handlers.requestApproval(req),
      },
      config.orchestratorModel,
      'ClaudeCall · utama',
      { prompt: MAIN_PROMPT, mcpServers: { claudecall: server } },
    );
    return this.main;
  }

  #tools() {
    const text = (t) => ({ content: [{ type: 'text', text: t }] });
    return [
      tool(
        'start_topic',
        'Buka sesi topik baru (sesi Claude Code terpisah yang jalan paralel) dan beri tugas pertamanya. Hasilnya nanti dilaporkan kepadamu.',
        { label: z.string().describe('Nama topik 2-4 kata, Bahasa Indonesia'), task: z.string().describe('Tugas lengkap dan mandiri') },
        async ({ label, task }) => {
          const topic = this.#createTopic(label);
          topic.session.send(task);
          return text(`Topik ${topic.id} (${topic.label}) dibuat dan mulai bekerja.`);
        },
      ),
      tool(
        'send_to_topic',
        'Kirim pesan lanjutan (tugas tambahan, koreksi, jawaban pemilik) ke sesi topik yang sudah ada.',
        { id: z.string(), message: z.string() },
        async ({ id, message }) => {
          const topic = this.topics.get(id);
          if (!topic) return text(`Topik ${id} tidak ada. Topik aktif: ${this.#list()}`);
          topic.lastUsed = Date.now();
          topic.session.send(message);
          return text(`Terkirim ke topik ${id} (${topic.label}).`);
        },
      ),
      tool('list_topics', 'Daftar sesi topik yang aktif dan statusnya.', {}, async () => text(this.#list())),
      tool(
        'stop_topic',
        'Hentikan dan tutup satu sesi topik.',
        { id: z.string() },
        async ({ id }) => {
          const topic = this.topics.get(id);
          if (!topic) return text(`Topik ${id} tidak ada.`);
          this.#closeTopic(topic);
          return text(`Topik ${id} (${topic.label}) ditutup.`);
        },
      ),
    ];
  }

  #list() {
    const rows = [...this.topics.values()].map((t) => `${t.id} · ${t.label} · ${t.session.busy ? 'sedang bekerja' : 'menunggu'}`);
    return rows.length ? rows.join('\n') : '(tidak ada topik aktif)';
  }

  #createTopic(label) {
    this.#closeIdle();
    if (this.topics.size >= config.maxTopics) {
      const idle = [...this.topics.values()].filter((t) => !t.session.busy).sort((a, b) => a.lastUsed - b.lastUsed);
      if (idle[0]) this.#closeTopic(idle[0]);
    }
    const id = `t${this.nextId++}`;
    const topic = { id, label: String(label || 'topik').slice(0, 40), lastUsed: Date.now() };
    const report = (body) => this.#mainSession().send(`[Laporan topik ${id} · ${topic.label}]: ${body}`);
    topic.session = new ClaudeSession(
      {
        onText: (t) => {
          topic.lastUsed = Date.now();
          report(t);
        },
        onError: (message) => report(`(error) ${message}`),
        onToolUse: (name, summary) => this.handlers.onToolUse?.(name, summary, topic.label),
        requestApproval: (req) => this.handlers.requestApproval(req),
      },
      this.model,
      `ClaudeCall · ${topic.label}`,
    );
    this.topics.set(id, topic);
    return topic;
  }

  #closeTopic(topic) {
    topic.session.reset();
    this.topics.delete(topic.id);
  }

  #closeIdle() {
    const now = Date.now();
    for (const t of [...this.topics.values()]) {
      if (!t.session.busy && now - t.lastUsed > IDLE_CLOSE_MS) this.#closeTopic(t);
    }
  }

  /** A request from the owner (already understood by Gemini). */
  send(text) {
    this.#mainSession().send(`[Pemilik lewat Gemini]: ${text}`);
  }

  /** Start the main session ahead of time. */
  warm() {
    this.#mainSession();
  }

  get busy() {
    return Boolean(this.main?.busy) || [...this.topics.values()].some((t) => t.session.busy);
  }

  busyLabels() {
    const labels = [...this.topics.values()].filter((t) => t.session.busy).map((t) => t.label);
    if (this.main?.busy) labels.unshift('sesi utama');
    return labels;
  }

  /** Model for topic sessions, existing and new. */
  setModel(model) {
    this.model = model;
    for (const t of this.topics.values()) t.session.setModel(model);
  }

  async interrupt() {
    await Promise.all([this.main?.interrupt(), ...[...this.topics.values()].map((t) => t.session.interrupt())]);
  }

  /** Close everything: kills all ClaudeCall sessions. */
  reset() {
    for (const t of [...this.topics.values()]) this.#closeTopic(t);
    this.main?.reset();
    this.main = null;
  }
}
