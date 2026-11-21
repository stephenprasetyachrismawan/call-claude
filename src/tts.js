import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { config } from './config.js';

const MAX_SPOKEN_CHARS = 700;

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
  if (t.length > MAX_SPOKEN_CHARS) {
    const cut = t.lastIndexOf('. ', MAX_SPOKEN_CHARS);
    t = t.slice(0, cut > 200 ? cut + 1 : MAX_SPOKEN_CHARS) + ' Selengkapnya ada di chat.';
  }
  return t;
}

/** Synthesize speech; resolves to a readable MP3 stream. */
export async function synthesize(text) {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(config.ttsVoice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  const { audioStream } = tts.toStream(text, { rate: config.ttsRate });
  audioStream.once('close', () => tts.close());
  audioStream.once('end', () => tts.close());
  return audioStream;
}
