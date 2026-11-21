import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import {
  AudioPlayerStatus,
  EndBehaviorType,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} from '@discordjs/voice';
import prism from 'prism-media';
import { config } from './config.js';
import { pcmDurationSeconds, rms, toMono16k } from './audio.js';
import { transcribe } from './stt.js';
import { splitForSpeech, synthesize, toSpeakable } from './tts.js';
import { parseWakeWord } from './safety.js';

const MIN_UTTERANCE_S = 0.4;
const MAX_UTTERANCE_S = 60;
const MIN_LOUDNESS = 0.004;
// Quiet time after the last clip before listening again, so the end of our
// own speech (or its echo on the phone) is never picked up as the owner.
const LISTEN_AFTER_SPEECH_MS = 800;
// While the bot speaks, the owner's voice is only checked for "hey Claude".
const WAKE_MAX_S = 6;
const WAKE_SILENCE_MS = 600;

/**
 * Voice connection to one channel. Listens to everyone in it (not bots) and
 * emits 'utterance' (text, userId) with the transcribed text. speak() reads text aloud.
 * Speech is strict: every queued answer is read to the end, in order. While
 * the bot speaks, the owner's voice is not taken as input, it is only checked
 * for the wake word "hey Claude": that stops all speech right away (emits
 * 'wake') and the bot listens again. Without the wake word, the answer just
 * keeps playing and what was said is dropped.
 */
