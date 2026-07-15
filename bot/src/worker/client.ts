import type {
  PreliminaryLine,
  SegmentEnvelope,
  SessionCreate,
  WorkerStatus,
} from '../types.js';

export class WorkerError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export class WorkerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  async health(): Promise<Record<string, unknown>> {
    return this.request('/health');
  }

  async createSession(session: SessionCreate): Promise<void> {
    await this.request('/sessions', { method: 'POST', body: JSON.stringify(session) });
  }

  async addSegment(envelope: SegmentEnvelope): Promise<void> {
    const { sessionId, ...segment } = envelope;
    await this.request(`/sessions/${encodeURIComponent(sessionId)}/segments`, {
      method: 'POST',
      body: JSON.stringify(segment),
    });
  }

  async setState(sessionId: string, state: 'recording' | 'paused'): Promise<void> {
    await this.request(`/sessions/${encodeURIComponent(sessionId)}/state`, {
      method: 'PATCH',
      body: JSON.stringify({ state }),
    });
  }

  async finalize(sessionId: string): Promise<void> {
    await this.request(`/sessions/${encodeURIComponent(sessionId)}/finalize`, {
      method: 'POST',
    });
  }

  async abort(sessionId: string, reason: string): Promise<void> {
    await this.request(`/sessions/${encodeURIComponent(sessionId)}/abort`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  }

  async status(sessionId: string): Promise<WorkerStatus> {
    return this.request(`/sessions/${encodeURIComponent(sessionId)}/status`);
  }

  async latest(guildId: string): Promise<WorkerStatus> {
    return this.request(`/sessions/latest/${encodeURIComponent(guildId)}`);
  }

  async results(
    sessionId: string,
    after: number,
  ): Promise<{ cursor: number; lines: PreliminaryLine[] }> {
    return this.request(
      `/sessions/${encodeURIComponent(sessionId)}/results?after=${encodeURIComponent(after)}`,
    );
  }

  async transcript(sessionId: string): Promise<Buffer> {
    const response = await fetch(
      `${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}/transcript`,
      { headers: this.headers() },
    );
    if (!response.ok) throw await this.errorFromResponse(response);
    return Buffer.from(await response.arrayBuffer());
  }

  private async request<T>(pathname: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${pathname}`, {
        ...init,
        headers: { ...this.headers(), ...init.headers },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new WorkerError(`Worker request failed: ${String(error)}`, 0, true);
    }
    if (!response.ok) throw await this.errorFromResponse(response);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.token}`,
      'content-type': 'application/json',
    };
  }

  private async errorFromResponse(response: Response): Promise<WorkerError> {
    const body = await response.text();
    let detail = body;
    try {
      const decoded = JSON.parse(body) as { detail?: string };
      detail = decoded.detail || body;
    } catch {
      // Plain-text upstream error.
    }
    const retryable = response.status >= 500 || response.status === 408 || response.status === 429;
    return new WorkerError(`Worker returned ${response.status}: ${detail}`, response.status, retryable);
  }
}
