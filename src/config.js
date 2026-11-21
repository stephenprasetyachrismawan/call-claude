import 'dotenv/config';
import os from 'node:os';
import path from 'node:path';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`[config] Variabel ${name} wajib diisi di file .env (lihat .env.example).`);
    process.exit(1);
  }
  return value;
}

function optional(name, fallback) {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

function int(name, fallback) {
  const n = Number.parseInt(optional(name, ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  discordToken: required('DISCORD_TOKEN'),
  ownerUserId: required('OWNER_USER_ID'),
  guildId: required('GUILD_ID'),
  groqApiKey: required('GROQ_API_KEY'),

  textChannelId: optional('TEXT_CHANNEL_ID', ''),

  claudeModel: optional('CLAUDE_MODEL', 'claude-opus-5-5'),
  workspaceDir: path.resolve(optional('WORKSPACE_DIR', path.join(os.homedir(), 'claude-workspace'))),
  claudeOAuthToken: optional('CLAUDE_CODE_OAUTH_TOKEN', ''),

  sttLanguage: optional('STT_LANGUAGE', 'id'),
  sttModel: optional('STT_MODEL', 'whisper-large-v3-turbo'),
  ttsVoice: optional('TTS_VOICE', 'id-ID-GadisNeural'),
  ttsRate: optional('TTS_RATE', '+10%'),

  silenceMs: int('SILENCE_MS', 1000),
  confirmTimeoutS: int('CONFIRM_TIMEOUT_S', 60),
};
