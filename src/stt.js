// Local speech-to-text: Whisper running on the laptop's CPU via transformers.js.
// No API key and no audio leaves the machine. The model is downloaded once
// from Hugging Face on first start and cached in ./models.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, pipeline } from '@huggingface/transformers';
import { config } from './config.js';

env.cacheDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'models');

// Whisper sometimes hallucinates these on near-silent clips.
const HALLUCINATIONS = [
  /^terima kasih( telah menonton| sudah menonton| atas perhatiannya)?[.!]*$/i,
  /^thank you( for watching)?[.!]*$/i,
  /^(sampai jumpa|bye)[.!]*$/i,
  /^(subtitle|subtitles|teks) (oleh|by)\b/i,
  /^\W*$/,
];

let asrPromise = null;

/** Load the Whisper model. Call at startup so the first utterance is fast. */
export function initStt() {
  if (!asrPromise) {
    console.log(`[stt] Memuat model ${config.sttModel} (${config.sttDtype})... unduhan pertama bisa beberapa menit.`);
    const started = Date.now();
    asrPromise = pipeline('automatic-speech-recognition', config.sttModel, { dtype: config.sttDtype })
      .then((asr) => {
        console.log(`[stt] Model siap dalam ${((Date.now() - started) / 1000).toFixed(1)} detik.`);
        return asr;
      })
      .catch((err) => {
        asrPromise = null;
        throw err;
      });
  }
  return asrPromise;
}

/** Convert mono 16 kHz s16le PCM to the Float32 samples Whisper expects. */
export function int16ToFloat32(mono) {
  const n = mono.length / 2;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = mono.readInt16LE(i * 2) / 32768;
  return out;
}

/** Transcribe mono 16 kHz s16le PCM. Returns '' when nothing useful was said. */
export async function transcribe(mono16k) {
  const asr = await initStt();
  const result = await asr(int16ToFloat32(mono16k), {
    language: config.sttLanguage,
    task: 'transcribe',
  });
  const text = String(result?.text ?? '').trim();
  if (HALLUCINATIONS.some((re) => re.test(text))) return '';
  return text;
}
