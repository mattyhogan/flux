import Redis from "ioredis";
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
  private cmd: Redis;
  private sub: Redis;
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
    this.cmd = new Redis({ host, port, lazyConnect: true, maxRetriesPerRequest: 3 });
    this.sub = new Redis({ host, port, lazyConnect: true, maxRetriesPerRequest: 3 });
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

    this.sub.on("message", (channel: string, message: string) => {
      if (channel === `flux:notify:${this.id}`) {
        this.drain();
      } else if (channel === `flux:res:${this.id}`) {
        this.handleResult(message);
      }
    });

    await this.sub.subscribe(`flux:notify:${this.id}`, `flux:res:${this.id}`);

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

    const pipeline = this.cmd.pipeline();
    pipeline.lpush(`flux:q:${targetHost}`, JSON.stringify(job));
    pipeline.publish(`flux:notify:${targetHost}`, job.id);
    await pipeline.exec();

    const result = await resultPromise;
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }

  async discover(): Promise<FluxHost[]> {
    const hostIds = await this.cmd.smembers("flux:hosts");
    if (hostIds.length === 0) return [];

    const pipeline = this.cmd.pipeline();
    for (const id of hostIds) {
      pipeline.get(`flux:host:${id}`);
    }
    const results = await pipeline.exec();
    if (!results) return [];

    const hosts: FluxHost[] = [];
    for (let i = 0; i < hostIds.length; i++) {
      const [err, val] = results[i];
      if (err || !val) {
        this.cmd.srem("flux:hosts", hostIds[i]);
        continue;
      }
      try {
        hosts.push(JSON.parse(val as string));
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

    const pipeline = this.cmd.pipeline();
    pipeline.del(`flux:host:${this.id}`);
    pipeline.srem("flux:hosts", this.id);
    pipeline.del(`flux:q:${this.id}`);
    for (const fn of this.handlers.keys()) {
      pipeline.srem(`flux:fn:${fn}`, this.id);
    }
    await pipeline.exec();

    await this.sub.unsubscribe();
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

    const pipeline = this.cmd.pipeline();
    pipeline.set(`flux:host:${this.id}`, JSON.stringify(meta), "EX", HOST_TTL_S);
    pipeline.sadd("flux:hosts", this.id);
    for (const fn of this.handlers.keys()) {
      pipeline.sadd(`flux:fn:${fn}`, this.id);
    }
    await pipeline.exec();
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
