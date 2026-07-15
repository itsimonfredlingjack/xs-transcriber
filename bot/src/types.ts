export interface Participant {
  user_id: string;
  speaker: string;
}

export interface SessionCreate {
  session_id: string;
  guild_id: string;
  voice_channel_id: string;
  voice_channel_name: string;
  text_channel_id: string;
  started_at: string;
  participants: Participant[];
}

export interface SegmentEnvelope {
  sessionId: string;
  segment_id: string;
  sequence: number;
  user_id: string;
  speaker: string;
  relative_start_ms: number;
  relative_end_ms: number;
  relative_path: string;
}

export interface PreliminaryLine {
  id: number;
  start: number;
  end: number;
  user_id: string;
  speaker: string;
  text: string;
}

export interface WorkerStatus {
  id: string;
  state: string;
  error?: string | null;
  transcript_path?: string | null;
  segments: Record<string, number>;
  participants: Participant[];
  worker: {
    queue_depth: number;
    model: string | null;
    current_job: Record<string, unknown> | null;
    thread_alive: boolean;
  };
}
