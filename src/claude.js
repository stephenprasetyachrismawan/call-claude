import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { config } from './config.js';
import { assessRisk, needsConsent } from './safety.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = path.join(ROOT, 'scripts');
export const PLUGIN_DIR = path.join(ROOT, 'plugin');

// ---- every Claude Code process ClaudeCall starts --------------------------

/** pid -> title of every live Claude Code process started by ClaudeCall. */
const processes = new Map();

/** Kill a process and everything it started (background shells, servers...). */
function killTree(pid) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    try {
      process.kill(-pid, 'SIGKILL'); // whole process group (spawned detached)
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }
}

/**
 * spawnClaudeCodeProcess for the Agent SDK: a normal spawn, but the pid is
 * remembered so the whole tree can be killed when the call ends.
 */
export function trackedSpawn(title) {
  return (options) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    child.stderr?.on('data', () => {});
    if (child.pid) {
      processes.set(child.pid, title);
      child.once('exit', () => processes.delete(child.pid));
    }
    return child;
  };
}

/** Kill one tracked Claude Code process tree. */
function killProcess(pid) {
  if (!processes.has(pid)) return;
  processes.delete(pid);
  killTree(pid);
}

/** Kill every Claude Code process ClaudeCall started (and their children). */
export function killAllClaudeCallProcesses() {
  const pids = [...processes.keys()];
  for (const pid of pids) killProcess(pid);
  return pids.length;
}
const PS = 'powershell -NoProfile -ExecutionPolicy Bypass -File';

const VOICE_PROMPT = `
Kamu sedang ditelepon oleh pemilik laptop ini lewat voice channel Discord dari HP-nya.
- Ucapannya diubah menjadi teks oleh speech-to-text, jadi bisa ada salah dengar. Kalau perintahnya ambigu, tanyakan dulu dengan singkat.
- Jawabanmu akan dibacakan dengan text-to-speech. Jawab dalam Bahasa Indonesia yang santai dan singkat (1 sampai 3 kalimat, kecuali diminta detail). Jangan pakai markdown, tabel, daftar, atau blok kode. Sampaikan hasilnya, bukan langkah-langkahnya.
- Kamu adalah sesi ClaudeCall. Selalu ikuti skill claude-call (gaya jawaban lisan, kapan minta izin, kerja kode bebas tanpa izin).
- Laptop ini memakai Windows. Untuk urusan sistem, pakai PowerShell (misalnya: powershell -NoProfile -Command "...").
- Folder kerja default: ${config.workspaceDir}
- Kamu boleh bekerja di folder mana pun di laptop ini.
- Bisa jadi ada beberapa sesi Claude lain yang bekerja paralel untuk topik lain; fokus pada topikmu sendiri.
- Mengontrol layar desktop (membuka aplikasi seperti WhatsApp, Chrome, Word, Claude, dll.):
  1. Selalu buka lewat: ${PS} "${path.join(SCRIPTS, 'open-app.ps1')}" -Name <nama aplikasi> (tambahkan -Launch <exe/URL> kalau perlu). Skrip ini menunggu jendela muncul, membawanya ke depan, lalu melaporkan JSON "ok".
  2. Jangan anggap aplikasi sudah terbuka hanya karena perintah start berhasil. Kalau "ok" false, atau untuk memastikan, ambil screenshot: ${PS} "${path.join(SCRIPTS, 'screenshot.ps1')}", lalu baca file PNG-nya dengan tool Read dan lihat apakah jendelanya benar-benar tampil.
  3. Kalau belum tampil, klik ikon aplikasinya di taskbar bawah: cari posisinya di screenshot, lalu ${PS} "${path.join(SCRIPTS, 'click.ps1')}" -X <x> -Y <y> -FromImage. Setelah itu ambil screenshot lagi untuk memastikan.
  4. Untuk mengetik atau menekan tombol di jendela yang aktif: ${PS} "${path.join(SCRIPTS, 'type.ps1')}" -Text "..." atau -Keys "{ENTER}".
  Laporkan ke pemilik hanya setelah kamu melihat sendiri di screenshot bahwa aplikasinya terbuka.
- Pakai skill yang tersedia (tool Skill) setiap kali ada skill yang cocok dengan permintaan.
- Untuk menghubungi sesi Claude lain milik pemilik (sesi lain di laptop ini, atau sesi Remote Control di komputer/server lain), pakai tool ListAgents untuk melihat daftarnya dan SendMessage untuk mengirim pesan.
${config.permissionMode === 'confirm'
    ? '- Beberapa aksi berisiko otomatis dimintakan persetujuan pemilik. Kalau aksi ditolak, jangan mencari cara lain untuk melakukan hal yang sama.'
    : '- Pemilik sudah mengizinkan semua aksi tanpa konfirmasi. Tetap hati-hati: untuk aksi yang tidak bisa dibatalkan (menghapus data penting, memformat disk, mematikan laptop) dan perintahnya terdengar janggal atau ambigu, ulangi dulu perintahnya dan tanyakan kepastian secara lisan.'}
`.trim();

