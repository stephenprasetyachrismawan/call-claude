# call-claude

Telepon Claude dari HP lewat voice channel Discord, lalu suruh Claude mengerjakan sesuatu di laptop Windows kamu.

```
HP (Discord)  ──suara──▶  Bot di laptop  ──▶  Whisper lokal di laptop (speech-to-text)
                                   │
                                   ▼
                     Claude Agent SDK (mesin Claude Code,
                     pakai langganan Claude Pro/Max kamu)
                                   │  baca file, jalankan PowerShell, dll.
                                   ▼
HP (Discord)  ◀──suara──  Edge TTS (text-to-speech, suara Indonesia)
```

- Bot otomatis masuk ke voice channel saat kamu masuk, dan keluar saat kamu keluar.
- **Akses penuh hanya untukmu** (`OWNER_USER_ID`). Teman yang ikut masuk voice channel yang sama juga bisa ngobrol (lewat suara atau ketik di chat), tapi hanya dijawab Gemini dan tidak pernah diteruskan ke Claude. Kalau Gemini tidak tersedia, mereka dijawab sesi Claude tamu yang tidak punya tool sama sekali (tidak bisa membuka file, menjalankan perintah, mengakses laptop/server, MCP, atau mengirim pesan). Perintah khusus (stop, reset, ganti model, pindah ke server, jawaban izin, tombol) hanya berlaku untukmu. Jawaban untuk tamu diawali "Untuk <nama>". Pemakaian tamu tetap memakai langgananmu. Bot ikut masuk dan keluar mengikuti kamu, bukan tamu.
- Transkrip, jawaban lengkap, dan tool yang dipakai Claude juga dikirim sebagai teks ke channel chat. Kamu juga bisa mengetik perintah di sana kalau sedang tidak bisa bicara.
- Secara default (`PERMISSION_MODE=bypass`) Claude menjalankan **semua** perintah di folder mana pun tanpa bertanya. Kalau mau aksi berisiko diizinkan dulu (lewat suara "ya"/"tidak" atau tombol di chat), isi `PERMISSION_MODE=confirm`.
- Claude memakai setup Claude Code kamu: skill, plugin, MCP server, `CLAUDE.md`, dan pengaturan di `~/.claude`.
- Claude bisa menghubungi sesi Claude kamu yang lain (sesi lain di laptop, atau komputer/server yang menjalankan `claude rc`) lewat tool `ListAgents` dan `SendMessage`.
- **Kamu bicara dengan Gemini, Claude bekerja di belakang:**
  1. **Gemini** (lewat Gemini CLI, langgananmu) mendengar suaramu langsung, menjawab duluan, dan meneruskan permintaan pekerjaan ke Claude.
  2. **Claude sesi utama** (Sonnet, orkestrator) menerima permintaan dari Gemini, menjawab sendiri atau membuka **sesi topik** di bawahnya yang jalan paralel.
  3. Hasil sesi topik dilaporkan ke sesi utama, dirangkum, lalu dikirim ke Gemini yang menyampaikannya ke kamu.
  Urutan suara: balasan Gemini untuk ucapanmu selalu duluan (menyela di antara kalimat), kabar dari Claude menunggu sampai tidak ada yang bicara. Teks lengkap jawaban Claude tetap ada di chat. Ucapkan "status" untuk mendengar topik yang masih dikerjakan. Kalau Gemini tidak tersedia, bot kembali ke Whisper dan meneruskan ucapanmu langsung ke Claude.
