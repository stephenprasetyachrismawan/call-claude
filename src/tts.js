import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { config } from './config.js';

// Edge TTS delivers audio only about as fast as it plays, so pieces are kept
// short: the first one is ready quickly and the next ones are fetched ahead.
const MAX_CHUNK_CHARS = 180;
const SYNTH_TIMEOUT_MS = 45_000;

/** Strip markdown and other things that sound bad when read aloud. */
export function toSpeakable(text) {
  let t = text
    .replace(/```[\s\S]*?```/g, ' (kode ada di chat) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'link di chat')
    .replace(/^#+\s*/gm, '')
    .replace(/[*_~>|]/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t;
}

/**
 * Split speakable text into short pieces at sentence (or clause) boundaries,
 * so every piece is synthesized and played completely, nothing is cut off.
 */
export function splitForSpeech(text, max = MAX_CHUNK_CHARS) {
  const sentences = String(text).match(/[^.!?…]+[.!?…]*\s*/g) ?? [];
  const pieces = [];
  let cur = '';
  const push = (s) => {
    s = s.trim();
    if (s) pieces.push(s);
  };
  for (let s of sentences) {
    // A very long sentence: break at commas, then at spaces.
    while (s.length > max) {
      let cut = s.lastIndexOf(', ', max);
      if (cut < max / 3) cut = s.lastIndexOf(' ', max);
      if (cut < max / 3) cut = max;
      push(cur);
      cur = '';
      push(s.slice(0, cut + 1));
      s = s.slice(cut + 1);
    }
    if ((cur + s).length > max) {
      push(cur);
      cur = s;
    } else {
      cur += s;
    }
  }
  push(cur);
  return pieces;
}

/**
 * Synthesize speech into a complete MP3 buffer. The whole clip is downloaded
 * before playback starts, so a slow network can never end a clip early.
 */
export async function synthesize(text) {
  const tts = new MsEdgeTTS();
  try {
    await tts.setMetadata(config.ttsVoice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(text, { rate: config.ttsRate });
    return await new Promise((resolve, reject) => {
      const chunks = [];
      const timer = setTimeout(() => {
        audioStream.destroy();
        reject(new Error('TTS timeout'));
      }, SYNTH_TIMEOUT_MS);
      audioStream.on('data', (c) => chunks.push(c));
      audioStream.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      const done = () => {
        clearTimeout(timer);
        resolve(Buffer.concat(chunks));
      };
      audioStream.once('end', done);
      audioStream.once('close', done);
    });
  } finally {
    try {
      tts.close();
    } catch {
      // already closed
    }
  }
}
