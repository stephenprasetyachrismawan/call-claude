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
- Bot **hanya** mendengar dan menjawab user ID Discord kamu (`OWNER_USER_ID`). Orang lain di channel diabaikan, dan tombol izin hanya bisa ditekan olehmu.
- Transkrip, jawaban lengkap, dan tool yang dipakai Claude juga dikirim sebagai teks ke channel chat. Kamu juga bisa mengetik perintah di sana kalau sedang tidak bisa bicara.
- Secara default (`PERMISSION_MODE=bypass`) Claude menjalankan **semua** perintah di folder mana pun tanpa bertanya. Kalau mau aksi berisiko diizinkan dulu (lewat suara "ya"/"tidak" atau tombol di chat), isi `PERMISSION_MODE=confirm`.
- Claude memakai setup Claude Code kamu: skill, plugin, MCP server, `CLAUDE.md`, dan pengaturan di `~/.claude`.
- Claude bisa menghubungi sesi Claude kamu yang lain (sesi lain di laptop, atau komputer/server yang menjalankan `claude rc`) lewat tool `ListAgents` dan `SendMessage`.
- Saat bot sedang bicara, bot tidak mendengarkan, jadi jawabannya tidak terpotong oleh suaramu. Bot mendengarkan lagi setelah selesai bicara.

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

Speech-to-text berjalan **di laptop sendiri** (Whisper lewat transformers.js), jadi tidak perlu API key dan suaramu tidak dikirim ke layanan lain. Saat pertama kali dijalankan, model Whisper (sekitar 250 MB untuk `whisper-small`) diunduh sekali ke folder `models/`.

## Cara pakai dari HP

1. Buka Discord di HP, lalu masuk ke voice channel di server pribadimu. Bot akan ikut masuk dan bilang "Halo, Claude siap".
2. Bicara biasa, misalnya: *"Cek sisa ruang disk C"*, *"Buka folder Downloads, file apa yang paling besar?"*, *"Buat file catatan belanja di folder kerja"*.
3. Berhenti sekitar 1 detik, maka bot menganggap kalimatmu selesai. Bot akan menjawab "Sebentar", lalu membacakan hasilnya.

Perintah suara khusus:

| Ucapkan | Hasil |
|---|---|
| "stop" / "berhenti" | Menghentikan pekerjaan Claude yang sedang berjalan |
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
| `CLAUDE_MODEL` | `claude-opus-5-5` | Model Claude |
| `WORKSPACE_DIR` | `~/claude-workspace` | Folder kerja Claude |
| `TEXT_CHANNEL_ID` | chat di voice channel | Channel untuk transkrip dan tombol izin |
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
