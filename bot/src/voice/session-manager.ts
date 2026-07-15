import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  entersState,
  joinVoiceChannel,
  VoiceConnectionStatus,
  type VoiceConnection,
} from '@discordjs/voice';
import {
  AttachmentBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  type Guild,
  type GuildTextBasedChannel,
  type VoiceBasedChannel,
} from 'discord.js';
import type { AppConfig } from '../config.js';
import { LiveTranscriptWriter } from '../discord/live-transcript.js';
import type { Participant, WorkerStatus } from '../types.js';
import { WorkerClient, WorkerError } from '../worker/client.js';
import { DurableSegmentQueue } from './durable-queue.js';
import { PerUserRecorder } from './recorder.js';

type RecordingState = 'recording' | 'paused' | 'stopping';

interface ActiveSession {
  id: string;
  guild: Guild;
  voiceChannel: VoiceBasedChannel;
  textChannel: GuildTextBasedChannel;
  connection: VoiceConnection;
  queue: DurableSegmentQueue;
  recorder: PerUserRecorder;
  liveWriter: LiveTranscriptWriter;
  state: RecordingState;
  startedAt: Date;
  startedMonotonic: number;
  lastPacketAt: number;
  watchdogWarned: boolean;
  reconnecting: boolean;
  resultCursor: number;
  pollTimer: NodeJS.Timeout;
  watchdogTimer: NodeJS.Timeout;
}

export class SessionManager {
  private active: ActiveSession | null = null;
  private readonly recoveredQueues = new Map<string, DurableSegmentQueue>();

  constructor(
    private readonly appConfig: AppConfig,
    private readonly worker: WorkerClient,
  ) {}

  async initialize(): Promise<void> {
    await this.recoverDurableQueues();
  }

  async start(interaction: ChatInputCommandInteraction): Promise<void> {
    const startedMonotonic = performance.now();
    const startedAt = new Date();
    await interaction.deferReply({ ephemeral: true });
    try {
      this.requireOperator(interaction);
      if (this.active) throw new Error(`Session ${this.active.id} is already active`);
      const guild = interaction.guild;
      if (!guild) throw new Error('This command can only be used in a server');
      // Prefer fresh member data; cache can miss voice state after reconnects.
      const member =
        guild.members.cache.get(interaction.user.id) ??
        (await guild.members.fetch(interaction.user.id).catch(() => null));
      const voiceChannel = member?.voice.channel;
      if (!voiceChannel) throw new Error('Join the voice channel you want to transcribe first');
      const textChannel = resolveAnnouncementChannel(interaction);
      this.requireBotPermissions(guild, textChannel, voiceChannel);
      await this.worker.health();

      const sessionId = createSessionId(startedAt);
      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: true,
        daveEncryption: true,
        decryptionFailureTolerance: 24,
        debug: this.appConfig.voiceDebug,
      });
      try {
        await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
      } catch (error) {
        connection.destroy();
        throw new Error(`Could not establish Discord voice: ${String(error)}`);
      }

      const participants = currentParticipants(voiceChannel);
      await this.worker.createSession({
        session_id: sessionId,
        guild_id: guild.id,
        voice_channel_id: voiceChannel.id,
        voice_channel_name: voiceChannel.name,
        text_channel_id: textChannel.id,
        started_at: startedAt.toISOString(),
        participants,
      });

      try {
        await sendPublic(
          textChannel,
          `🔴 **Recording and local transcription started** in **${clean(voiceChannel.name)}** ` +
            `by ${interaction.user}. Audio is captured separately per participant and retained for verification.`,
        );
      } catch (error) {
        connection.destroy();
        await this.worker.abort(sessionId, 'The required public recording announcement failed');
        throw new Error(`Recording was not started because the public announcement failed: ${String(error)}`);
      }

      const queue = new DurableSegmentQueue(
        path.join(this.appConfig.recordingsRoot, sessionId, 'queue'),
        this.worker,
      );
      await queue.start();
      const recorder = new PerUserRecorder(connection.receiver, guild, queue, {
        sessionId,
        sessionStartedMonotonic: startedMonotonic,
        recordingsRoot: this.appConfig.recordingsRoot,
        silenceMs: this.appConfig.speechEndSilenceMs,
      });
      const liveWriter = new LiveTranscriptWriter(textChannel);