- **Kontrol desktop yang dicek:** Claude membuka aplikasi lewat `scripts/open-app.ps1` (menunggu jendela muncul dan membawanya ke depan), lalu memastikan lewat screenshot (`scripts/screenshot.ps1`). Kalau belum tampil, Claude mengklik ikonnya di taskbar (`scripts/click.ps1`).
- Saat bot sedang bicara, suaramu tidak dijadikan perintah, jadi jawabannya dibacakan sampai selesai. Satu-satunya pengecualian: bilang **"hey Gemini"** atau **"hey Claude"**. Bot langsung berhenti bicara (antrean bacaan dibuang, teksnya tetap ada di chat) dan mendengarkanmu. Kalimat setelah "hey Claude" langsung dianggap perintah, misalnya "hey Claude, berhenti dulu".
- **Tutup panggilan = semua berhenti:** semua sesi Claude yang dibuat bot ditandai `ClaudeCall · <topik>`. Saat kamu keluar dari voice channel (setelah jeda 15 detik), bot mematikan semua sesi itu beserta proses latar belakangnya. Sesi Claude lain milikmu (misalnya di server) tidak disentuh.
- **Skill `claude-call`** ([`plugin/skills/claude-call/SKILL.md`](plugin/skills/claude-call/SKILL.md)) dimuat di setiap sesi bot: gaya jawaban lisan, kerja kode diserahkan sepenuhnya tanpa izin, dan aksi seperti mengirim pesan, email, posting, atau mematikan laptop wajib kamu izinkan dulu. Izin ini ditegakkan oleh hook di bot (bukan hanya instruksi), juga di mode `bypass`: bot membacakan apa yang akan dikirim, lalu kamu jawab "ya" atau "tidak".
- **Pilih model:** saat panggilan mulai, bot mengirim tombol Sonnet / Opus / Haiku ke chat (default Sonnet). Bisa juga lewat suara: "pakai Opus", "ganti ke Sonnet", "model Haiku". Model berlaku untuk semua topik, termasuk yang sedang berjalan.
- **Bicara sendiri dari semua sesi:** selama panggilan, setiap kali sesi Claude mana pun selesai menjawab, bot langsung membacakannya tanpa menunggu kamu bicara: topik paralel bot, sesi Claude Code lain di laptop ("Dari sesi ..."), dan semua sesi Claude di server (`SERVER_SSH`).

## Yang perlu disiapkan

1. **Node.js 20+** dan **Git for Windows** (Claude Code di Windows memerlukan Git Bash).
2. **Login Claude Code dengan akun langgananmu.** Kalau Claude Code belum terinstal, buka PowerShell lalu jalankan:
   ```powershell
   irm https://claude.ai/install.ps1 | iex
   claude
   ```
   Di dalam Claude Code, ketik `/login` dan pilih akun Claude (Pro/Max). Bot memakai login ini.
   Alternatifnya, jalankan `claude setup-token` lalu isi hasilnya ke `CLAUDE_CODE_OAUTH_TOKEN` di `.env`.
3. **Bot Discord**
   1. Buka https://discord.com/developers/applications, klik **New Application**.
   2. Di menu **Bot**: klik **Reset Token** dan salin token itu ke `DISCORD_TOKEN`. Aktifkan **Message Content Intent**. Matikan **Public Bot**.
   3. Undang bot ke server pribadimu. Ganti `APP_ID` dengan Application ID (ada di menu General Information):
      ```
      https://discord.com/oauth2/authorize?client_id=APP_ID&scope=bot&permissions=36768768
      ```
      (izin: View Channels, Send Messages, Read Message History, Connect, Speak, Use Voice Activity)
   4. Di aplikasi Discord, aktifkan **Settings → Advanced → Developer Mode**. Klik kanan server lalu pilih **Copy Server ID** untuk `GUILD_ID`. Klik kanan namamu lalu pilih **Copy User ID** untuk `OWNER_USER_ID`.

## Instalasi

```powershell
git clone https://github.com/stephenprasetyachrismawan/call-claude
cd call-claude
npm install
copy .env.example .env
notepad .env      # isi semua variabel yang wajib
npm start
```

Kalau berhasil, akan muncul `[bot] Login sebagai ...` dan `[stt] Model siap ...`.

