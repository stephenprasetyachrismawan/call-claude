// Helpers to turn Discord's decoded PCM (48 kHz, stereo, s16le) into the
// mono 16 kHz audio Whisper expects.

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