export class VoiceLink extends EventEmitter {
  constructor(channel) {
    super();
    this.channel = channel;
    this.connection = null;
    // maxMissedFrames: never give up on a clip because audio arrived late
    // (the default of 5 frames = 100 ms is what used to cut answers off).
    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play, maxMissedFrames: 500 },
    });
    this.player.on('error', (err) => console.error('[voice] player error:', err.message));
    this.recording = new Set(); // user ids being recorded right now
    this.items = []; // queued answers (see speak)
    this.seq = 0;
    this.pumping = false;
    this.talking = false;
    this.holdLow = null; // () => boolean, set by the assistant
    this.pendingSpeech = 0; // queued or playing answers
    this.speechEndedAt = 0;
    this.closed = false;
    this.epoch = 0; // bumped by "hey Claude": drops everything queued before it
  }

  async join() {
    this.connection = joinVoiceChannel({
      channelId: this.channel.id,
      guildId: this.channel.guild.id,
      adapterCreator: this.channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });
    this.connection.on('error', (err) => console.error('[voice] connection error:', err.message));
    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        // Moved to another channel or a brief network blip: wait for reconnect.
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        this.leave();
        this.emit('closed');
      }
    });

    await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);
    this.connection.subscribe(this.player);
    this.connection.receiver.speaking.on('start', (userId) => {
      // Everyone in the channel can talk to Claude (except bots); the
      // assistant decides what each person may do.
      const member = this.channel.guild.members.cache.get(userId);
      if (member?.user.bot || userId === this.channel.client.user?.id) return;
      this.#listen(userId);
    });
  }

  leave() {
    // The only thing that ends speech early: the call itself is over.
    this.closed = true;
    this.player.stop(true);
    try {
      this.connection?.destroy();
    } catch {
      // already destroyed
    }
    this.connection = null;
  }

  /** True while the bot is (about to be) talking, plus a short tail. */
  get speaking() {
    if (this.talking) return true;
    if (this.player.state.status !== AudioPlayerStatus.Idle) return true;
    return Date.now() - this.speechEndedAt < LISTEN_AFTER_SPEECH_MS;
  }

  /**
   * Queue text to be spoken. Resolves when it has been read (or dropped).
   * priority 0 = reply to what someone just said (goes first, between
   * sentences of anything already playing); 1 = news from Claude or another
   * session (waits while someone is talking or being answered, see holdLow).
   * Long text is split into sentences; the next pieces are synthesized while
   * the current one plays. A sentence is never cut off, except by the wake word.
   */
  speak(text, { priority = 0 } = {}) {
    const pieces = splitForSpeech(toSpeakable(text));
    if (!pieces.length || this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      this.items.push({ pieces, clips: [], idx: 0, priority, epoch: this.epoch, seq: this.seq++, resolve, queuedAt: Date.now() });
      this.pendingSpeech += 1;
      this.#pump();
    });
  }

  #finish(item) {
    const i = this.items.indexOf(item);
    if (i >= 0) this.items.splice(i, 1);
    this.pendingSpeech = Math.max(0, this.pendingSpeech - 1);
    item.resolve();
  }

  async #pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        for (const item of [...this.items]) if (item.epoch !== this.epoch || this.closed) this.#finish(item);
        if (!this.items.length || !this.connection) break;
        const item = [...this.items].sort((a, b) => a.priority - b.priority || a.seq - b.seq)[0];
        // News waits while someone is talking or being answered (max 30 s).
        if (item.priority > 0 && item.idx === 0 && this.holdLow?.() && Date.now() - item.queuedAt < 30_000) {
          await new Promise((r) => setTimeout(r, 300));
          continue;
        }
        this.talking = true;
        for (let j = item.clips.length; j < Math.min(item.idx + 3, item.pieces.length); j++) {
          item.clips.push(this.#synth(item.pieces[j]));
        }
        const audio = await item.clips[item.idx];
        if (item.epoch === this.epoch && !this.closed && this.connection && audio?.length) await this.#play(audio);
        this.speechEndedAt = item.epoch === this.epoch ? Date.now() : 0;
        item.idx += 1;
        if (item.idx >= item.pieces.length) this.#finish(item);
        this.talking = this.items.some((x) => x.idx > 0); // mid-answer: keep the floor
      }
    } catch (err) {
      console.error('[voice] TTS error:', err.message);
    } finally {
      this.talking = false;
      this.pumping = false;
    }
  }

  /** Wake word: stop the current clip and drop everything queued. */
  interruptSpeech() {
    this.epoch += 1;
    this.player.stop(true);
    this.speechEndedAt = 0;
    this.#pump();
  }

  async #synth(text) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return await synthesize(text);
      } catch (err) {
        console.error(`[voice] TTS gagal (percobaan ${attempt}):`, err.message);
      }
    }
    return null;
  }

  /** Play one complete clip and wait until it has finished. */
  #play(audio) {
    return new Promise((resolve) => {
      let started = false;
      const finish = () => {
        clearTimeout(timer);
        this.player.off('stateChange', onState);
        resolve();
      };
      const onState = (_old, now) => {
        if (now.status !== AudioPlayerStatus.Idle) started = true;
        else if (started) finish();
      };
      const timer = setTimeout(finish, 5 * 60_000);
      this.player.on('stateChange', onState);
      try {
        this.player.play(createAudioResource(Readable.from([audio]), { inputType: StreamType.Arbitrary }));
      } catch (err) {
        console.error('[voice] play error:', err.message);
        finish();
      }
    });
  }

  #listen(userId) {
    if (this.recording.has(userId) || !this.connection) return;
    if (this.closed) return;
    // While speaking, only listen for the wake word (short clips).
    const wakeOnly = this.speaking;
    this.recording.add(userId);

    const opus = this.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: wakeOnly ? WAKE_SILENCE_MS : config.silenceMs },
    });
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    const chunks = [];
    let bytes = 0;
    const maxBytes = (wakeOnly ? WAKE_MAX_S : MAX_UTTERANCE_S) * 48000 * 2 * 2;

    const finish = () => {
      if (!this.recording.has(userId)) return;
      this.recording.delete(userId);
      const pcm = Buffer.concat(chunks);
      this.#handleAudio(pcm, wakeOnly, userId).catch((err) => {
        console.error('[voice] STT error:', err.message);
        this.emit('stt-error', err);
      });
    };

    decoder.on('data', (chunk) => {
      chunks.push(chunk);
      bytes += chunk.length;
      if (bytes > maxBytes) opus.destroy();
    });
    decoder.once('end', finish);
    decoder.once('close', finish);
    decoder.on('error', (err) => console.error('[voice] decode error:', err.message));
    opus.once('close', () => decoder.end());
    opus.pipe(decoder);
  }

  async #handleAudio(pcm, wakeOnly, userId) {
    if (pcmDurationSeconds(pcm) < MIN_UTTERANCE_S) return;
    const mono = toMono16k(pcm);
    if (rms(mono) < MIN_LOUDNESS) return;
    if (!wakeOnly) {
      // The assistant decides who hears it (Gemini, or Whisper as fallback).
      this.emit('audio', mono, userId);
      return;
    }
    // While speaking, only the wake word counts (checked locally with Whisper).
    const text = await transcribe(mono, { quick: true });
    const wake = text ? parseWakeWord(text) : null;
    if (!wake) return; // no wake word: let the bot keep talking
    console.log('[voice] Wake word, bacaan dihentikan');
    this.interruptSpeech();
    this.emit('wake', userId);
    if (wake.rest) this.emit('utterance', wake.rest, userId);
  }
}
