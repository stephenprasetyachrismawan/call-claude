import fs from 'node:fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { config } from './config.js';
import { AsyncQueue, claudeEnv } from './claude.js';

const ROUTER_PROMPT = `
Kamu adalah "kepala" yang memilah ucapan pemilik ke topik kerja yang sedang berjalan.
Setiap pesan berisi daftar topik aktif (JSON) dan satu ucapan baru.
Tentukan apakah ucapan itu lanjutan dari salah satu topik aktif, atau topik baru.
- Lanjutan: merujuk ke pekerjaan yang sedang berjalan ("yang tadi", "lanjutkan", "ubah jadi..."), menjawab pertanyaan yang diajukan topik itu, atau jelas membahas hal yang sama.
- Topik baru: hal lain yang bisa dikerjakan terpisah tanpa menunggu topik lain.
Balas HANYA dengan satu baris JSON tanpa teks lain:
{"topic": "<id topik aktif atau new>", "label": "<label 2-4 kata Bahasa Indonesia untuk topik itu>"}
`.trim();

/**
 * A small, fast Claude (no tools) that decides which topic an utterance
 * belongs to. Kept alive between calls so routing takes ~1-2 s, not a spawn.
 */
export class Router {
  constructor() {
    this.queue = null;
    this.q = null;
    this.waiters = [];
    this.calls = 0;
  }

  #start() {
    fs.mkdirSync(config.workspaceDir, { recursive: true });
    this.queue = new AsyncQueue();
    const q = query({
      prompt: this.queue,
      options: {
        cwd: config.workspaceDir,
        model: config.routerModel,
        env: claudeEnv(),
        settingSources: [],
        tools: [],
        systemPrompt: ROUTER_PROMPT,
        permissionMode: 'default',
      },
    });
    this.q = q;
    (async () => {
      try {
        for await (const msg of q) {
          if (msg.type === 'result') this.waiters.shift()?.(msg.subtype === 'success' ? msg.result : '');
        }
      } catch {
        // fall through: pending callers get '' below
      }
      if (this.q === q) this.q = null;
      for (const w of this.waiters.splice(0)) w('');
    })();
  }

  #restart() {
    this.queue?.end();
    this.q = null;
    this.calls = 0;
  }

  /**
   * @param {string} utterance
   * @param {{id: string, label: string, busy: boolean, lastQuestion: string, lastAnswer: string}[]} topics
   * @returns {Promise<{topic: string, label: string}>}
   */
  async classify(utterance, topics) {
    if (topics.length === 0) return { topic: 'new', label: quickLabel(utterance) };
    const raw = await this.#ask(utterance, topics);
    const parsed = parseJson(raw);
    if (parsed && (parsed.topic === 'new' || topics.some((t) => t.id === parsed.topic))) {
      return { topic: parsed.topic, label: String(parsed.label || 'topik baru').slice(0, 40) };
    }
    return { topic: 'new', label: 'topik baru' };
  }

  #ask(utterance, topics) {
    if (this.calls >= 40) this.#restart(); // keep the router's context small
    if (!this.q) this.#start();
    this.calls += 1;
    const content = `Topik aktif:\n${JSON.stringify(topics)}\n\nUcapan baru:\n${utterance}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(''), 20_000);
      this.waiters.push((text) => {
        clearTimeout(timer);
        resolve(text);
      });
      this.queue.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null });
    });
  }
}

/** First few words of the utterance, for the first topic (no model call needed). */
function quickLabel(text) {
  const words = String(text).replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  return words.slice(0, 4).join(' ').toLowerCase() || 'topik baru';
}

function parseJson(text) {
  const match = String(text ?? '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}
