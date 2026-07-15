import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SegmentEnvelope } from '../../bot/src/types.js';
import type { WorkerClient } from '../../bot/src/worker/client.js';
import { DurableSegmentQueue } from '../../bot/src/voice/durable-queue.js';

describe('DurableSegmentQueue', () => {
  it('persists before delivery and removes an acknowledged item', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'discord-transcriber-'));
    const delivered: SegmentEnvelope[] = [];
    const worker = {
      async addSegment(item: SegmentEnvelope) {
        delivered.push(item);
      },
    } as unknown as WorkerClient;
    const queue = new DurableSegmentQueue(directory, worker);
    await queue.start();
    const item: SegmentEnvelope = {
      sessionId: '2026-07-15_11-30-00',
      segment_id: 'segment-1',
      sequence: 0,
      user_id: '1',
      speaker: 'Simon',
      relative_start_ms: 0,
      relative_end_ms: 1000,
      relative_path: 'session/raw/1/0.ogg',
    };
    await queue.enqueue(item);
    await queue.waitForDrain(5_000);
    expect(delivered).toEqual([item]);
    expect((await readdir(directory)).filter((name) => name.endsWith('.json'))).toEqual([]);
    queue.stop();
  });
});
