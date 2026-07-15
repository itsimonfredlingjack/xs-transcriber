import { EventEmitter } from 'node:events';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SegmentEnvelope } from '../types.js';
import { WorkerClient, WorkerError } from '../worker/client.js';

const RETRY_DELAYS_MS = [500, 1_000, 2_000, 5_000, 10_000, 30_000];

export class DurableSegmentQueue extends EventEmitter {
  private pumping = false;
  private stopped = false;

  constructor(
    private readonly queueDirectory: string,
    private readonly client: WorkerClient,
  ) {
    super();
  }

  async start(): Promise<void> {
    await mkdir(this.queueDirectory, { recursive: true });
    void this.pump();
  }

  async enqueue(envelope: SegmentEnvelope): Promise<void> {
    await mkdir(this.queueDirectory, { recursive: true });
    const destination = path.join(this.queueDirectory, `${safeId(envelope.segment_id)}.json`);
    const temporary = `${destination}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(envelope), { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, destination);
    this.emit('queued', envelope);
    void this.pump();
  }

  async pending(): Promise<number> {
    try {
      return (await readdir(this.queueDirectory)).filter((name) => name.endsWith('.json')).length;
    } catch {
      return 0;
    }
  }

  async waitForDrain(timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while ((await this.pending()) > 0 || this.pumping) {
      if (Date.now() > deadline) throw new Error('Timed out draining the local worker queue');
      await delay(250);
    }
  }

  stop(): void {
    this.stopped = true;
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.stopped) return;
    this.pumping = true;
    try {
      while (!this.stopped) {
        const files = (await readdir(this.queueDirectory))
          .filter((name) => name.endsWith('.json'))
          .sort();
        const file = files[0];
        if (!file) break;
        const fullPath = path.join(this.queueDirectory, file);
        let envelope: SegmentEnvelope;
        try {
          envelope = JSON.parse(await readFile(fullPath, 'utf8')) as SegmentEnvelope;
        } catch (error) {
          this.emit('error', new Error(`Unreadable queue entry ${file}: ${String(error)}`));
          break;
        }

        let delivered = false;
        for (let attempt = 0; !delivered && !this.stopped; attempt += 1) {
          try {
            await this.client.addSegment(envelope);
            await unlink(fullPath);
            delivered = true;
            this.emit('delivered', envelope);
          } catch (error) {
            const retryable = !(error instanceof WorkerError) || error.retryable;
            this.emit('deliveryError', error, envelope);
            if (!retryable) return;
            await delay(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]!);
          }
        }
      }
    } finally {
      this.pumping = false;
      this.emit('idle');
    }
  }
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
