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

// Older .env files used Groq model names (no "owner/" prefix). Map them to the local model.
function sttModel() {
  const fallback = 'onnx-community/whisper-small';
  const value = optional('STT_MODEL', fallback);
  if (value.includes('/')) return value;
  console.warn(`[config] STT_MODEL=${value} bukan model lokal, memakai ${fallback}.`);
  return fallback;
}

export const config = {
  discordToken: required('DISCORD_TOKEN'),
  ownerUserId: required('OWNER_USER_ID'),
  guildId: required('GUILD_ID'),

  textChannelId: optional('TEXT_CHANNEL_ID', ''),

  claudeModel: optional('CLAUDE_MODEL', 'claude-opus-5-5'),
  workspaceDir: path.resolve(optional('WORKSPACE_DIR', path.join(os.homedir(), 'claude-workspace'))),
  claudeOAuthToken: optional('CLAUDE_CODE_OAUTH_TOKEN', ''),
  // 'bypass' = Claude runs everything without asking; 'confirm' = risky actions need approval.
  permissionMode: optional('PERMISSION_MODE', 'bypass') === 'confirm' ? 'confirm' : 'bypass',
  remoteControl: optional('REMOTE_CONTROL', 'true') !== 'false',

  // Parallel topics: a fast "head" model routes each utterance to a worker session.
  maxTopics: int('MAX_TOPICS', 4),
  routerModel: optional('ROUTER_MODEL', 'claude-haiku-5-5'),

  // Optional: Claude Code session in tmux on another machine, reached over SSH.
  serverSsh: optional('SERVER_SSH', ''),
  serverTmux: optional('SERVER_TMUX', ''),
  serverName: optional('SERVER_NAME', 'server'),

  sttLanguage: optional('STT_LANGUAGE', 'id'),
  sttModel: sttModel(),
  sttDtype: optional('STT_DTYPE', 'q8'),
  ttsVoice: optional('TTS_VOICE', 'id-ID-GadisNeural'),
  ttsRate: optional('TTS_RATE', '+10%'),

  silenceMs: int('SILENCE_MS', 1000),
  confirmTimeoutS: int('CONFIRM_TIMEOUT_S', 60),
};
