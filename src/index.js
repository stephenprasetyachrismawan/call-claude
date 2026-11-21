import { Client, Events, GatewayIntentBits } from 'discord.js';
import { generateDependencyReport } from '@discordjs/voice';
import fs from 'node:fs';
import { config } from './config.js';
import { Assistant } from './assistant.js';
import { initStt } from './stt.js';

fs.mkdirSync(config.workspaceDir, { recursive: true });

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const assistant = new Assistant(client);

// Start loading Whisper right away so it is ready by the first call.
initStt().catch((err) => console.error('[stt] Gagal memuat model:', err.message));
const isOwner = (userId) => userId === config.ownerUserId;

client.once(Events.ClientReady, async (c) => {
  console.log(`[bot] Login sebagai ${c.user.tag}`);
  console.log(`[bot] Folder kerja Claude: ${config.workspaceDir}`);
  if (process.env.DEBUG_VOICE) console.log(generateDependencyReport());
  if (config.textChannelId) {
    assistant.textChannel = await c.channels.fetch(config.textChannelId).catch(() => null);
  }

  // If the owner is already in a voice channel, join right away.
  const guild = await c.guilds.fetch(config.guildId).catch(() => null);
  if (!guild) {
    console.error(`[bot] Bot belum ada di server ${config.guildId}. Undang bot dulu (lihat README).`);
    return;
  }
  const member = await guild.members.fetch(config.ownerUserId).catch(() => null);
  if (member?.voice.channel) await assistant.connect(member.voice.channel);
});

// Follow the owner: join when they join a voice channel, leave when they leave.
// A phone on a shaky connection can drop out of the channel for a moment;
// wait a bit before hanging up so that doesn't cut the call (and speech) off.
const OWNER_LEAVE_GRACE_MS = 15_000;
let leaveTimer = null;

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  if (newState.guild.id !== config.guildId) return;

  if (isOwner(newState.id)) {
    if (newState.channel) {
      clearTimeout(leaveTimer);
      leaveTimer = null;
      if (newState.channelId !== oldState.channelId) await assistant.connect(newState.channel);
    } else if (!leaveTimer) {
      console.log('[bot] Pemilik keluar dari voice, menunggu sebentar sebelum menutup panggilan');
      leaveTimer = setTimeout(() => {
        leaveTimer = null;
        assistant.disconnect();
      }, OWNER_LEAVE_GRACE_MS);
    }
    return;
  }

  // The bot itself was disconnected or moved by someone else.
  if (newState.id === client.user.id && !newState.channel) assistant.disconnect({ keepConversation: true });
});

// Typed messages in the bot's text channel go to Claude too.
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || message.guildId !== config.guildId) return;
  const channelId = assistant.textChannel?.id ?? config.textChannelId;
  if (!channelId || message.channelId !== channelId) return;
  // The owner gets full access; anyone else in the channel can only chat.
  if (!isOwner(message.author.id) && !assistant.inCall) return;
  await assistant.handleInput(message.content, 'text', {
    id: message.author.id,
    name: message.member?.displayName ?? message.author.username,
  });
});

// Approve / deny buttons. Only the owner can press them.
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;
  const [action, id] = interaction.customId.split(':');
  if (action !== 'approve' && action !== 'deny' && action !== 'model') return;

  if (!isOwner(interaction.user.id)) {
    await interaction.reply({ content: 'Hanya pemilik yang bisa menjawab ini.', ephemeral: true }).catch(() => {});
    return;
  }
  if (action === 'model') {
    await interaction.deferUpdate().catch(() => {});
    await assistant.setModel(id);
    return;
  }
  const ok = assistant.resolveApprovalButton(id, action === 'approve');
  if (ok) await interaction.deferUpdate().catch(() => {});
  else await interaction.reply({ content: 'Permintaan ini sudah tidak berlaku.', ephemeral: true }).catch(() => {});
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    assistant.disconnect(); // also kills every ClaudeCall session
    client.destroy();
    process.exit(0);
  });
}

process.on('unhandledRejection', (err) => console.error('[bot] unhandled:', err));

client.login(config.discordToken);
