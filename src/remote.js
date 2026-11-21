import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const HELPER = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'remote-helper.py'), 'utf8');

/** Run the helper on the server over SSH. Yields parsed JSON lines. */
function runHelper(args, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', config.serverSsh, 'python3', '-u', '-', ...args], {
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      try {
        onLine(JSON.parse(line));
      } catch {
        // ignore non-JSON noise (motd etc.)
      }
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim() || `ssh keluar dengan kode ${code}`))));
    child.stdin.end(HELPER);
  });
}

/** List tmux panes on the server that run Claude Code. */
export async function listRemoteSessions() {
  let rows = [];
  await runHelper(['list'], (data) => {
    if (Array.isArray(data)) rows = data;
  });
  return rows;
}

/**
 * Watches every Claude Code session on the server and calls
 * onAnswer({ sessionId, name, tmux, text }) whenever one finishes a turn,
 * whoever started it. Keeps one SSH connection open and reconnects if it drops.
 */
export class RemoteWatcher {
  constructor({ onAnswer }) {
    this.onAnswer = onAnswer;
    this.child = null;
    this.running = false;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.#run();
  }

  stop() {
    this.running = false;
    this.child?.kill();
    this.child = null;
  }

  #run() {
    if (!this.running) return;
    const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=30', config.serverSsh, 'python3', '-u', '-', 'watch'], {
      windowsHide: true,
    });
    this.child = child;
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      try {
        const event = JSON.parse(line);
        if (event.event === 'answer' && event.text) this.onAnswer(event);
      } catch {
        // ignore non-JSON noise
      }
    });
    child.stderr.on('data', () => {});
    child.on('error', () => {});
    child.on('close', () => {
      if (this.child === child) this.child = null;
      if (this.running) setTimeout(() => this.#run(), 10_000);
    });
    child.stdin.end(HELPER);
  }
}

/**
 * Talks to a Claude Code session running in tmux on the server (for example
 * one started with `claude rc` / Remote Control). Same interface as ClaudeSession.
 * It only types the message; the answer is reported by RemoteWatcher (call
 * answered() when it arrives), so replies are spoken as soon as they exist.
 */
export class RemoteSession {
  constructor(handlers, target = config.serverTmux) {
    this.handlers = handlers;
    this.target = target;
    this.sessionId = null;
    this.waiting = 0;
  }

  get busy() {
    return this.waiting > 0;
  }

  async send(text) {
    const b64 = Buffer.from(text, 'utf8').toString('base64');
    let typed = false;
    try {
      await runHelper(['type', this.target, b64], (event) => {
        if (event.event === 'typed') {
          typed = true;
          this.sessionId = event.sessionId;
          this.waiting += 1;
        } else if (event.event === 'error') {
          this.handlers.onError(event.message);
        }
      });
      if (!typed) this.handlers.onError('Pesan tidak sampai ke Claude di server.');
    } catch (err) {
      this.handlers.onError(`Gagal terhubung ke server: ${String(err.message).slice(0, 200)}`);
    }
  }

  /** True if this answer came from the session we talk to. */
  isMine(event) {
    return (this.sessionId && event.sessionId === this.sessionId) || event.tmux === this.target;
  }

  answered() {
    this.waiting = 0;
  }

  async interrupt() {
    this.waiting = 0;
    await runHelper(['interrupt', this.target], () => {}).catch(() => {});
  }

  reset() {
    this.waiting = 0;
  }
}