/** Minimal async queue used as the streaming prompt for the Agent SDK. */
export class AsyncQueue {
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
export function claudeEnv() {
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
  /**
   * @param {object} [extra] { prompt: extra system prompt text, mcpServers: in-process MCP servers }
   */
  constructor(handlers, model = config.claudeModel, title = 'ClaudeCall', extra = {}) {
    this.extra = extra;
    this.handlers = handlers;
    this.model = model;
    this.title = title;
    this.pids = new Set();
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

  /** Switch model; a running conversation keeps its context. */
  async setModel(model) {
    this.model = model;
    await this.q?.setModel(model).catch((err) => console.error('[claude] setModel:', err.message));
  }

  async interrupt() {
    if (!this.q || !this.busy) return;
    this.interrupted = true;
    await this.q.interrupt().catch(() => {});
  }

  /** End the conversation and kill its Claude Code process with everything it started. */
  reset() {
    this.queue?.end();
    this.abort?.abort();
    for (const pid of this.pids) killProcess(pid);
    this.pids.clear();
    this.queue = null;
    this.q = null;
    this.pending = 0;
    this.interrupted = false;
  }

  #start() {
    // Spawning Claude Code in a missing folder fails with a confusing error.
    fs.mkdirSync(config.workspaceDir, { recursive: true });
    this.queue = new AsyncQueue();
    this.abort = new AbortController();
    const q = query({
      prompt: this.queue,
      options: {
        cwd: config.workspaceDir,
        model: this.model,
        env: { ...claudeEnv(), CLAUDE_CALL_SESSION: '1' },
        title: this.title,
        spawnClaudeCodeProcess: (options) => {
          const child = trackedSpawn(this.title)(options);
          if (child.pid) this.pids.add(child.pid);
          return child;
        },
        plugins: [{ type: 'local', path: PLUGIN_DIR }],
        ...(this.extra.mcpServers ? { mcpServers: this.extra.mcpServers } : {}),
        hooks: {
          // Sending messages, posting, email, shutdown: ask the owner first, even in bypass mode.
          PreToolUse: [{ hooks: [(input, _id, { signal }) => this.#consentHook(input, signal)], timeout: config.confirmTimeoutS + 30 }],
        },
        abortController: this.abort,
        // Load the owner's Claude Code setup: user/project settings, CLAUDE.md,
        // skills, plugins and MCP servers, just like running `claude` there.
        settingSources: ['user', 'project', 'local'],
        skills: 'all',
        // Start Remote Control for this session so SendMessage can reach the
        // owner's sessions on other machines (e.g. a server running `claude rc`).
        settings: { remoteControlAtStartup: config.remoteControl },
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: this.extra.prompt ? `${VOICE_PROMPT}\n\n${this.extra.prompt}` : VOICE_PROMPT,
        },
        ...(config.permissionMode === 'confirm'
          ? {
              permissionMode: 'default',
              canUseTool: (toolName, input, { signal }) => this.#canUseTool(toolName, input, signal),
            }
          : { permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true }),
      },
    });
    this.q = q;
    this.#consume(q);
  }

  async #consentHook(input, signal) {
    const need = needsConsent(input.tool_name ?? '', input.tool_input ?? {});
    if (!need) return {};
    const approved = await this.handlers
      .requestApproval({ toolName: input.tool_name, reason: need.reason, summary: need.summary, consent: true })
      .catch(() => false);
    if (approved && !signal?.aborted) {
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'Pemilik mengizinkan.' } };
    }
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Pemilik tidak mengizinkan ini. Jangan kirim dengan cara lain; tanyakan apa yang mau diubah.',
      },
    };
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
