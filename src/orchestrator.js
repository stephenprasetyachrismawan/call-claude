import { config } from './config.js';
import { ClaudeSession } from './claude.js';
import { Router } from './router.js';

const IDLE_CLOSE_MS = 30 * 60_000;

/**
 * The "head": every utterance is routed to a topic. Each topic has its own
 * Claude Code worker session, so different topics run in parallel and a new
 * question never waits for an unrelated one. When a worker finishes, its
 * answer is reported right away, labelled with the topic.
 *
 * handlers: onText(text, label), onError(message, label), onToolUse(name, summary, label),
 *           onRouted(label, isNew, wasBusy), requestApproval(req)
 */
export class Orchestrator {
  constructor(handlers) {
    this.handlers = handlers;
    this.router = new Router();
    this.topics = new Map(); // id -> { id, label, session, lastQuestion, lastAnswer, lastUsed }
    this.nextId = 1;
    this.routing = Promise.resolve(); // keep utterances in order
  }

  get busy() {
    return [...this.topics.values()].some((t) => t.session.busy);
  }

  send(text) {
    this.routing = this.routing.then(() => this.#route(text)).catch((err) => {
      this.handlers.onError(`Gagal memproses: ${err.message}`, '');
    });
    return this.routing;
  }

  async #route(text) {
    this.#closeIdle();
    const summary = [...this.topics.values()].map((t) => ({
      id: t.id,
      label: t.label,
      busy: t.session.busy,
      lastQuestion: t.lastQuestion.slice(0, 200),
      lastAnswer: t.lastAnswer.slice(0, 300),
    }));
    const { topic: chosen, label } = await this.router.classify(text, summary);

    let topic = this.topics.get(chosen);
    const isNew = !topic;
    if (isNew) topic = this.#createTopic(label);
    const wasBusy = topic.session.busy;
    topic.lastQuestion = text;
    topic.lastUsed = Date.now();
    this.handlers.onRouted?.(topic.label, isNew, wasBusy);
    topic.session.send(text);
  }

  #createTopic(label) {
    // Cap parallel workers: drop the least recently used idle topic.
    if (this.topics.size >= config.maxTopics) {
      const idle = [...this.topics.values()].filter((t) => !t.session.busy).sort((a, b) => a.lastUsed - b.lastUsed);
      if (idle[0]) this.#closeTopic(idle[0]);
    }
    const id = `t${this.nextId++}`;
    const topic = { id, label, lastQuestion: '', lastAnswer: '', lastUsed: Date.now() };
    topic.session = new ClaudeSession({
      onText: (text) => {
        topic.lastAnswer = text;
        topic.lastUsed = Date.now();
        this.handlers.onText(text, topic.label);
      },
      onError: (message) => this.handlers.onError(message, topic.label),
      onToolUse: (name, summary) => this.handlers.onToolUse?.(name, summary, topic.label),
      requestApproval: (req) => this.handlers.requestApproval(req),
    });
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

  /** Labels of topics still working. */
  busyLabels() {
    return [...this.topics.values()].filter((t) => t.session.busy).map((t) => t.label);
  }

  async interrupt() {
    await Promise.all([...this.topics.values()].map((t) => t.session.interrupt()));
  }

  reset() {
    for (const t of [...this.topics.values()]) this.#closeTopic(t);
  }
}
