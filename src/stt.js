// Local speech-to-text: Whisper running on the laptop's CPU via transformers.js.
// No API key and no audio leaves the machine. The model is downloaded once
// from Hugging Face on first start and cached in ./models.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, pipeline } from '@huggingface/transformers';
import { config } from './config.js';
import { monoToWav } from './audio.js';
import { GeminiAcp } from './gemini-acp.js';

const gemini = config.sttProvider === 'gemini' ? new GeminiAcp() : null;
let geminiFailures = 0;
let geminiPausedUntil = 0;

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

/**
 * Transcribe mono 16 kHz s16le PCM. Returns '' when nothing useful was said.
 * Uses Gemini CLI when configured; falls back to local Whisper if Gemini
 * fails. quick=true (wake-word checks while the bot speaks) always uses
 * Whisper: it is local, fast and costs no quota.
 */
export async function transcribe(mono16k, { quick = false } = {}) {
  if (gemini && !quick && Date.now() >= geminiPausedUntil) {
    try {
      const started = Date.now();
      const text = await gemini.transcribe(monoToWav(mono16k));
      geminiFailures = 0;
      console.log(`[stt] Gemini ${((Date.now() - started) / 1000).toFixed(1)} s: ${text}`);
      return text;
    } catch (err) {
      geminiFailures += 1;
      console.error(`[stt] Gemini gagal (${err.message}), pakai Whisper.`);
      // After repeated failures (not logged in, quota), rest Gemini for a while.
      if (geminiFailures >= 3) {
        geminiPausedUntil = Date.now() + 5 * 60_000;
        geminiFailures = 0;
      }
    }
  }
  return whisper(mono16k);
}

/** Warm up Gemini CLI so the first utterance is fast (no-op for Whisper). */
export function initGemini() {
  return gemini?.start().catch((err) => console.error('[stt] Gemini CLI belum siap:', err.message));
}

/** Stop the Gemini CLI process (on shutdown). */
export function stopGemini() {
  gemini?.stop();
}

async function whisper(mono16k) {
  const asr = await initStt();
  const result = await asr(int16ToFloat32(mono16k), {
    language: config.sttLanguage,
    task: 'transcribe',
  });
  const text = String(result?.text ?? '').trim();
  if (HALLUCINATIONS.some((re) => re.test(text))) return '';
  return text;
}
