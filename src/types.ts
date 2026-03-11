import type { z } from "zod";

export interface FluxConfig {
  url: string;
  name?: string;
  jobTimeout?: number;
}

export interface FluxPeer {
  id: string;
  name: string;
  capabilities: CapabilityMeta[];
  workspaces: string[];
  startedAt: number;
}

export interface CapabilityMeta {
  name: string;
  description?: string;
  schema?: unknown;
}

export interface FluxJob {
  id: string;
  fn: string;
  payload: unknown;
  sourceHost: string;
  workspace?: string;
  attempt?: number;
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

export interface CapabilityDef<T extends z.ZodType = z.ZodType> {
  description?: string;
  schema?: T;
  handler: (payload: z.infer<T>) => Promise<unknown>;
  retry?: number;
}

export type Handler = (payload: unknown) => Promise<unknown>;
export type EventHandler = (event: FluxEvent) => void;
export type StreamHandler = (chunk: string, peerId: string) => void;
