#!/usr/bin/env bun
import { Lux } from "lux-sdk";
import type { FluxPeer, CapabilityMeta } from "./types";

const DEFAULT_URL = "lux://10.0.0.176:6379";

function parseUrl(url: string): { host: string; port: number } {
  const cleaned = url.replace(/^lux:\/\//, "");
  const [host, portStr] = cleaned.split(":");
  return { host, port: parseInt(portStr || "6379", 10) };
}

async function withLux<T>(url: string, fn: (cmd: Lux) => Promise<T>): Promise<T> {
  const { host, port } = parseUrl(url);
  const cmd = new Lux({ host, port });
  await cmd.connect();
  try {
    return await fn(cmd);
  } finally {
    cmd.disconnect();
  }
}

async function getPeers(cmd: Lux): Promise<FluxPeer[]> {
  const peerIds = await cmd.smembers("flux:peers");
  if (peerIds.length === 0) return [];

  const results = await cmd.pipeline(
    peerIds.map((id) => ["GET", `flux:peer:${id}`] as (string | number)[])
  );

  const peers: FluxPeer[] = [];
  for (let i = 0; i < peerIds.length; i++) {
    const val = results[i];
    if (!val || typeof val !== "string") continue;
    try { peers.push(JSON.parse(val)); } catch {}
  }
  return peers;
}

function formatUptime(startedAt: number): string {
  const sec = Math.floor((Date.now() - startedAt) / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

const commands: Record<string, { description: string; run: (args: string[]) => Promise<void> }> = {
  peers: {
    description: "List all live peers on the network",
    async run(args) {
      const url = args[0] || DEFAULT_URL;
      await withLux(url, async (cmd) => {
        const peers = await getPeers(cmd);
        if (peers.length === 0) {
          console.log("no peers online");
          return;
        }
        console.log(`${peers.length} peer${peers.length > 1 ? "s" : ""} online:\n`);
        for (const p of peers) {
          const caps = p.capabilities.map((c: CapabilityMeta) => c.name).join(", ") || "none";
          const ws = p.workspaces.join(", ") || "none";
          console.log(`  ${p.name}`);
          console.log(`    id:           ${p.id}`);
          console.log(`    capabilities: ${caps}`);
          console.log(`    workspaces:   ${ws}`);
          console.log(`    uptime:       ${formatUptime(p.startedAt)}`);
          console.log();
        }
      });
    },
  },

  status: {
    description: "Show network overview",
    async run(args) {
      const url = args[0] || DEFAULT_URL;
      await withLux(url, async (cmd) => {
        const peers = await getPeers(cmd);
        const allCaps = new Set<string>();
        const allWs = new Set<string>();
        for (const p of peers) {
          for (const c of p.capabilities) allCaps.add(c.name);
          for (const w of p.workspaces) allWs.add(w);
        }

        console.log("flux network status\n");
        console.log(`  peers:        ${peers.length}`);
        console.log(`  capabilities: ${allCaps.size} (${[...allCaps].join(", ") || "none"})`);
        console.log(`  workspaces:   ${allWs.size} (${[...allWs].join(", ") || "none"})`);

        const queueKeys = await cmd.keys("flux:q:*");
        let totalQueued = 0;
        if (queueKeys.length > 0) {
          const lengths = await cmd.pipeline(
            queueKeys.map((k) => ["LLEN", k] as (string | number)[])
          );
          totalQueued = (lengths as number[]).reduce((a, b) => a + (b || 0), 0);
        }
        console.log(`  queued jobs:  ${totalQueued}`);
      });
    },
  },

  describe: {
    description: "Show schema for a capability",
    async run(args) {
      const fn = args[0];
      if (!fn) {
        console.log("usage: flux describe <capability> [url]");
        return;
      }
      const url = args[1] || DEFAULT_URL;
      await withLux(url, async (cmd) => {
        const peerIds = await cmd.smembers(`flux:fn:${fn}`);
        if (peerIds.length === 0) {
          console.log(`no peer handles "${fn}"`);
          return;
        }

        for (const id of peerIds) {
          const raw = await cmd.get(`flux:peer:${id}`);
          if (!raw) continue;
          try {
            const peer: FluxPeer = JSON.parse(raw);
            const cap = peer.capabilities.find((c: CapabilityMeta) => c.name === fn);
            if (!cap) continue;
            console.log(`${fn} (served by ${peer.name})\n`);
            if (cap.description) console.log(`  ${cap.description}\n`);
            if (cap.schema) {
              console.log("  schema:");
              console.log(`  ${JSON.stringify(cap.schema, null, 2).split("\n").join("\n  ")}`);
            } else {
              console.log("  no schema defined");
            }
            return;
          } catch {}
        }
        console.log(`capability "${fn}" found but no schema available`);
      });
    },
  },

  workspaces: {
    description: "List active workspaces and their peers",
    async run(args) {
      const url = args[0] || DEFAULT_URL;
      await withLux(url, async (cmd) => {
        const wsKeys = await cmd.keys("flux:ws:*:peers");
        if (wsKeys.length === 0) {
          console.log("no active workspaces");
          return;
        }

        for (const key of wsKeys) {
          const wsName = key.replace("flux:ws:", "").replace(":peers", "");
          const memberIds = await cmd.smembers(key);
          const names: string[] = [];
          for (const id of memberIds) {
            const raw = await cmd.get(`flux:peer:${id}`);
            if (!raw) continue;
            try { names.push(JSON.parse(raw).name); } catch {}
          }
          console.log(`${wsName} (${names.length} peer${names.length !== 1 ? "s" : ""})`);
          for (const n of names) console.log(`  - ${n}`);

          const ctxPrefix = `flux:ws:${wsName}:ctx:`;
          const ctxKeys = await cmd.keys(`${ctxPrefix}*`);
          if (ctxKeys.length > 0) {
            const shortKeys = ctxKeys.map((k) => k.slice(ctxPrefix.length));
            console.log(`  context: ${shortKeys.join(", ")}`);
          }
          console.log();
        }
      });
    },
  },

  clean: {
    description: "Remove stale flux keys from Lux",
    async run(args) {
      const url = args[0] || DEFAULT_URL;
      await withLux(url, async (cmd) => {
        const allKeys = await cmd.keys("flux:*");
        if (allKeys.length === 0) {
          console.log("no flux keys found");
          return;
        }

        const peerIds = await cmd.smembers("flux:peers");
        const alive = new Set<string>();
        if (peerIds.length > 0) {
          const checks = await cmd.pipeline(
            peerIds.map((id) => ["EXISTS", `flux:peer:${id}`] as (string | number)[])
          );
          for (let i = 0; i < peerIds.length; i++) {
            if (checks[i] === 1) alive.add(peerIds[i]);
          }
        }

        const staleIds = peerIds.filter((id) => !alive.has(id));
        if (staleIds.length === 0) {
          console.log(`network clean (${alive.size} live peers, ${allKeys.length} keys)`);
          return;
        }

        const cleanCmds: (string | number)[][] = [];
        for (const id of staleIds) {
          cleanCmds.push(["SREM", "flux:peers", id]);
          cleanCmds.push(["DEL", `flux:q:${id}`]);
          cleanCmds.push(["DEL", `flux:peer:${id}:ws`]);
        }

        const fnKeys = allKeys.filter((k) => k.startsWith("flux:fn:"));
        for (const key of fnKeys) {
          for (const id of staleIds) {
            cleanCmds.push(["SREM", key, id]);
          }
        }

        const wsKeys = allKeys.filter((k) => k.match(/^flux:ws:.*:peers$/));
        for (const key of wsKeys) {
          for (const id of staleIds) {
            cleanCmds.push(["SREM", key, id]);
          }
        }

        await cmd.pipeline(cleanCmds);
        console.log(`cleaned ${staleIds.length} stale peer${staleIds.length > 1 ? "s" : ""}`);
      });
    },
  },
};

const cmd = process.argv[2];
const args = process.argv.slice(3);

if (!cmd || cmd === "help" || cmd === "--help") {
  console.log("flux - peer-to-peer protocol on Lux\n");
  console.log("usage: flux <command> [args]\n");
  console.log("commands:");
  for (const [name, { description }] of Object.entries(commands)) {
    console.log(`  ${name.padEnd(12)} ${description}`);
  }
  console.log(`\ndefault url: ${DEFAULT_URL}`);
  process.exit(0);
}

if (!commands[cmd]) {
  console.error(`unknown command: ${cmd}`);
  process.exit(1);
}

commands[cmd].run(args).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
