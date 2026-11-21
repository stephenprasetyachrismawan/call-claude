// Gemini as the voice the owner talks to. Each utterance goes to Gemini as
// audio; Gemini writes down what was said, answers right away, and decides
// whether the request should go to Claude. Messages from Claude come back
// through Gemini, which says them in its own words. One Gemini session holds
// the whole conversation, so it can answer "what did Claude say?".
import { monoToWav } from './audio.js';
import { gemini } from './stt.js';

const RULES = `
Kamu adalah Gemini, teman ngobrol pemilik di telepon Discord, seperti asisten suara di HP. Di belakangmu ada Claude: asisten yang bisa mengerjakan apa saja di laptop dan server milik pemilik (file, aplikasi, kode, pesan, internet).
Gaya bicara:
- Ngobrol seperti teman akrab: Bahasa Indonesia santai sehari-hari (boleh "aku/kamu", "oke", "sip", "bentar ya", campur Inggris kalau pemilik juga begitu). Ikuti nada dan gaya bahasa lawan bicara.
- Pahami maksud, bukan kata per kata. Ucapan bisa tidak baku, terpotong, salah dengar, campur bahasa, atau berbelit: tangkap maksudnya, perbaiki salah dengar yang jelas. Kalau benar-benar tidak jelas, tanya balik dengan santai.
- Jangan kaku atau seperti robot. Jangan mengulang kalimat yang sama setiap kali (variasikan konfirmasi, misalnya "Siap, aku terusin ke Claude", "Oke, Claude yang urus ya", "Bentar, aku minta Claude cek"). Boleh menanggapi sedikit isinya.
- "say" dibacakan dengan suara: pendek, 1 sampai 2 kalimat, tanpa markdown, emoji, atau daftar.
Aturan:
- Jangan memakai tool apa pun. Cukup balas teks JSON.
- Pemilik: kalau ucapannya meminta pekerjaan, aksi, atau informasi yang harus dicari atau dikerjakan (laptop, file, aplikasi, server, kode, pesan, berita terbaru), menanyakan perkembangan pekerjaan Claude secara detail, atau menjawab pertanyaan dari Claude, isi "forward" dengan permintaannya secara lengkap dan jelas dalam kalimat utuh, dan isi "say" dengan tanggapan singkat yang wajar. Kalau cuma ngobrol, bercanda, atau pertanyaan umum ringan, jawab sendiri di "say" dan "forward" null.
- Tamu (bukan pemilik): "forward" selalu null. Jawab sendiri dengan ramah. Kalau tamu minta aksi di laptop, bilang hanya pemilik yang bisa.
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
  await gemini.start();
  if (mono && !gemini.canHear) throw new Error('Gemini tidak bisa menerima audio');
  const who = `${name} (${isOwner ? 'pemilik' : 'tamu'})`;
  const parts = [
    {
      type: 'text',
      text: `${RULES}\n\nPembicara: ${who}.\n${
        mono ? 'Dengarkan audio terlampir.' : `Pesan yang diketik: ${text}`
      }\nBalas HANYA satu baris JSON: {"heard": "transkrip kata demi kata", "say": "balasanmu", "forward": "permintaan untuk Claude" atau null}\nKalau tidak ada ucapan yang jelas: {"heard": "", "say": "", "forward": null}`,
    },
  ];
  if (mono) parts.push(gemini.audioPart(monoToWav(mono)));
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

/**
 * The line has been quiet while Claude works: Gemini gives a short update so
 * the owner, who is watching, knows what is going on.
 * @param {string} status plain description of the running work
 * @param {string} previous the last update that was spoken (avoid repeating it)
 * @returns {Promise<string>} what to say ('' to stay quiet)
 */
export async function progress(status, previous) {
  const raw = await gemini.ask(
    [
      {
        type: 'text',
        text: `${RULES}\n\n[Status pekerjaan Claude saat ini, untuk update singkat karena suasana sedang hening]:\n${status}\n${
          previous ? `Update terakhir yang sudah kamu ucapkan: "${previous}". Jangan mengulanginya; sebut yang baru saja.\n` : ''
        }Beri pemilik update santai satu kalimat pendek tentang apa yang sedang dikerjakan Claude, seperti teman yang mengabari. Jangan mengarang hasil yang belum ada. Kalau tidak ada yang baru untuk disampaikan, kosongkan. Balas HANYA JSON: {"say": "..."}`,
      },
    ],
    { priority: 2 },
  );
  const data = parseJson(raw);
  return String(data?.say ?? '').trim();
}
