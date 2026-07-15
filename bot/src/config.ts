import path from 'node:path';
import process from 'node:process';
import dotenv from 'dotenv';

dotenv.config();

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

function numberValue(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
  return value;
}

export const config = {
  discordToken: required('DISCORD_TOKEN'),
  discordClientId: required('DISCORD_CLIENT_ID'),
  discordGuildId: process.env.DISCORD_GUILD_ID?.trim() || undefined,
  workerUrl: (process.env.WORKER_URL || 'http://127.0.0.1:8765').replace(/\/$/, ''),
  workerToken: required('WORKER_API_TOKEN'),
  recordingsRoot: path.resolve(
    process.env.RECORDINGS_ROOT || '/home/simon/discord-transcriber/recordings',
  ),
  speechEndSilenceMs: numberValue('SPEECH_END_SILENCE_MS', 1_000),
  watchdogSeconds: numberValue('AUDIO_WATCHDOG_SECONDS', 60),
  workerPollMs: Math.max(500, numberValue('WORKER_POLL_MS', 2_000)),
  voiceDebug: (process.env.VOICE_DEBUG || 'false').toLowerCase() === 'true',
} as const;

export type AppConfig = typeof config;
