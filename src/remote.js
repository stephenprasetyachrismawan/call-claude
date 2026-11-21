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
 * Talks to a Claude Code session running in tmux on the server (for example
 * one started with `claude rc` / Remote Control). Same interface as ClaudeSession.
 */
export class RemoteSession {
  constructor(handlers, target = config.serverTmux) {
    this.handlers = handlers;
    this.target = target;
    this.queue = [];
    this.running = false;
  }

  get busy() {
    return this.running || this.queue.length > 0;
  }

  send(text) {
    this.queue.push(text);
    if (!this.running) this.#drain();
  }

  async interrupt() {
    this.queue = [];
    await runHelper(['interrupt', this.target], () => {}).catch(() => {});
  }

  reset() {
    this.queue = [];
  }

  async #drain() {
    this.running = true;
    while (this.queue.length) {
      const text = this.queue.shift();
      const b64 = Buffer.from(text, 'utf8').toString('base64');
      let answered = false;
      try {
        await runHelper(['send', this.target, b64], (event) => {
          if (event.event === 'tool') this.handlers.onToolUse?.(event.name, event.input);
          else if (event.event === 'done') {
            answered = true;
            this.handlers.onText(event.text || 'Selesai.');
          } else if (event.event === 'timeout') {
            answered = true;
            this.handlers.onText(event.text || 'Claude di server belum selesai menjawab.');
          } else if (event.event === 'error') {
            answered = true;
            this.handlers.onError(event.message);
          }
        });
        if (!answered) this.handlers.onError('Tidak ada jawaban dari Claude di server.');
      } catch (err) {
        this.handlers.onError(`Gagal terhubung ke server: ${String(err.message).slice(0, 200)}`);
      }
    }
    this.running = false;
  }
}
