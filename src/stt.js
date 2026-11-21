import Groq, { toFile } from 'groq-sdk';
import { config } from './config.js';

const groq = new Groq({ apiKey: config.groqApiKey });

// Whisper sometimes hallucinates these on near-silent clips.
const HALLUCINATIONS = [
  /^terima kasih( telah menonton| sudah menonton)?[.!]*$/i,
  /^thank you( for watching)?[.!]*$/i,
  /^(sampai jumpa|bye)[.!]*$/i,
  /^\W*$/,
];

/** Transcribe a WAV buffer. Returns '' when nothing useful was said. */
export async function transcribe(wav) {
  const file = await toFile(wav, 'speech.wav', { type: 'audio/wav' });
  const res = await groq.audio.transcriptions.create({
    file,
    model: config.sttModel,
    language: config.sttLanguage,
    temperature: 0,
    response_format: 'json',
  });
  const text = (res.text ?? '').trim();
  if (HALLUCINATIONS.some((re) => re.test(text))) return '';
  return text;
}
