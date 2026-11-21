// Helpers to turn Discord's decoded PCM (48 kHz, stereo, s16le) into a small
// mono 16 kHz WAV that Whisper accepts.

export const DISCORD_RATE = 48000;
export const DISCORD_CHANNELS = 2;
const TARGET_RATE = 16000;

/** Duration in seconds of a 48 kHz stereo s16le buffer. */
export function pcmDurationSeconds(pcm) {
  return pcm.length / (DISCORD_RATE * DISCORD_CHANNELS * 2);
}

/**
 * Downmix stereo to mono and decimate 48k -> 16k (factor 3, averaging each
 * group of 3 frames as a crude low-pass filter). Good enough for speech.
 */
export function toMono16k(pcm) {
  const frameBytes = DISCORD_CHANNELS * 2;
  const frames = Math.floor(pcm.length / frameBytes);
  const factor = DISCORD_RATE / TARGET_RATE;
  const outFrames = Math.floor(frames / factor);
  const out = Buffer.alloc(outFrames * 2);
  for (let i = 0; i < outFrames; i++) {
    let sum = 0;
    for (let j = 0; j < factor; j++) {
      const off = (i * factor + j) * frameBytes;
      sum += pcm.readInt16LE(off) + pcm.readInt16LE(off + 2);
    }
    const sample = Math.round(sum / (factor * DISCORD_CHANNELS));
    out.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2);
  }
  return out;
}

/** Root-mean-square loudness of mono s16le PCM, 0..1. */
export function rms(mono) {
  const n = mono.length / 2;
  if (n === 0) return 0;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const s = mono.readInt16LE(i * 2) / 32768;
    acc += s * s;
  }
  return Math.sqrt(acc / n);
}

/** Wrap mono s16le PCM in a WAV header. */
export function wavFromPcm(mono, sampleRate = TARGET_RATE) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + mono.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(1, 22); // channels
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(mono.length, 40);
  return Buffer.concat([header, mono]);
}
