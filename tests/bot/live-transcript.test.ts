import { describe, expect, it } from 'vitest';
import type { TextChannel } from 'discord.js';
import { LiveTranscriptWriter, formatTimestamp } from '../../bot/src/discord/live-transcript.js';

describe('formatTimestamp', () => {
  it('floors milliseconds and retains hours', () => {
    expect(formatTimestamp(124_999)).toBe('[00:02:04]');
    expect(formatTimestamp(3_600_000)).toBe('[01:00:00]');
  });

  it('batches a poll page into one Discord write', async () => {
    const writes: unknown[] = [];
    const message = { edit: async (value: unknown) => writes.push(value) };
    const channel = {
      send: async (value: unknown) => {
        writes.push(value);
        return message;
      },
    } as unknown as TextChannel;
    const writer = new LiveTranscriptWriter(channel);
    await writer.append([
      { id: 1, start: 0, end: 1, user_id: '1', speaker: 'Simon', text: 'Hej.' },
      { id: 2, start: 2, end: 3, user_id: '2', speaker: 'Anna', text: 'Hej!' },
    ]);
    expect(writes).toHaveLength(1);
  });
});
