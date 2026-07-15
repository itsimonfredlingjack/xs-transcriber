import { EventEmitter } from 'node:events';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Readable } from 'node:stream';
import { EndBehaviorType, type VoiceReceiver } from '@discordjs/voice';
import type { Guild } from 'discord.js';
import * as prism from 'prism-media';
import type { SegmentEnvelope } from '../types.js';
import { DurableSegmentQueue } from './durable-queue.js';

interface ActiveStream {
  userId: string;
  opus: Readable;
  ogg: NodeJS.WritableStream;
  output: WriteStream;
  completion: Promise<void>;
  forceClose: () => void;
}

export interface RecorderOptions {
  sessionId: string;
  sessionStartedMonotonic: number;
  recordingsRoot: string;
  silenceMs: number;
}

export class PerUserRecorder extends EventEmitter {
  private readonly active = new Map<string, ActiveStream>();
  private sequence = 0;
  private accepting = true;

  constructor(
    private readonly receiver: VoiceReceiver,
    private readonly guild: Guild,
    private readonly queue: DurableSegmentQueue,
    private readonly options: RecorderOptions,
  ) {
    super();
    this.receiver.speaking.on('start', this.onSpeakingStart);
  }

  get activeCount(): number {
    return this.active.size;
  }

  pause(): void {
    this.accepting = false;
    for (const stream of this.active.values()) stream.forceClose();
  }

  resume(): void {
    this.accepting = true;
  }

  async stop(): Promise<void> {
    this.accepting = false;
    this.receiver.speaking.off('start', this.onSpeakingStart);
    const streams = [...this.active.values()];
    for (const stream of streams) stream.forceClose();
    const results = await Promise.allSettled(
      streams.map((stream) => withTimeout(stream.completion, 10_000, 'closing Ogg stream')),
    );
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length) {
      throw new AggregateError(
        failures.map((result) => (result as PromiseRejectedResult).reason),
        `${failures.length} Ogg stream(s) did not close cleanly`,
      );
    }
  }

  private readonly onSpeakingStart = (userId: string): void => {
    if (!this.accepting || this.active.has(userId)) return;
    // Subscribe immediately so member lookup or disk setup never delays packet capture.
    void this.openStream(userId).catch((error) => this.emit('recordingError', error));
  };

  private async openStream(userId: string): Promise<void> {
    const sequence = this.sequence++;
    const relativeStartMs = Math.max(
      0,
      Math.round(performance.now() - this.options.sessionStartedMonotonic),
    );
    const speaker = this.resolveSpeaker(userId);
    const opus = this.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: this.options.silenceMs },
    });
    const userDirectory = path.join(
      this.options.recordingsRoot,
      this.options.sessionId,
      'raw',
      userId,
    );
    try {
      await mkdir(userDirectory, { recursive: true });
    } catch (error) {
      opus.destroy();
      throw error;
    }

    if (!this.accepting || this.active.has(userId)) {
      opus.destroy();
      return;
    }
    const filename = `${sequence.toString().padStart(8, '0')}_${relativeStartMs}.ogg`;
    const absolutePath = path.join(userDirectory, filename);
    const relativePath = path.relative(this.options.recordingsRoot, absolutePath);
    const segmentId = `${this.options.sessionId}-${sequence}-${userId}`;
    let lastPacketMs = relativeStartMs;
    let finished = false;

    // Uses pure-JS vendor/node-crc (see package.json) so Ogg page checksums are
    // valid without a Rust toolchain. Zero CRC is rejected by libav/ffmpeg.
    const ogg = new prism.opus.OggLogicalBitstream({
      opusHead: new prism.opus.OpusHead({ channelCount: 2, sampleRate: 48_000 }),
      pageSizeControl: { maxPackets: 10 },
    });
    const output = createWriteStream(absolutePath, { flags: 'wx' });

    const completion = new Promise<void>((resolve, reject) => {
      const finish = async (): Promise<void> => {
        if (finished) return;
        finished = true;
        this.active.delete(userId);
        const envelope: SegmentEnvelope = {
          sessionId: this.options.sessionId,
          segment_id: segmentId,
          sequence,
          user_id: userId,
          speaker,
          relative_start_ms: relativeStartMs,
          relative_end_ms: Math.max(relativeStartMs, lastPacketMs),
          relative_path: relativePath,
        };
        try {
          await this.queue.enqueue(envelope);
          this.emit('segment', envelope);
          resolve();
        } catch (error) {
          reject(error);
          this.emit('recordingError', error);
        }
      };

      opus.on('data', () => {
        lastPacketMs = Math.max(
          relativeStartMs,
          Math.round(performance.now() - this.options.sessionStartedMonotonic),
        );
        this.emit('packet', userId, lastPacketMs);
      });
      opus.once('error', (error) => this.emit('recordingError', error));
      ogg.once('error', (error) => this.emit('recordingError', error));
      output.once('error', (error) => {
        this.active.delete(userId);
        reject(error);
        this.emit('recordingError', error);
      });
      output.once('finish', () => void finish());
    });
    // Mark it handled now; stop() still inspects the original promise's result.
    void completion.catch(() => undefined);

    const forceClose = (): void => {
      if (finished || output.closed) return;
      opus.unpipe(ogg);
      ogg.end();
      opus.destroy();
    };

    this.active.set(userId, { userId, opus, ogg, output, completion, forceClose });
    // Per-user streams preserve overlap naturally; Opus is only muxed, never decoded here.
    opus.pipe(ogg).pipe(output);
    this.emit('streamStart', { userId, speaker, relativeStartMs, absolutePath });
  }

  private resolveSpeaker(userId: string): string {
    const member = this.guild.members.cache.get(userId);
    if (member?.displayName) return cleanName(member.displayName);
    const user = this.guild.client.users.cache.get(userId);
    return cleanName(user?.username || userId);
  }
}

function cleanName(value: string): string {
  return value.replace(/[\r\n\0]+/g, ' ').trim().slice(0, 128) || 'Unknown';
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
