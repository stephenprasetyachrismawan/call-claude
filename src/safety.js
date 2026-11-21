import path from 'node:path';

// Tools that only read or plan. They run without asking.
const READ_ONLY_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch', 'TodoWrite',
  'BashOutput', 'TaskOutput', 'ToolSearch', 'Agent', 'Task', 'ExitPlanMode',
]);

const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

// Shell patterns that need the owner's spoken or clicked approval.
// Matched case-insensitively against the whole command string, so they also
// catch commands wrapped in `powershell -Command "..."` or `cmd /c ...`.
const RISKY_SHELL_PATTERNS = [
  // Deleting or wiping data
  [/(^|[\s;&|(])(rm|rmdir|rd|del|erase|unlink|shred)(\s|$)/i, 'menghapus file atau folder'],
  [/\b(remove-item|clear-content|clear-recyclebin)\b/i, 'menghapus file atau folder'],
  [/\b(format(\.com)?\s+[a-z]:|diskpart|cipher\s+\/w|clear-disk|format-volume)\b/i, 'memformat atau menghapus disk'],
  // Moving or overwriting files
  [/(^|[\s;&|(])(mv|move|ren|rename)(\s|$)/i, 'memindahkan atau mengganti nama file'],
  [/\b(move-item|rename-item|set-content|out-file|add-content|copy-item\b.*-force)\b/i, 'menimpa atau memindahkan file'],
  [/(^|[^0-9&>])>{1,2}\s*(?!&|\/dev\/null|nul\b|\$null)\S/i, 'menulis ke file lewat redirect'],
  // Power and session
  [/\b(shutdown|restart-computer|stop-computer|logoff|suspend-computer)\b/i, 'mematikan atau me-restart laptop'],
  // System configuration
  [/\breg(\.exe)?\s+(add|delete|import|load|unload|restore)\b/i, 'mengubah registry'],
  [/\b(set-itemproperty|new-itemproperty|remove-itemproperty)\b/i, 'mengubah registry atau properti sistem'],
  [/\b(bcdedit|netsh|schtasks|takeown|icacls|attrib|setx)\b/i, 'mengubah konfigurasi sistem'],
  [/\bsc(\.exe)?\s+(delete|stop|config|create)\b/i, 'mengubah layanan Windows'],
  [/\b(stop-service|set-service|new-service|remove-service|set-executionpolicy|set-mppreference|disable-\w+|enable-\w+)\b/i, 'mengubah layanan atau keamanan sistem'],
  // Killing processes
  [/\b(taskkill|stop-process|pkill|killall)\b/i, 'menghentikan program'],
  [/(^|[\s;&|(])kill(\s|$)/i, 'menghentikan program'],
  // Installing or removing software
  [/\b(winget|choco|scoop|msiexec|apt(-get)?|brew)\s+(install|uninstall|remove|upgrade|add)\b/i, 'menginstal atau menghapus software'],
  [/\b(npm|pnpm|yarn|bun)\s+(i|install|add|uninstall|remove|rm|update|upgrade)\b/i, 'menginstal atau menghapus paket'],
  [/\b(pip3?|uv|conda)\s+(install|uninstall|remove)\b/i, 'menginstal atau menghapus paket Python'],
  [/\b(install-module|install-package|uninstall-package|add-appxpackage|remove-appxpackage)\b/i, 'menginstal atau menghapus software'],
  // Git operations that publish or destroy work
  [/\bgit\s+(push|reset\s+--hard|clean|rebase|filter-branch)\b/i, 'git push atau operasi yang bisa menghapus pekerjaan'],
  [/\bgit\s+(checkout|restore)\s+(--\s|\.)/i, 'membuang perubahan git'],
  [/\bgit\s+branch\s+-D\b/i, 'menghapus branch git'],
  // Running downloaded code or elevating privileges
  [/\b(invoke-expression|iex)\b/i, 'menjalankan kode dari teks atau internet'],
  [/\b(curl|wget|iwr|invoke-webrequest|irm|invoke-restmethod)\b[^|]*\|\s*(sh|bash|iex|powershell|pwsh|python)/i, 'menjalankan skrip dari internet'],
  [/\b(runas|start-process\b.*-verb\s+runas|sudo)\b/i, 'menjalankan sebagai administrator'],
  // Sending data out
  [/\bcurl\b.*\s(-d|--data\S*|-F|--form|-T|--upload-file|-X\s*(POST|PUT|DELETE|PATCH))\b/i, 'mengirim data ke internet'],
  [/\b(invoke-webrequest|iwr|invoke-restmethod|irm)\b.*-method\s+(post|put|delete|patch)\b/i, 'mengirim data ke internet'],
  [/\b(send-mailmessage|scp|sftp|ftp|rsync)\b/i, 'mengirim file atau data keluar'],
];

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function shorten(text, max = 160) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * Decide whether a tool call needs the owner's approval.
 * @returns {{ risky: boolean, reason?: string, summary: string }}
 */
export function assessRisk(toolName, input, workspaceDir) {
  if (READ_ONLY_TOOLS.has(toolName)) {
    return { risky: false, summary: toolName };
  }

  if (FILE_WRITE_TOOLS.has(toolName)) {
    const target = input.file_path ?? input.notebook_path ?? input.path ?? '';
    const resolved = path.resolve(workspaceDir, String(target));
    const summary = `${toolName} ${target}`;
    if (target && isInside(resolved, workspaceDir)) return { risky: false, summary };
    return { risky: true, reason: 'mengubah file di luar folder kerja', summary };
  }

  if (SHELL_TOOLS.has(toolName)) {
    const command = String(input.command ?? '');
    const summary = shorten(command);
    for (const [pattern, reason] of RISKY_SHELL_PATTERNS) {
      if (pattern.test(command)) return { risky: true, reason, summary };
    }
    return { risky: false, summary };
  }

  // Anything else (MCP tools, unknown future tools) asks first.
  return { risky: true, reason: `memakai tool ${toolName}`, summary: shorten(`${toolName} ${JSON.stringify(input)}`) };
}

const NO_WORDS = /\b(tidak|tak|nggak|ngga|gak|ga|enggak|engga|jangan|batal|batalkan|tolak|no|nope|stop|cancel)\b/i;
const YES_WORDS = /\b(ya|iya|iyah|yap|yup|boleh|oke|okay|ok|okey|lanjut|lanjutkan|gas|silakan|silahkan|setuju|izinkan|yes|betul|benar|jalankan|sip|siap)\b/i;

/** Parse a spoken yes/no answer. Negation wins over agreement. */
export function parseYesNo(text) {
  const t = String(text ?? '').toLowerCase();
  if (NO_WORDS.test(t)) return 'no';
  if (YES_WORDS.test(t)) return 'yes';
  return null;
}

const STOP_COMMAND = /^\s*(stop|berhenti|hentikan|batal|batalkan|cukup|diam|udah|sudah)\b[\s.!,]*$/i;

/** True when the utterance is only a request to stop the current work. */
export function isStopCommand(text) {
  return STOP_COMMAND.test(String(text ?? ''));
}

const RESET_COMMAND = /^\s*(reset|mulai (dari )?(awal|baru)|percakapan baru|lupakan( semua)?)\b[\s.!,]*$/i;

/** True when the owner asks to start a fresh Claude conversation. */
export function isResetCommand(text) {
  return RESET_COMMAND.test(String(text ?? ''));
}

const TO_SERVER = /\b(sambung(kan)?|hubung(kan)?|pindah|ganti|connect|switch)\b.*\b(ke|to)\b.*\bserver\b/i;
const TO_LAPTOP = /\b(kembali|balik|pindah|ganti|sambung(kan)?|back|switch)\b.*\b(ke|to)\b.*\b(laptop|lokal|local)\b/i;

/** 'server' | 'laptop' when the owner asks to switch which Claude they talk to. */
export function parseSwitchCommand(text) {
  const t = String(text ?? '');
  if (t.length > 80) return null;
  if (TO_LAPTOP.test(t)) return 'laptop';
  if (TO_SERVER.test(t)) return 'server';
  return null;
}

const STATUS_COMMAND = /^\s*(status|lagi (ngerjain|mengerjakan|kerja) apa|sedang (mengerjakan|kerja) apa|apa (saja )?yang sedang dikerjakan|progres(nya)?( gimana| bagaimana)?)\b[\s.!?,]*$/i;

/** True when the owner asks what is still being worked on. */
export function isStatusCommand(text) {
  return STATUS_COMMAND.test(String(text ?? ''));
}

/** Models the owner can pick during a call. */
export const MODELS = {
  sonnet: { id: 'claude-sonnet-5-5', name: 'Sonnet' },
  opus: { id: 'claude-opus-5-5', name: 'Opus' },
  haiku: { id: 'claude-haiku-5-5', name: 'Haiku' },
};

// Whisper often hears "Sonnet" as "sonet"/"sonit" and "Opus" as "opes"/"opos".
const MODEL_WORDS = [
  ['sonnet', /\b(son+[eia]t+|sonet|sonit)\b/i],
  ['opus', /\b(op[uoe]s|opus)\b/i],
  ['haiku', /\b(h[ae]iku|haikyu)\b/i],
];
const MODEL_VERB = /\b(pakai|pake|gunakan|ganti|ubah|pindah|switch|model)\b/i;

/** "pakai opus", "ganti ke model sonnet" -> 'opus' / 'sonnet' / 'haiku', else null. */
export function parseModelCommand(text) {
  const t = String(text ?? '');
  if (t.length > 60 || !MODEL_VERB.test(t)) return null;
  for (const [key, re] of MODEL_WORDS) if (re.test(t)) return key;
  return null;
}

// ---- wake word ----------------------------------------------------------

// Whisper hears "Claude" in many ways in Indonesian speech.
const WAKE = /^\W*(?:hey|hei|hai|hay|he|eh|halo|oi|oy)[\s,.!-]*(?:claude|clode|claud|klod|klot|klaud|klaut|clod|cloud|claw?d|kloud|glod|clot)\b[\s,.!?-]*/i;

/**
 * "Hey Claude, buka Chrome" -> { rest: 'buka Chrome' }; "hey claude" -> { rest: '' };
 * anything without the wake word at the start -> null.
 */
export function parseWakeWord(text) {
  const t = String(text ?? '').trim();
  const m = t.match(WAKE);
  if (!m) return null;
  return { rest: t.slice(m[0].length).trim() };
}

// ---- actions that need the owner's spoken OK (even in bypass mode) -------

const SEND_TOOL = /(^|_)(send|post|reply|forward|publish|tweet|comment|invite|share|respond|create_draft|update_draft|schedule)(_|$)/i;
const SEND_SHELL = [
  [/\bSend-MailMessage\b/i, 'mengirim email'],
  [/\b(Invoke-RestMethod|Invoke-WebRequest|irm|iwr)\b[^|;]*-Method\s+['"]?(Post|Put|Patch|Delete)\b/i, 'mengirim data ke internet'],
  [/\bcurl\b[^|;]*(\s-X\s*['"]?(POST|PUT|PATCH|DELETE)\b|\s--data\b|\s-d\s|\s-F\s|\s--form\b)/i, 'mengirim data ke internet'],
  [/\bgh\s+(pr|issue)\s+(comment|review)\b/i, 'mengirim komentar'],
  [/\b(Stop-Computer|Restart-Computer|shutdown(\.exe)?\s+\/[srlh])\b/i, 'mematikan atau me-restart laptop'],
  // Pressing Enter in a chat app (WhatsApp, Telegram, ...) sends the message.
  [/type\.ps1[^|;]*-Keys\s+['"]?[^'"]*\{ENTER\}/i, 'menekan Enter (bisa mengirim pesan)'],
];

/**
 * Does this tool call need the owner's spoken OK? Sending messages, posting,
 * email, sending data out and shutdown do; writing and running code doesn't.
 * Messages to the owner's own Claude sessions (SendMessage) don't either.
 * @returns {null | { reason: string, summary: string }}
 */
export function needsConsent(toolName, input = {}) {
  const described = typeof input.description === 'string' ? input.description.trim() : '';
  if (toolName.startsWith('mcp__')) {
    const action = toolName.split('__').pop();
    if (SEND_TOOL.test(action)) {
      return { reason: `memakai ${action.replace(/_/g, ' ')}`, summary: described || shorten(JSON.stringify(input)) };
    }
    return null;
  }
  if (SHELL_TOOLS.has(toolName)) {
    const command = String(input.command ?? '');
    for (const [pattern, reason] of SEND_SHELL) {
      if (pattern.test(command)) return { reason, summary: described || shorten(command) };
    }
  }
  return null;
}
