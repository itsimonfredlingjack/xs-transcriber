import { Client, Events, GatewayIntentBits } from 'discord.js';
import ffmpegPath from 'ffmpeg-static';
import { handleTranscribe } from './commands/transcribe.js';
import { config } from './config.js';
import { WorkerClient } from './worker/client.js';
import { SessionManager } from './voice/session-manager.js';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});
const worker = new WorkerClient(config.workerUrl, config.workerToken);
const sessions = new SessionManager(config, worker);

if (!ffmpegPath) throw new Error('ffmpeg-static did not provide a binary for this platform');

client.once(Events.ClientReady, async (readyClient) => {
  await sessions.initialize();
  console.log(`Discord transcriber ready as ${readyClient.user.tag}`);
  console.log(`FFmpeg diagnostic binary: ${ffmpegPath}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'transcribe') return;
  try {
    await handleTranscribe(interaction, sessions);
  } catch (error) {
    console.error('Unhandled command error', error);
    const content = 'The command failed unexpectedly. Check the bot logs.';
    if (interaction.deferred || interaction.replied) await interaction.editReply(content);
    else await interaction.reply({ content, ephemeral: true });
  }
});

client.on(Events.Error, (error) => console.error('Discord client error', error));

await client.login(config.discordToken);