      const session = {
        id: sessionId,
        guild,
        voiceChannel,
        textChannel,
        connection,
        queue,
        recorder,
        liveWriter,
        state: 'recording' as const,
        startedAt,
        startedMonotonic,
        lastPacketAt: Date.now(),
        watchdogWarned: false,
        reconnecting: false,
        resultCursor: 0,
        pollTimer: setInterval(() => void this.pollResults(), this.appConfig.workerPollMs),
        watchdogTimer: setInterval(() => void this.runWatchdog(), 5_000),
      } satisfies ActiveSession;
      this.active = session;
      this.attachRuntimeHandlers(session);
      await interaction.editReply(
        `Session **${sessionId}** started in **${voiceChannel.name}**. Preliminary text will appear publicly.`,
      );
    } catch (error) {
      await interaction.editReply(`Unable to start transcription: ${message(error)}`);
    }
  }

  async pause(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    try {
      this.requireOperator(interaction);
      const session = this.requireActive(interaction);
      if (session.state === 'stopping') throw new Error('The session is already stopping');
      if (session.state === 'recording') {
        session.state = 'paused';
        session.recorder.pause();
        await this.worker.setState(session.id, 'paused');
        await sendPublic(session.textChannel, '⏸️ **Recording and transcription paused.**');
        await interaction.editReply(`Session **${session.id}** is paused.`);
      } else {
        await this.worker.setState(session.id, 'recording');
        session.recorder.resume();
        session.state = 'recording';
        session.lastPacketAt = Date.now();
        session.watchdogWarned = false;
        await sendPublic(session.textChannel, '▶️ **Recording and transcription resumed.**');
        await interaction.editReply(`Session **${session.id}** resumed.`);
      }
    } catch (error) {
      await interaction.editReply(`Unable to change pause state: ${message(error)}`);
    }
  }

  async stop(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    try {
      this.requireOperator(interaction);
      if (!interaction.guild) throw new Error('This command can only be used in a server');
      const session = this.active;
      if (!session) {
        const latest = await this.worker.latest(interaction.guild.id);
        if (!['recording', 'paused'].includes(latest.state)) {
          throw new Error(`There is no active session; latest session ${latest.id} is ${latest.state}`);
        }
        const recovered = this.recoveredQueues.get(latest.id);
        if (recovered) await recovered.waitForDrain();
        await this.worker.finalize(latest.id);
        await interaction.editReply(
          `Recovered session **${latest.id}** was submitted for final transcription.`,
        );
        return;
      }
      if (session.guild.id !== interaction.guild.id) throw new Error('Another server owns the active session');
      if (session.state !== 'stopping') {
        session.state = 'stopping';
        clearInterval(session.pollTimer);
        clearInterval(session.watchdogTimer);
        await sendPublic(session.textChannel, '⏹️ **Recording stopped. High-accuracy final transcription is starting.**');
      }
      await session.recorder.stop();
      if (session.connection.state.status !== VoiceConnectionStatus.Destroyed) {
        session.connection.destroy();
      }
      await session.queue.waitForDrain();
      session.queue.stop();
      await this.worker.finalize(session.id);
      this.active = null;
      void this.monitorFinalization(session.id, session.textChannel);
      await interaction.editReply(
        `Session **${session.id}** is finalizing with KB-Whisper Large Strict. Use \`/transcribe status\` or \`/transcribe export\`.`,
      );
    } catch (error) {
      await interaction.editReply(`Unable to stop transcription: ${message(error)}`);
    }
  }

  async status(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    try {
      this.requireOperator(interaction);
      if (!interaction.guild) throw new Error('This command can only be used in a server');
      const id = this.active?.guild.id === interaction.guild.id ? this.active.id : undefined;
      const status = id ? await this.worker.status(id) : await this.worker.latest(interaction.guild.id);
      const local = this.active?.id === status.id ? this.active : null;
      await interaction.editReply(renderStatus(status, local));
    } catch (error) {
      await interaction.editReply(`Unable to read status: ${message(error)}`);
    }
  }

  async exportTranscript(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    try {
      this.requireOperator(interaction);
      if (!interaction.guild) throw new Error('This command can only be used in a server');
      const status = await this.worker.latest(interaction.guild.id);
      if (status.state !== 'completed') {
        throw new Error(
          status.state === 'finalizing'
            ? `Final transcription is still running (${status.segments.final_done || 0}/${status.segments.total || 0} files)`
            : `Latest session ${status.id} is ${status.state}`,
        );
      }
      const transcript = await this.worker.transcript(status.id);
      await interaction.editReply({
        content: `Final transcript for **${status.id}**`,
        files: [new AttachmentBuilder(transcript, { name: `${status.id}.txt` })],
      });
    } catch (error) {
      await interaction.editReply(`Unable to export transcript: ${message(error)}`);
    }
  }

  private requireOperator(interaction: ChatInputCommandInteraction): void {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      throw new Error('Manage Server permission is required');
    }
  }

  private requireActive(interaction: ChatInputCommandInteraction): ActiveSession {
    if (!this.active) throw new Error('There is no active recording session');
    if (interaction.guildId !== this.active.guild.id) throw new Error('Another server owns the active session');
    return this.active;
  }

  private requireBotPermissions(
    guild: Guild,
    textChannel: GuildTextBasedChannel,
    voiceChannel: VoiceBasedChannel,
  ): void {
    const me = guild.members.me;
    if (!me) throw new Error('The bot member is unavailable');
    const textPermissions = textChannel.permissionsFor(me);
    const voicePermissions = voiceChannel.permissionsFor(me);
    const missing: string[] = [];
    if (!textPermissions?.has(PermissionFlagsBits.ViewChannel)) missing.push('View Channel');
    const canSend =
      textPermissions?.has(PermissionFlagsBits.SendMessages) ||
      textPermissions?.has(PermissionFlagsBits.SendMessagesInThreads);
    if (!canSend) missing.push('Send Messages');
    if (!textPermissions?.has(PermissionFlagsBits.AttachFiles)) missing.push('Attach Files');
    if (!voicePermissions?.has(PermissionFlagsBits.ViewChannel)) missing.push('View Voice Channel');
    if (!voicePermissions?.has(PermissionFlagsBits.Connect)) missing.push('Connect');
    if (missing.length) throw new Error(`The bot is missing: ${missing.join(', ')}`);
  }

  private attachRuntimeHandlers(session: ActiveSession): void {
    session.recorder.on('packet', () => {
      session.lastPacketAt = Date.now();
      if (session.watchdogWarned) {
        session.watchdogWarned = false;
        queueMicrotask(() => void sendPublic(session.textChannel, '✅ Discord audio packets resumed.'));
      }
    });
    session.recorder.on('recordingError', (error) => {
      console.error('Recording error', error);
      void sendPublic(session.textChannel, `⚠️ Audio recording error: ${message(error)}`);
    });
    session.queue.on('error', (error) => console.error('Queue error', error));
    session.queue.on('deliveryError', (error) => console.warn('Worker delivery error', error));
    session.connection.on('error', (error) => {
      console.error('Voice connection error', error);
      void sendPublic(session.textChannel, `⚠️ Discord voice error: ${message(error)}`);
    });
    session.connection.on('debug', (line) => {
      if (this.appConfig.voiceDebug) console.debug(`[voice] ${line}`);
    });
    session.connection.on(VoiceConnectionStatus.Disconnected, () => void this.reconnect(session));
  }

  private async pollResults(): Promise<void> {
    const session = this.active;
    if (!session || session.state === 'stopping') return;
    try {
      const page = await this.worker.results(session.id, session.resultCursor);
      session.resultCursor = page.cursor;
      if (page.lines.length) await session.liveWriter.append(page.lines);
    } catch (error) {
      console.warn('Could not poll preliminary results', error);
    }
  }

  private async runWatchdog(): Promise<void> {
    const session = this.active;
    if (!session || session.state !== 'recording' || session.watchdogWarned) return;
    const peoplePresent = session.voiceChannel.members.some((member) => !member.user.bot);
    const staleMs = Date.now() - session.lastPacketAt;
    if (peoplePresent && staleMs >= this.appConfig.watchdogSeconds * 1000) {
      session.watchdogWarned = true;
      await sendPublic(
        session.textChannel,
        `⚠️ No Discord audio packets have arrived for ${Math.round(staleMs / 1000)} seconds. ` +
          'This can also mean everyone is silent; verify the recording or use OBS for a critical call.',
      );
    }
  }

  private async reconnect(session: ActiveSession): Promise<void> {
    if (this.active?.id !== session.id || session.reconnecting || session.state === 'stopping') return;
    session.reconnecting = true;
    await sendPublic(session.textChannel, '⚠️ Discord voice disconnected; automatic reconnection started.');
    let attempt = 0;
    while (this.active?.id === session.id) {
      if ((session.state as RecordingState) === 'stopping') break;
      attempt += 1;
      try {
        session.connection.rejoin();
        await entersState(session.connection, VoiceConnectionStatus.Ready, 15_000);
        session.lastPacketAt = Date.now();
        session.reconnecting = false;
        await sendPublic(session.textChannel, `✅ Discord voice reconnected after ${attempt} attempt(s).`);
        return;
      } catch (error) {
        console.warn(`Voice reconnect attempt ${attempt} failed`, error);
        await delay(Math.min(30_000, 1_000 * 2 ** Math.min(attempt - 1, 5)));
      }
    }
    session.reconnecting = false;
  }

  private async monitorFinalization(sessionId: string, channel: GuildTextBasedChannel): Promise<void> {
    for (;;) {
      await delay(5_000);
      try {
        const status = await this.worker.status(sessionId);
        if (status.state === 'completed') {
          await sendPublic(
            channel,
            `✅ Final transcript for **${sessionId}** is ready. Use \`/transcribe export\` to download it.`,
          );
          return;
        }
        if (['failed', 'aborted'].includes(status.state)) {
          await sendPublic(channel, `❌ Final transcription for **${sessionId}** failed: ${clean(status.error || 'unknown error')}`);
          return;
        }
      } catch (error) {
        console.warn('Could not monitor finalization', error);
      }
    }
  }

  private async recoverDurableQueues(): Promise<void> {
    let sessions: string[] = [];
    try {
      sessions = await readdir(this.appConfig.recordingsRoot);
    } catch {
      return;
    }
    for (const sessionId of sessions) {
      const queueDirectory = path.join(this.appConfig.recordingsRoot, sessionId, 'queue');
      const queue = new DurableSegmentQueue(queueDirectory, this.worker);
      if ((await queue.pending()) === 0) continue;
      queue.on('error', (error) => console.error('Recovered queue error', error));
      queue.on('deliveryError', (error) => console.warn('Recovered queue delivery error', error));
      this.recoveredQueues.set(sessionId, queue);
      await queue.start();
    }
  }
}

