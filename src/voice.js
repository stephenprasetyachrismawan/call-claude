import { EventEmitter } from 'node:events';
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
import { synthesize, toSpeakable } from './tts.js';

const MIN_UTTERANCE_S = 0.4;
const MAX_UTTERANCE_S = 60;
const MIN_LOUDNESS = 0.004;

/**
 * Voice connection to one channel. Listens only to the owner and emits
 * 'utterance' with the transcribed text. speak() reads text aloud.
 * While the bot is speaking it does not listen, so the owner's voice never
 * cuts an answer off; listening resumes once playback has finished.
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
    this.speechGeneration = 0;
    this.pendingSpeech = 0; // queued or playing TTS clips
    this.speechEndedAt = 0;

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
    this.stopSpeaking();
    try {
      this.connection?.destroy();
    } catch {
      // already destroyed
    }
    this.connection = null;
  }

  /** True while an answer is queued or being read aloud. */
  get speaking() {
    if (this.pendingSpeech > 0) return true;
    if (this.player.state.status !== AudioPlayerStatus.Idle) return true;
    // Short tail so the end of our own speech (or its echo) isn't picked up.
    return Date.now() - this.speechEndedAt < 400;
  }

  /** Stop current and queued speech. */
  stopSpeaking() {
    this.speechGeneration += 1;
    this.player.stop(true);
  }

  /** Queue text to be spoken. Resolves when it has finished playing. */
  speak(text) {
    const spoken = toSpeakable(text);
    if (!spoken) return Promise.resolve();
    const generation = this.speechGeneration;
    this.pendingSpeech += 1;
    this.speechChain = this.speechChain
      .then(async () => {
        if (generation !== this.speechGeneration || !this.connection) return;
        const stream = await synthesize(spoken);
        if (generation !== this.speechGeneration) {
          stream.destroy();
          return;
        }
        this.player.play(createAudioResource(stream, { inputType: StreamType.Arbitrary }));
        await entersState(this.player, AudioPlayerStatus.Playing, 10_000).catch(() => {});
        await entersState(this.player, AudioPlayerStatus.Idle, 5 * 60_000).catch(() => {});
      })
      .catch((err) => console.error('[voice] TTS error:', err.message))
      .finally(() => {
        this.pendingSpeech = Math.max(0, this.pendingSpeech - 1);
        this.speechEndedAt = Date.now();
      });
    return this.speechChain;
  }

  #listen() {
    if (this.recording || !this.connection) return;
    // Don't listen while speaking: the owner's voice must not cut the answer off.
    if (this.speaking) return;
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
