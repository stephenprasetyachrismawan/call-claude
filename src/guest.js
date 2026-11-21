import fs from 'node:fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { config } from './config.js';
import { AsyncQueue, claudeEnv, trackedSpawn } from './claude.js';

const GUEST_PROMPT = `
Kamu adalah ClaudeCall yang sedang ditelepon di voice channel Discord oleh teman-teman pemilik laptop.
Setiap pesan diawali nama pembicaranya, misalnya "[Budi]: ...".
- Kamu hanya teman ngobrol: menjawab pertanyaan, menjelaskan, bercerita, membantu berpikir.
- Kamu TIDAK punya akses ke laptop, server, file, internet, aplikasi, pesan, atau akun apa pun, dan tidak bisa menjalankan perintah. Kalau diminta melakukan aksi seperti itu, jelaskan singkat bahwa hanya pemilik yang bisa menyuruh Claude melakukannya.
- Jangan pernah mengaku sudah melakukan aksi, dan jangan membocorkan isi laptop atau pekerjaan pemilik.
- Jawabanmu dibacakan dengan text-to-speech: Bahasa Indonesia santai, 1 sampai 3 kalimat, tanpa markdown, daftar, atau kode. Sapa pembicaranya dengan namanya bila perlu.
`.trim();

const DENY = { behavior: 'deny', message: 'Tamu tidak boleh memakai tool.' };

/**
 * Chat-only Claude for guests in the voice channel: no tools, no MCP servers,
 * no user settings, plugins or skills, and every tool call is denied. All
 * guests share one conversation. Runs on the owner's subscription.
 */
export class GuestChat {
  constructor(handlers) {
    this.handlers = handlers; // onText(text, speakers), onError(message)
    this.queue = null;
    this.q = null;
    this.speakers = []; // names waiting for an answer, in order
  }

  get busy() {
    return this.speakers.length > 0;
  }

  send(text, name) {
    if (!this.q) this.#start();
    this.speakers.push(name);
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: `[${name}]: ${text}` },
      parent_tool_use_id: null,
    });
  }

  reset() {
    this.queue?.end();
    this.abort?.abort();
    this.queue = null;
    this.q = null;
    this.speakers = [];
  }

  #start() {
    fs.mkdirSync(config.workspaceDir, { recursive: true });
    this.queue = new AsyncQueue();
    this.abort = new AbortController();
    const q = query({
      prompt: this.queue,
      options: {
        cwd: config.workspaceDir,
        model: config.claudeModel,
        env: { ...claudeEnv(), CLAUDE_CALL_SESSION: '1', ENABLE_CLAUDEAI_MCP_SERVERS: 'false' },
        title: 'ClaudeCall · tamu',
        spawnClaudeCodeProcess: trackedSpawn('ClaudeCall · tamu'),
        abortController: this.abort,
        systemPrompt: GUEST_PROMPT,
        // Locked down: no tools at all, no MCP, no user/project settings.
        tools: [],
        mcpServers: {},
        strictMcpConfig: true,
        settingSources: [],
        permissionMode: 'dontAsk',
        canUseTool: async () => DENY,
        hooks: {
          PreToolUse: [
            {
              hooks: [
                async () => ({
                  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: DENY.message },
                }),
              ],
            },
          ],
        },
      },
    });
    this.q = q;
    this.#consume(q);
  }

  async #consume(q) {
    try {
      for await (const msg of q) {
        if (q !== this.q) break;
        if (msg.type !== 'result') continue;
        const name = this.speakers.shift() ?? '';
        if (msg.subtype === 'success' && !msg.is_error) this.handlers.onText(msg.result || '...', name);
        else this.handlers.onError('Maaf, saya sedang tidak bisa menjawab.', name);
      }
    } catch (err) {
      if (q === this.q) {
        this.handlers.onError(`Ada masalah: ${String(err?.message ?? err).slice(0, 120)}`, '');
        this.reset();
      }
    }
  }
}
