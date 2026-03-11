export interface FluxConfig {
  url: string;
  name?: string;
  heartbeatInterval?: number;
  jobTimeout?: number;
}

export interface FluxPeer {
  id: string;
  name: string;
  capabilities: string[];
  workspaces: string[];
  startedAt: number;
}

export interface FluxJob {
  id: string;
  fn: string;
  payload: unknown;
  sourceHost: string;
  workspace?: string;
}

export interface FluxResult {
  jobId: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface FluxEvent {
  type: "peer:joined" | "peer:left" | "ctx:updated" | "stream:data" | "stream:end";
  workspace: string;
  peerId: string;
  peerName: string;
  key?: string;
  data?: unknown;
}

export type Handler = (payload: unknown) => Promise<unknown>;
export type EventHandler = (event: FluxEvent) => void;
export type StreamHandler = (chunk: string, peerId: string) => void;
