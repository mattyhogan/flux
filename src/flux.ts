import { Lux, LuxSubscriber } from "lux-sdk";
import { randomUUID } from "crypto";
import type {
  FluxConfig,
  FluxPeer,
  FluxJob,
  FluxResult,
  FluxEvent,
  Handler,
  EventHandler,
  StreamHandler,
} from "./types";

const HEARTBEAT_MS = 3000;
const PEER_TTL_S = 10;
const DEFAULT_TIMEOUT_MS = 30000;

function parseUrl(url: string): { host: string; port: number } {
  const cleaned = url.replace(/^lux:\/\//, "");
  const [host, portStr] = cleaned.split(":");
  return { host, port: parseInt(portStr || "6379", 10) };
}

export class Flux {
  private cmd: Lux;
  private sub: LuxSubscriber;
  private id: string;
  private name: string;
  private handlers = new Map<string, Handler>();
  private pending = new Map<string, { resolve: (r: FluxResult) => void; timer: ReturnType<typeof setTimeout> }>();
  private eventHandlers = new Map<string, Set<EventHandler>>();
  private streamHandlers = new Map<string, StreamHandler>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private consuming = false;
  private started = false;
  private jobTimeout: number;
  private roundRobin = new Map<string, number>();
  private workspaces = new Set<string>();

  readonly ctx: FluxContext;

  constructor(config: FluxConfig) {
    const { host, port } = parseUrl(config.url);
    this.cmd = new Lux({ host, port });
    this.sub = new LuxSubscriber({ host, port });
    this.id = randomUUID();
    this.name = config.name || this.id.slice(0, 8);
    this.jobTimeout = config.jobTimeout || DEFAULT_TIMEOUT_MS;
    this.ctx = new FluxContext(this.cmd, this.id, this.name);
  }

  get peerId(): string {
    return this.id;
  }

  get peerName(): string {
    return this.name;
  }

  expose(fn: string, handler: Handler): this {
    this.handlers.set(fn, handler);
    return this;
  }

  async start(): Promise<void> {
    await this.cmd.connect();
    await this.sub.connect();

    await this.register();
    this.heartbeatTimer = setInterval(() => this.register(), HEARTBEAT_MS);

    await this.sub.subscribe(`flux:notify:${this.id}`, () => {
      this.drain();
    });

    await this.sub.subscribe(`flux:res:${this.id}`, (_channel, message) => {
      this.handleResult(message);
    });

    this.consuming = true;
    this.started = true;
    this.drain();
  }

  async join(workspace: string): Promise<FluxPeer[]> {
    this.workspaces.add(workspace);

    await this.cmd.pipeline([
      ["SADD", `flux:ws:${workspace}:peers`, this.id],
      ["SADD", `flux:peer:${this.id}:ws`, workspace],
    ]);

    await this.sub.subscribe(`flux:ws:${workspace}:events`, (_ch, msg) => {
      try {
        const event: FluxEvent = JSON.parse(msg);
        if (event.peerId === this.id) return;
        this.emit(event.type, event);
        if (event.type === "stream:data" || event.type === "stream:end") {
          const streamKey = `${event.peerId}:${event.key}`;
          const handler = this.streamHandlers.get(streamKey);
          if (handler && event.type === "stream:data") {
            handler(event.data as string, event.peerId);
          }
          if (event.type === "stream:end") {
            this.streamHandlers.delete(streamKey);
          }
        }
      } catch {}
    });

    const joinEvent: FluxEvent = {
      type: "peer:joined",
      workspace,
      peerId: this.id,
      peerName: this.name,
    };
    await this.cmd.publish(`flux:ws:${workspace}:events`, JSON.stringify(joinEvent));

    await this.register();
    return this.peers(workspace);
  }

  async leave(workspace: string): Promise<void> {
    this.workspaces.delete(workspace);

    const leaveEvent: FluxEvent = {
      type: "peer:left",
      workspace,
      peerId: this.id,
      peerName: this.name,
    };
    await this.cmd.publish(`flux:ws:${workspace}:events`, JSON.stringify(leaveEvent));

    await this.sub.unsubscribe(`flux:ws:${workspace}:events`);
    await this.cmd.pipeline([
      ["SREM", `flux:ws:${workspace}:peers`, this.id],
      ["SREM", `flux:peer:${this.id}:ws`, workspace],
    ]);
  }

  async peers(workspace?: string): Promise<FluxPeer[]> {
    const peerIds = workspace
      ? await this.cmd.smembers(`flux:ws:${workspace}:peers`)
      : await this.cmd.smembers("flux:peers");

    if (peerIds.length === 0) return [];

    const commands = peerIds.map((id) => ["GET", `flux:peer:${id}`] as (string | number)[]);
    const results = await this.cmd.pipeline(commands);

    const peers: FluxPeer[] = [];
    for (let i = 0; i < peerIds.length; i++) {
      const val = results[i];
      if (!val || typeof val !== "string") {
        if (workspace) this.cmd.command("SREM", `flux:ws:${workspace}:peers`, peerIds[i]);
        else this.cmd.command("SREM", "flux:peers", peerIds[i]);
        continue;
      }
      try {
        peers.push(JSON.parse(val));
      } catch {}
    }
    return peers;
  }

  async send(fn: string, payload: unknown, timeout?: number): Promise<unknown> {
    const allHosts = await this.cmd.smembers(`flux:fn:${fn}`);
    if (allHosts.length === 0) {
      throw new Error(`no peer handles "${fn}"`);
    }

    const checks = await this.cmd.pipeline(
      allHosts.map((id) => ["EXISTS", `flux:peer:${id}`] as (string | number)[])
    );
    const alive: string[] = [];
    const stale: string[] = [];
    for (let i = 0; i < allHosts.length; i++) {
      if (checks[i] === 1) alive.push(allHosts[i]);
      else stale.push(allHosts[i]);
    }

    if (stale.length > 0) {
      this.cmd.pipeline(
        stale.map((id) => ["SREM", `flux:fn:${fn}`, id] as (string | number)[])
      );
    }

    if (alive.length === 0) {
      throw new Error(`no live peer handles "${fn}"`);
    }

    const idx = (this.roundRobin.get(fn) || 0) % alive.length;
    this.roundRobin.set(fn, idx + 1);
    const targetHost = alive[idx];

    const job: FluxJob = {
      id: randomUUID(),
      fn,
      payload,
      sourceHost: this.id,
    };

    const timeoutMs = timeout || this.jobTimeout;

    const resultPromise = new Promise<FluxResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(job.id);
        resolve({ jobId: job.id, ok: false, error: `timeout after ${timeoutMs}ms` });
      }, timeoutMs);
      this.pending.set(job.id, { resolve, timer });
    });

    await this.cmd.pipeline([
      ["LPUSH", `flux:q:${targetHost}`, JSON.stringify(job)],
      ["PUBLISH", `flux:notify:${targetHost}`, job.id],
    ]);

    const result = await resultPromise;
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }

  async stream(workspace: string, key: string, gen: AsyncIterable<string>): Promise<void> {
    for await (const chunk of gen) {
      const event: FluxEvent = {
        type: "stream:data",
        workspace,
        peerId: this.id,
        peerName: this.name,
        key,
        data: chunk,
      };
      await this.cmd.publish(`flux:ws:${workspace}:events`, JSON.stringify(event));
    }

    const endEvent: FluxEvent = {
      type: "stream:end",
      workspace,
      peerId: this.id,
      peerName: this.name,
      key,
    };
    await this.cmd.publish(`flux:ws:${workspace}:events`, JSON.stringify(endEvent));
  }

  onStream(peerId: string, key: string, handler: StreamHandler): void {
    this.streamHandlers.set(`${peerId}:${key}`, handler);
  }

  on(event: string, handler: EventHandler): this {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
    return this;
  }

  off(event: string, handler: EventHandler): this {
    this.eventHandlers.get(event)?.delete(handler);
    return this;
  }

  async discover(): Promise<FluxPeer[]> {
    return this.peers();
  }

  async stop(): Promise<void> {
    this.consuming = false;
    this.started = false;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    for (const [jobId, { resolve, timer }] of this.pending) {
      clearTimeout(timer);
      resolve({ jobId, ok: false, error: "flux stopped" });
    }
    this.pending.clear();

    for (const ws of this.workspaces) {
      const leaveEvent: FluxEvent = {
        type: "peer:left",
        workspace: ws,
        peerId: this.id,
        peerName: this.name,
      };
      await this.cmd.publish(`flux:ws:${ws}:events`, JSON.stringify(leaveEvent));
      await this.sub.unsubscribe(`flux:ws:${ws}:events`);
    }

    const cleanupCmds: (string | number)[][] = [
      ["DEL", `flux:peer:${this.id}`],
      ["SREM", "flux:peers", this.id],
      ["DEL", `flux:q:${this.id}`],
      ["DEL", `flux:peer:${this.id}:ws`],
      ...[...this.handlers.keys()].map((fn) => ["SREM", `flux:fn:${fn}`, this.id] as (string | number)[]),
      ...[...this.workspaces].map((ws) => ["SREM", `flux:ws:${ws}:peers`, this.id] as (string | number)[]),
    ];

    await this.cmd.pipeline(cleanupCmds);
    this.workspaces.clear();

    await this.sub.unsubscribe(`flux:notify:${this.id}`);
    await this.sub.unsubscribe(`flux:res:${this.id}`);
    this.sub.disconnect();
    this.cmd.disconnect();
  }

  private emit(type: string, event: FluxEvent): void {
    const handlers = this.eventHandlers.get(type);
    if (handlers) {
      for (const h of handlers) h(event);
    }
  }

  private async register(): Promise<void> {
    const meta: FluxPeer = {
      id: this.id,
      name: this.name,
      capabilities: [...this.handlers.keys()],
      workspaces: [...this.workspaces],
      startedAt: Date.now(),
    };

    await this.cmd.pipeline([
      ["SET", `flux:peer:${this.id}`, JSON.stringify(meta), "EX", PEER_TTL_S],
      ["SADD", "flux:peers", this.id],
      ...[...this.handlers.keys()].map((fn) => ["SADD", `flux:fn:${fn}`, this.id] as (string | number)[]),
    ]);
  }

  private async drain(): Promise<void> {
    if (!this.consuming) return;

    let raw: string | null;
    while ((raw = await this.cmd.rpop(`flux:q:${this.id}`)) !== null) {
      try {
        const job: FluxJob = JSON.parse(raw);
        const handler = this.handlers.get(job.fn);
        let result: FluxResult;

        if (!handler) {
          result = { jobId: job.id, ok: false, error: `unknown function "${job.fn}"` };
        } else {
          try {
            const data = await handler(job.payload);
            result = { jobId: job.id, ok: true, data };
          } catch (err: any) {
            result = { jobId: job.id, ok: false, error: err?.message || "handler error" };
          }
        }

        await this.cmd.publish(`flux:res:${job.sourceHost}`, JSON.stringify(result));
      } catch {}
    }
  }

  private handleResult(message: string): void {
    try {
      const result: FluxResult = JSON.parse(message);
      const entry = this.pending.get(result.jobId);
      if (entry) {
        clearTimeout(entry.timer);
        this.pending.delete(result.jobId);
        entry.resolve(result);
      }
    } catch {}
  }
}

class FluxContext {
  constructor(
    private cmd: Lux,
    private peerId: string,
    private peerName: string,
  ) {}

  async set(workspace: string, key: string, value: unknown): Promise<void> {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    await this.cmd.set(`flux:ws:${workspace}:ctx:${key}`, serialized);

    const event: FluxEvent = {
      type: "ctx:updated",
      workspace,
      peerId: this.peerId,
      peerName: this.peerName,
      key,
      data: value,
    };
    await this.cmd.publish(`flux:ws:${workspace}:events`, JSON.stringify(event));
  }

  async get<T = unknown>(workspace: string, key: string): Promise<T | null> {
    const raw = await this.cmd.get(`flux:ws:${workspace}:ctx:${key}`);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return raw as T;
    }
  }

  async del(workspace: string, key: string): Promise<void> {
    await this.cmd.del(`flux:ws:${workspace}:ctx:${key}`);
  }

  async keys(workspace: string): Promise<string[]> {
    const prefix = `flux:ws:${workspace}:ctx:`;
    const allKeys = await this.cmd.keys(`${prefix}*`);
    return allKeys.map((k) => k.slice(prefix.length));
  }
}
