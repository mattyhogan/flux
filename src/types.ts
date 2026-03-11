export interface FluxConfig {
  url: string;
  name?: string;
  heartbeatInterval?: number;
  jobTimeout?: number;
}

export interface FluxHost {
  id: string;
  name: string;
  handlers: string[];
  startedAt: number;
}

export interface FluxJob {
  id: string;
  fn: string;
  payload: unknown;
  sourceHost: string;
}

export interface FluxResult {
  jobId: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export type Handler = (payload: unknown) => Promise<unknown>;
