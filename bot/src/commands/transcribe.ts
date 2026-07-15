import { PermissionFlagsBits, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { SessionManager } from '../voice/session-manager.js';

export const transcribeCommand = new SlashCommandBuilder()
  .setName('transcribe')
  .setDescription('Record and transcribe a Discord voice call locally')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((command) => command.setName('start').setDescription('Start recording your voice channel'))
  .addSubcommand((command) => command.setName('pause').setDescription('Toggle pause or resume'))
  .addSubcommand((command) => command.setName('stop').setDescription('Stop and run the final pass'))
  .addSubcommand((command) => command.setName('status').setDescription('Show recording and worker status'))
  .addSubcommand((command) => command.setName('export').setDescription('Download the latest final transcript'));

export async function handleTranscribe(
  interaction: ChatInputCommandInteraction,
  manager: SessionManager,
): Promise<void> {
  switch (interaction.options.getSubcommand(true)) {
    case 'start':
      return manager.start(interaction);
    case 'pause':
      return manager.pause(interaction);
    case 'stop':
      return manager.stop(interaction);
    case 'status':
      return manager.status(interaction);
    case 'export':
      return manager.exportTranscript(interaction);
    default:
      throw new Error('Unknown transcribe subcommand');
  }
}