function currentParticipants(channel: VoiceBasedChannel): Participant[] {
  return [...channel.members.values()]
    .filter((member) => !member.user.bot)
    .map((member) => ({ user_id: member.id, speaker: clean(member.displayName) }));
}

function createSessionId(date: Date): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 10)}_${iso.slice(11, 19).replaceAll(':', '-')}`;
}

function renderStatus(status: WorkerStatus, local: ActiveSession | null): string {
  const segments = status.segments;
  const lines = [
    `**Session:** ${status.id}`,
    `**State:** ${status.state}`,
    `**Audio files:** ${segments.total || 0}`,
    `**Preliminary complete:** ${segments.preliminary_done || 0}`,
    `**Final complete:** ${segments.final_done || 0}`,
    `**Failed files:** ${segments.failed || 0}`,
    `**GPU queue:** ${status.worker.queue_depth}`,
    `**Loaded model:** ${status.worker.model || 'none'}`,
  ];
  if (local) {
    lines.push(`**Active user streams:** ${local.recorder.activeCount}`);
    lines.push(`**Last packet:** ${Math.round((Date.now() - local.lastPacketAt) / 1000)}s ago`);
    lines.push(`**DAVE privacy code:** ${local.connection.voicePrivacyCode ? 'present' : 'not reported'}`);
  }
  if (status.error) lines.push(`**Error:** ${clean(status.error)}`);
  return lines.join('\n');
}

function clean(value: string): string {
  return value.replace(/[\r\n\0]+/g, ' ').trim().slice(0, 1000);
}

function message(error: unknown): string {
  if (error instanceof WorkerError || error instanceof Error) return clean(error.message);
  return clean(String(error));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sendPublic(channel: GuildTextBasedChannel, content: string) {
  return channel.send({ content, allowedMentions: { parse: [] } });
}

/**
 * Accept normal #text, announcement, voice-channel chat, stage chat, and threads.
 * The previous TextChannel-only check rejected Discord's built-in voice text chat.
 */
function resolveAnnouncementChannel(interaction: ChatInputCommandInteraction): GuildTextBasedChannel {
  const channel = interaction.channel;
  if (!channel) {
    throw new Error('Could not resolve the channel. Try again from a server channel.');
  }
  if (!channel.isTextBased() || channel.isDMBased()) {
    throw new Error(
      'Run this in a server channel that can receive messages (#text, voice chat, announcement, or a thread).',
    );
  }
  if (!channel.isSendable()) {
    throw new Error(
      'This channel cannot receive bot messages (e.g. a forum listing). Open a post/thread or a #text channel.',
    );
  }
  return channel;
}
