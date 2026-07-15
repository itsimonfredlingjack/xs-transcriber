import type { GuildTextBasedChannel, Message } from 'discord.js';
import type { PreliminaryLine } from '../types.js';

const MAX_BODY_LENGTH = 1_750;
const HEADER = '**Live transcript (preliminary)**\n';

export class LiveTranscriptWriter {
  private message: Message | null = null;
  private body = '';

  constructor(private readonly channel: GuildTextBasedChannel) {}

  async append(lines: PreliminaryLine[]): Promise<void> {
    let dirty = false;
    for (const line of lines) {
      const rendered = `${formatTimestamp(line.start)} ${clean(line.speaker)}: ${clean(line.text)}\n`;
      if (this.body.length + rendered.length > MAX_BODY_LENGTH) {
        if (dirty) await this.flush();
        this.message = null;
        this.body = '';
        dirty = false;
      }
      this.body += rendered;
      dirty = true;
    }
    if (dirty) await this.flush();
  }

  private async flush(): Promise<void> {
    const options = { content: `${HEADER}${this.body}`, allowedMentions: { parse: [] as never[] } };
    if (!this.message) this.message = await this.channel.send(options);
    else await this.message.edit(options);
  }
}

export function formatTimestamp(milliseconds: number): string {
  const total = Math.floor(Math.max(0, milliseconds) / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `[${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds
    .toString()
    .padStart(2, '0')}]`;
}

function clean(value: string): string {
  return value.replace(/[\r\n\0]+/g, ' ').trim();
}