**Gemini** (teman bicaramu) dijalankan lewat **Antigravity CLI (`agy`)** yang login dengan akun Google-mu, tanpa API key. Gemini CLI lama sudah tidak melayani akun pribadi. Instal dan login sekali:
```powershell
winget install Google.AntigravityCLI
agy -p "halo"   # browser terbuka: pilih akunmu dan izinkan
```
Bot menjalankan satu proses `agy acp` yang tetap hidup (model cepat `gemini-3.8-flash-low`, sekitar 3 detik per balasan). agy belum bisa menerima audio, jadi ucapanmu ditulis dulu oleh **Whisper lokal** (model sekitar 250 MB diunduh sekali ke `models/`), lalu teksnya dijawab Gemini. Kalau agy gagal, bot meneruskan ucapanmu langsung ke Claude. Isi `STT_PROVIDER=whisper` untuk mematikan Gemini.

**Text-to-speech** memakai Edge TTS (gratis, tanpa key). agy hanya membalas teks, jadi tidak dipakai untuk suara keluar.

## Cara pakai dari HP

1. Buka Discord di HP, lalu masuk ke voice channel di server pribadimu. Bot akan ikut masuk dan bilang "Halo, Claude siap".
2. Bicara biasa, misalnya: *"Cek sisa ruang disk C"*, *"Buka folder Downloads, file apa yang paling besar?"*, *"Buat file catatan belanja di folder kerja"*.
3. Berhenti sekitar 1 detik, maka bot menganggap kalimatmu selesai. Bot akan menjawab "Sebentar", lalu membacakan hasilnya.

Perintah suara khusus:

| Ucapkan | Hasil |
|---|---|
| "hey Gemini" / "hey Claude" (saat bot bicara) | Memotong bacaan, lalu bot mendengarkan |
| "stop" / "berhenti" | Menghentikan semua pekerjaan Claude yang sedang berjalan (bacaan tetap diselesaikan) |
| "pakai Opus" / "pakai Sonnet" / "pakai Haiku" | Ganti model Claude |
| "status" / "lagi ngerjain apa" | Menyebutkan topik yang masih dikerjakan |
| "sambungkan ke server" / "kembali ke laptop" | Pindah antara Claude di server (lihat `SERVER_SSH`) dan Claude di laptop |
| "mulai dari awal" / "reset" | Memulai percakapan baru (Claude lupa konteks sebelumnya) |
| "ya" / "boleh" / "oke" | Mengizinkan aksi berisiko (hanya di mode `confirm`) |
| "tidak" / "jangan" / "batal" | Menolak aksi berisiko (hanya di mode `confirm`) |

Tips: di Discord HP, gunakan mode **Voice Activity** (bukan Push to Talk) dan aktifkan **Noise Suppression** supaya suara lebih jelas.

## Aturan keamanan

**Mode `bypass` (default):** tidak ada pengecekan per perintah. Pengamannya adalah bot hanya melayani user ID-mu, dan Claude diminta mengulang dulu perintah yang tidak bisa dibatalkan kalau terdengar janggal. Karena speech-to-text bisa salah dengar, perintah yang salah dengar bisa langsung dijalankan.

**Mode `confirm`:** pengecekan ada di [`src/safety.js`](src/safety.js) dan diuji di [`test/safety.test.js`](test/safety.test.js).

- **Tanpa izin:** membaca file, mencari, web search, perintah shell yang hanya membaca (mis. `dir`, `Get-Process`, `git status`), dan menulis atau mengedit file **di dalam** `WORKSPACE_DIR`.
- **Wajib izin:** menghapus, memindahkan, atau menimpa file; menulis file di luar `WORKSPACE_DIR`; shutdown/restart; mengubah registry, layanan, atau konfigurasi sistem; menghentikan program; menginstal atau menghapus software dan paket; `git push` / `reset --hard`; menjalankan skrip dari internet; menjalankan sebagai administrator; mengirim data keluar (POST, scp, email); dan semua tool lain yang tidak dikenal.
- Aturan `allow` di pengaturan Claude Code milikmu (`~/.claude/settings.json`) tetap berlaku dan bisa melewati pengecekan ini.
- Bot selalu menghapus `ANTHROPIC_API_KEY` dari environment Claude, jadi yang terpakai selalu langgananmu.
- Token disimpan di `.env`, yang sudah ada di `.gitignore`. Jangan pernah commit file itu.

