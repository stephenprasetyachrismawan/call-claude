import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const POLL_MS = 1500;
const TAIL_BYTES = 512 * 1024;

/**
 * Text of a transcript content field (string or content blocks).
 * Exported for tests.
 */
export function textOf(content) {
  if (typeof content === 'string') return content;
  return (content ?? [])
    .filter((b) => b?.type === 'text')
    .map((b) => b.text ?? '')
    .join('\n')
    .trim();
}

/**
 * The last answer in a transcript (JSONL lines): the assistant text written
 * after the most recent real user prompt. Exported for tests.
 */
export function lastAnswer(lines) {
  let answer = '';
  for (const line of lines) {
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.isSidechain) continue;
    const content = d.message?.content;
    if (d.type === 'user' && !d.isMeta) {
      const isPrompt = typeof content === 'string' || (content ?? []).some((b) => b?.type === 'text');
      if (isPrompt) answer = '';
    } else if (d.type === 'assistant') {
      const t = textOf(content);
      if (t) answer = t;
    }
  }
  return answer;
}

/**
 * Watches the Claude Code sessions on this computer (~/.claude/sessions) and
 * calls onAnswer({ sessionId, name, text }) each time one of them finishes a
 * turn, whoever started it. The bot's own worker sessions are skipped (they
 * report their answers directly).
 */
export class LocalSessionWatcher {
  constructor({ onAnswer, skip }) {
    this.onAnswer = onAnswer;
    this.skip = skip ?? (() => false);
    this.home = path.join(os.homedir(), '.claude');
    this.status = new Map(); // sessionId -> last status@statusUpdatedAt
    this.spoken = new Map(); // sessionId -> last answer spoken
    this.timer = null;
    this.first = true;
  }

  start() {
    if (this.timer) return;
    this.first = true;
    this.timer = setInterval(() => this.#poll(), POLL_MS);
    this.#poll();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  #poll() {
    let files = [];
    try {
      files = fs.readdirSync(path.join(this.home, 'sessions')).filter((f) => f.endsWith('.json'));
    } catch {
      return;
    }
    for (const file of files) {
      let info;
      try {
        info = JSON.parse(fs.readFileSync(path.join(this.home, 'sessions', file), 'utf8'));
      } catch {
        continue;
      }
      if (!info?.sessionId || this.skip(info)) continue;
      // A turn ended when the session became idle again (statusUpdatedAt
      // changes on every status change, so a short turn between two polls
      // is not missed).
      const key = `${info.status}@${info.statusUpdatedAt ?? ''}`;
      const prev = this.status.get(info.sessionId);
      this.status.set(info.sessionId, key);
      if (this.first || prev === undefined || prev === key || info.status !== 'idle') continue;
      const text = this.#answer(info.sessionId);
      if (text && this.spoken.get(info.sessionId) !== text) {
        this.spoken.set(info.sessionId, text);
        this.onAnswer({ sessionId: info.sessionId, name: info.name || info.sessionId.slice(0, 8), text });
      }
    }
    this.first = false;
  }

  #answer(sessionId) {
    const dir = path.join(this.home, 'projects');
    let file = null;
    try {
      for (const project of fs.readdirSync(dir)) {
        const candidate = path.join(dir, project, `${sessionId}.jsonl`);
        if (fs.existsSync(candidate)) {
          file = candidate;
          break;
        }
      }
    } catch {
      return '';
    }
    if (!file) return '';
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const lines = buf.toString('utf8').split('\n');
      if (start > 0) lines.shift(); // first line may be partial
      return lastAnswer(lines);
    } finally {
      fs.closeSync(fd);
    }
  }
}
