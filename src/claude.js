import { query } from '@anthropic-ai/claude-agent-sdk';
import { config } from './config.js';
import { assessRisk } from './safety.js';

const VOICE_PROMPT = `
Kamu sedang ditelepon oleh pemilik laptop ini lewat voice channel Discord dari HP-nya.
- Ucapannya diubah menjadi teks oleh speech-to-text, jadi bisa ada salah dengar. Kalau perintahnya ambigu, tanyakan dulu dengan singkat.
- Jawabanmu akan dibacakan dengan text-to-speech. Jawab dalam Bahasa Indonesia yang santai dan singkat (1 sampai 3 kalimat, kecuali diminta detail). Jangan pakai markdown, tabel, daftar, atau blok kode. Sampaikan hasilnya, bukan langkah-langkahnya.
- Laptop ini memakai Windows. Untuk urusan sistem, pakai PowerShell (misalnya: powershell -NoProfile -Command "...").
- Folder kerja default: ${config.workspaceDir}
- Beberapa aksi berisiko (menghapus, menginstal, mematikan laptop, mengubah sistem, dll.) otomatis dimintakan persetujuan pemilik. Kalau aksi ditolak, jangan mencari cara lain untuk melakukan hal yang sama. Sampaikan saja bahwa aksinya dibatalkan.
`.trim();

/** Minimal async queue used as the streaming prompt for the Agent SDK. */
class AsyncQueue {
  #items = [];
  #waiters = [];
  #ended = false;

  push(item) {
    if (this.#ended) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.#items.push(item);
  }

  end() {
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.#items.length) return Promise.resolve({ value: this.#items.shift(), done: false });
        if (this.#ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

/** Environment for the Claude Code process: always the subscription login, never an API key. */
function claudeEnv() {
  const env = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'call-claude/1.0' };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  if (config.claudeOAuthToken) env.CLAUDE_CODE_OAUTH_TOKEN = config.claudeOAuthToken;
  return env;
}

/**
 * One long-lived Claude Code conversation driven by the Agent SDK.
 *
 * handlers:
 *   onText(text)            final answer for a turn
 *   onToolUse(name, summary) a tool Claude is running (for the chat log)
 *   onError(message)
 *   requestApproval({ toolName, reason, summary }) => Promise<boolean>
 */
export class ClaudeSession {
  constructor(handlers) {
    this.handlers = handlers;
    this.queue = null;
    this.q = null;
    this.pending = 0; // user messages sent but not yet answered
  }

  get busy() {
    return this.pending > 0;
  }

  send(text) {
    if (!this.q) this.#start();
    this.pending += 1;
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    });
  }

  async interrupt() {
    if (!this.q || !this.busy) return;
    this.interrupted = true;
    await this.q.interrupt().catch(() => {});
  }

  reset() {
    this.queue?.end();
    this.abort?.abort();
    this.queue = null;
    this.q = null;
    this.pending = 0;
    this.interrupted = false;
  }

  #start() {
    this.queue = new AsyncQueue();
    this.abort = new AbortController();
    const q = query({
      prompt: this.queue,
      options: {
        cwd: config.workspaceDir,
        model: config.claudeModel,
        env: claudeEnv(),
        abortController: this.abort,
        // Do not load the user's Claude Code settings: their allow rules would
        // skip our approval check. Every non-read-only call goes through canUseTool.
        settingSources: [],
        permissionMode: 'default',
        systemPrompt: { type: 'preset', preset: 'claude_code', append: VOICE_PROMPT },
        canUseTool: (toolName, input, { signal }) => this.#canUseTool(toolName, input, signal),
      },
    });
    this.q = q;
    this.#consume(q);
  }

  async #canUseTool(toolName, input, signal) {
    const risk = assessRisk(toolName, input, config.workspaceDir);
    if (!risk.risky) return { behavior: 'allow', updatedInput: input };

    const approved = await this.handlers.requestApproval({ toolName, ...risk }).catch(() => false);
    if (signal?.aborted) return { behavior: 'deny', message: 'Dibatalkan.' };
    if (approved) return { behavior: 'allow', updatedInput: input };
    return {
      behavior: 'deny',
      message: 'Pemilik laptop menolak aksi ini. Jangan coba cara lain untuk melakukan hal yang sama.',
    };
  }

  async #consume(q) {
    try {
      for await (const msg of q) {
        if (q !== this.q) break; // session was reset

        if (msg.type === 'assistant') {
          for (const block of msg.message?.content ?? []) {
            if (block.type === 'tool_use') {
              const { summary } = assessRisk(block.name, block.input ?? {}, config.workspaceDir);
              this.handlers.onToolUse?.(block.name, summary);
            }
          }
        } else if (msg.type === 'result') {
          this.pending = Math.max(0, this.pending - 1);
          if (this.interrupted) {
            this.interrupted = false;
            continue; // the owner asked to stop; no error message needed
          }
          if (msg.subtype === 'success' && !msg.is_error) {
            this.handlers.onText(msg.result || 'Selesai.');
          } else {
            const detail = msg.result || (msg.errors ?? []).join('; ') || msg.subtype;
            this.handlers.onError(describeError(detail));
          }
        }
      }
    } catch (err) {
      if (q === this.q) {
        this.handlers.onError(describeError(err?.message ?? String(err)));
        this.reset();
      }
    }
  }
}

function describeError(detail) {
  const text = String(detail ?? '');
  if (/log ?in|auth|credential|401|unauthor/i.test(text)) {
    return 'Claude belum login. Di laptop, jalankan claude lalu ketik /login dengan akun langgananmu.';
  }
  if (/limit|quota|429|rate/i.test(text)) {
    return 'Batas pemakaian langganan Claude sedang habis. Coba lagi setelah limitnya reset.';
  }
  return `Ada masalah dengan Claude: ${text.slice(0, 200)}`;
}
