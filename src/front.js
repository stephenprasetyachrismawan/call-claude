// Gemini as the voice the owner talks to. Each utterance goes to Gemini as
// audio; Gemini writes down what was said, answers right away, and decides
// whether the request should go to Claude. Messages from Claude come back
// through Gemini, which says them in its own words. One Gemini session holds
// the whole conversation, so it can answer "what did Claude say?".
import { monoToWav } from './audio.js';
import { gemini } from './stt.js';

const RULES = `
Kamu adalah Gemini, teman bicara di telepon Discord. Di belakangmu ada Claude: asisten yang bisa mengerjakan apa saja di laptop dan server milik pemilik (file, aplikasi, kode, pesan, internet).
Aturan:
- Jangan memakai tool apa pun. Cukup balas teks JSON.
- "say" dibacakan dengan suara: Bahasa Indonesia santai, 1 sampai 2 kalimat, tanpa markdown, emoji, atau daftar.
- Pemilik: kalau ucapannya meminta pekerjaan, aksi, atau informasi yang harus dicari atau dikerjakan (laptop, file, aplikasi, server, kode, pesan, berita terbaru), atau menjawab pertanyaan dari Claude, isi "forward" dengan permintaannya secara lengkap dan jelas (perbaiki salah dengar yang jelas), dan isi "say" dengan konfirmasi singkat, misalnya "Oke, aku sampaikan ke Claude." Kalau cuma ngobrol atau pertanyaan umum ringan, jawab sendiri di "say" dan "forward" null.
- Tamu (bukan pemilik): "forward" selalu null. Jawab sendiri. Kalau tamu minta aksi di laptop, bilang hanya pemilik yang bisa.
- Kalau ucapannya perintah singkat untuk bot ("stop", "status", "reset", "mulai dari awal", "pakai opus/sonnet/haiku", "sambungkan ke server", "kembali ke laptop", atau jawaban "ya/tidak"/"boleh/jangan"), isi "heard" saja, "say" kosong, "forward" null.
`.trim();

function parseJson(text) {
  const match = String(text ?? '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

/** True when Gemini (the voice front-end) is configured. */
export const frontEnabled = Boolean(gemini);

/**
 * Gemini hears an utterance (audio or typed text) and replies.
 * @param {{ mono?: Buffer, text?: string, name: string, isOwner: boolean }} input
 * @returns {Promise<{ heard: string, say: string, forward: string | null }>}
 */
export async function converse({ mono, text, name, isOwner }) {
  const who = `${name} (${isOwner ? 'pemilik' : 'tamu'})`;
  const parts = [
    {
      type: 'text',
      text: `${RULES}\n\nPembicara: ${who}.\n${
        mono ? 'Dengarkan audio terlampir.' : `Pesan yang diketik: ${text}`
      }\nBalas HANYA satu baris JSON: {"heard": "transkrip kata demi kata", "say": "balasanmu", "forward": "permintaan untuk Claude" atau null}\nKalau tidak ada ucapan yang jelas: {"heard": "", "say": "", "forward": null}`,
    },
  ];
  if (mono) parts.push({ type: 'audio', mimeType: 'audio/wav', data: monoToWav(mono).toString('base64') });
  const raw = await gemini.ask(parts, { priority: 0 });
  const data = parseJson(raw);
  if (!data) {
    // Not JSON: treat the whole reply as something to say.
    return { heard: text ?? '', say: raw, forward: null };
  }
  return {
    heard: String(data.heard ?? text ?? '').trim(),
    say: String(data.say ?? '').trim(),
    forward: isOwner && data.forward ? String(data.forward).trim() : null,
  };
}

/**
 * Gemini passes on a message from Claude (or another session) to the owner.
 * @returns {Promise<string>} what to say
 */
export async function relay(source, message) {
  const raw = await gemini.ask(
    [
      {
        type: 'text',
        text: `${RULES}\n\n[Pesan dari ${source} untuk pemilik]: ${message}\n\nSampaikan ke pemilik dengan gaya bicaramu, singkat, dan setia pada isinya: jangan menambah atau menghilangkan fakta, angka, nama, atau pertanyaan. Balas HANYA JSON: {"say": "..."}`,
      },
    ],
    { priority: 1 },
  );
  const data = parseJson(raw);
  return String(data?.say ?? raw ?? '').trim() || message;
}
