import { Lux, LuxSubscriber } from "lux-sdk";
import { randomUUID } from "crypto";
import type { FluxConfig, FluxHost, FluxJob, FluxResult, Handler } from "./types";

const HEARTBEAT_MS = 3000;
const HOST_TTL_S = 10;
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
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private consuming = false;
  private started = false;
  private jobTimeout: number;
  private roundRobin = new Map<string, number>();

  constructor(config: FluxConfig) {
    const { host, port } = parseUrl(config.url);
    this.cmd = new Lux({ host, port });
    this.sub = new LuxSubscriber({ host, port });
    this.id = randomUUID();
    this.name = config.name || this.id.slice(0, 8);
    this.jobTimeout = config.jobTimeout || DEFAULT_TIMEOUT_MS;
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

  async send(fn: string, payload: unknown, timeout?: number): Promise<unknown> {
    const hosts = await this.cmd.smembers(`flux:fn:${fn}`);
    if (hosts.length === 0) {
      throw new Error(`no host handles "${fn}"`);
    }

    const idx = (this.roundRobin.get(fn) || 0) % hosts.length;
    this.roundRobin.set(fn, idx + 1);
    const targetHost = hosts[idx];

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

  async discover(): Promise<FluxHost[]> {
    const hostIds = await this.cmd.smembers("flux:hosts");
    if (hostIds.length === 0) return [];

    const commands = hostIds.map((id) => ["GET", `flux:host:${id}`] as (string | number)[]);
    const results = await this.cmd.pipeline(commands);

    const hosts: FluxHost[] = [];
    for (let i = 0; i < hostIds.length; i++) {
      const val = results[i];
      if (!val || typeof val !== "string") {
        this.cmd.command("SREM", "flux:hosts", hostIds[i]);
        continue;
      }
      try {
        hosts.push(JSON.parse(val));
      } catch {}
    }
    return hosts;
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

    await this.cmd.pipeline([
      ["DEL", `flux:host:${this.id}`],
      ["SREM", "flux:hosts", this.id],
      ["DEL", `flux:q:${this.id}`],
      ...[...this.handlers.keys()].map((fn) => ["SREM", `flux:fn:${fn}`, this.id] as (string | number)[]),
    ]);

    await this.sub.unsubscribe(`flux:notify:${this.id}`);
    await this.sub.unsubscribe(`flux:res:${this.id}`);
    this.sub.disconnect();
    this.cmd.disconnect();
  }

  private async register(): Promise<void> {
    const meta: FluxHost = {
      id: this.id,
      name: this.name,
      handlers: [...this.handlers.keys()],
      startedAt: Date.now(),
    };

    await this.cmd.pipeline([
      ["SET", `flux:host:${this.id}`, JSON.stringify(meta), "EX", HOST_TTL_S],
      ["SADD", "flux:hosts", this.id],
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
