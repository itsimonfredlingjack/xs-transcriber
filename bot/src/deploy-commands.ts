import { REST, Routes } from 'discord.js';
import { transcribeCommand } from './commands/transcribe.js';
import { config } from './config.js';

const rest = new REST({ version: '10' }).setToken(config.discordToken);
const body = [transcribeCommand.toJSON()];

if (config.discordGuildId) {
  await rest.put(Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId), { body });
  console.log(`Registered guild commands in ${config.discordGuildId}`);
} else {
  await rest.put(Routes.applicationCommands(config.discordClientId), { body });
  console.log('Registered global commands (Discord propagation can take up to one hour)');
}
