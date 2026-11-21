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

const MIN_UTTERANCE_S = 0.4;
const MAX_UTTERANCE_S = 60;
const MIN_LOUDNESS = 0.004;
// Quiet time after the last clip before listening again, so the end of our
// own speech (or its echo on the phone) is never picked up as the owner.
const LISTEN_AFTER_SPEECH_MS = 800;

/**
 * Voice connection to one channel. Listens only to the owner and emits
 * 'utterance' with the transcribed text. speak() reads text aloud.
 * Speech is strict: every queued answer is read to the end, in order, and
 * nothing (the owner's voice, a new answer, a "stop") cuts it off. While
 * anything is queued or playing the bot does not listen; listening resumes
 * only after the whole queue has finished.
 */
export class VoiceLink extends EventEmitter {
  constructor(channel) {
    super();
    this.channel = channel;
    this.connection = null;
    this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    this.player.on('error', (err) => console.error('[voice] player error:', err.message));
    this.recording = false;
    this.speechChain = Promise.resolve();
    this.pendingSpeech = 0; // queued or playing answers
    this.speechEndedAt = 0;
    this.closed = false;
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
      if (userId === config.ownerUserId) this.#listen();
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

  /** True while an answer is queued or being read aloud (plus a short tail). */
  get speaking() {
    if (this.pendingSpeech > 0) return true;
    if (this.player.state.status !== AudioPlayerStatus.Idle) return true;
    return Date.now() - this.speechEndedAt < LISTEN_AFTER_SPEECH_MS;
  }

  /**
   * Queue text to be spoken. Long text is split into sentences; the next
   * piece is synthesized while the current one plays. Resolves when done.
   */
  speak(text) {
    const pieces = splitForSpeech(toSpeakable(text));
    if (!pieces.length || this.closed) return Promise.resolve();
    this.pendingSpeech += 1;
    this.speechChain = this.speechChain
      .then(async () => {
        let next = this.#synth(pieces[0]);
        for (let i = 0; i < pieces.length; i++) {
          const audio = await next;
          next = i + 1 < pieces.length ? this.#synth(pieces[i + 1]) : null;
          if (this.closed || !this.connection) return;
          if (audio?.length) await this.#play(audio);
        }
      })
      .catch((err) => console.error('[voice] TTS error:', err.message))
      .finally(() => {
        this.pendingSpeech = Math.max(0, this.pendingSpeech - 1);
        this.speechEndedAt = Date.now();
      });
    return this.speechChain;
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

  #listen() {
    if (this.recording || !this.connection) return;
    // Don't listen while speaking: the whole answer is read first.
    if (this.closed || this.speaking) return;
    this.recording = true;

    const opus = this.connection.receiver.subscribe(config.ownerUserId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: config.silenceMs },
    });
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    const chunks = [];
    let bytes = 0;
    const maxBytes = MAX_UTTERANCE_S * 48000 * 2 * 2;

    const finish = () => {
      if (!this.recording) return;
      this.recording = false;
      const pcm = Buffer.concat(chunks);
      this.#handleAudio(pcm).catch((err) => {
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

  async #handleAudio(pcm) {
    if (pcmDurationSeconds(pcm) < MIN_UTTERANCE_S) return;
    const mono = toMono16k(pcm);
    if (rms(mono) < MIN_LOUDNESS) return;
    const text = await transcribe(mono);
    if (text) this.emit('utterance', text);
  }
}