Daftar ini adalah pengaman, bukan jaminan. Speech-to-text bisa salah dengar, jadi selalu dengarkan baik-baik perintah yang dibacakan sebelum menjawab "ya".

## Catatan langganan

Pemakaian lewat bot ini mengambil jatah langganan Claude yang sama dengan Claude Code dan claude.ai. Kalau limit habis, bot akan memberi tahu dan berhenti sampai limit reset. Kredit API bulanan tidak terpakai karena bot ini tidak memakai API key. Lihat [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).

## Menjalankan terus di latar belakang

- Atur Windows supaya **tidak sleep** saat dicolok listrik (Settings → System → Power).
- Agar bot otomatis jalan saat laptop menyala, pakai pm2:
  ```powershell
  npm i -g pm2 pm2-windows-startup
  pm2 start src/index.js --name call-claude
  pm2 save
  pm2-startup install
  ```

## Konfigurasi opsional (`.env`)

| Variabel | Default | Keterangan |
|---|---|---|
| `PERMISSION_MODE` | `bypass` | `bypass` = tanpa konfirmasi, `confirm` = aksi berisiko diizinkan dulu |
| `REMOTE_CONTROL` | `true` | Nyalakan Remote Control untuk sesi bot, supaya bisa mengirim pesan ke sesi Claude lain |
| `CLAUDE_MODEL` | `claude-sonnet-5-5` | Model awal untuk worker (bisa diganti saat panggilan) |
| `ORCHESTRATOR_MODEL` | `claude-sonnet-5-5` | Model sesi utama Claude yang menerima permintaan dari Gemini dan membuka sesi topik |
| `MAX_TOPICS` | `4` | Jumlah maksimal topik yang dikerjakan paralel |
| `WORKSPACE_DIR` | `~/claude-workspace` | Folder kerja Claude |
| `TEXT_CHANNEL_ID` | chat di voice channel | Channel untuk transkrip dan tombol izin |
| `STT_PROVIDER` | `gemini` | `gemini` = Gemini (agy) sebagai teman bicara, `whisper` = tanpa Gemini, langsung ke Claude |
| `GEMINI_CLI` | `agy` | Perintah atau path Antigravity CLI (atau Gemini CLI lama) |
| `GEMINI_MODEL` | `gemini-3.8-flash-low` | Model Gemini untuk teman bicara (lihat `agy models`) |
| `STT_LANGUAGE` | `id` | Bahasa yang kamu ucapkan |
| `STT_MODEL` | `onnx-community/whisper-small` | Model Whisper lokal. `onnx-community/whisper-large-v3-turbo` lebih akurat tapi lebih lambat dan unduhannya sekitar 1 GB |
| `TTS_VOICE` | `id-ID-GadisNeural` | Suara pembaca (pria: `id-ID-ArdiNeural`) |
| `TTS_RATE` | `+10%` | Kecepatan bicara |
| `SILENCE_MS` | `1000` | Lama diam (ms) yang dianggap akhir kalimat |
| `CONFIRM_TIMEOUT_S` | `60` | Batas waktu menjawab permintaan izin |

## Troubleshooting

- **Bot masuk tapi tidak merespons:** pastikan `OWNER_USER_ID` benar, lalu cek log di terminal. Jalankan `$env:DEBUG_VOICE=1; npm start` di PowerShell untuk melihat library audio yang terdeteksi.
- **"Claude belum login":** jalankan `claude` di PowerShell lalu `/login`.
- **Pesan ketikan tidak dibalas:** aktifkan Message Content Intent di Developer Portal, dan ketik di channel yang sama dengan tempat bot mengirim transkrip.
- **Suara terpotong-potong:** naikkan `SILENCE_MS` menjadi `1500`.

## Pengembangan

```powershell
npm test
```
