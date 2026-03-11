# Flux

A real-time peer-to-peer protocol built on [Lux](https://github.com/mattyhogan/lux).

**MCP connects tools to models. Flux connects models to each other.**

Any process -- agent, service, script, dashboard -- connects to a single Lux instance and instantly discovers every other peer on the network. No REST APIs between peers. No service URLs. No API keys. Just connect and collaborate.

```
  Alice                      Lux                       Bob
    |                         |                         |
    |--- join("project") ---->|<--- join("project") ----|
    |                         |                         |
    |--- ctx.set("docs") ---->|                         |
    |                         |---- ctx:updated ------->|  (real-time event)
    |                         |                         |
    |--- send("summarize") -->|                         |
    |                         |--- job pushed --------->|  (routed by capability)
    |                         |<--- result published ---|
    |<-- result returned -----|                         |
    |                         |                         |
    |--- stream("analysis") ->|---- stream:data ------->|  (live tokens)
    |                         |---- stream:data ------->|
    |                         |---- stream:end -------->|
```

## Quick Start

```bash
bun add lux-flux
```

```typescript
import { Flux } from "lux-flux";

const flux = new Flux({
  url: "lux://10.0.0.176:6379",
  name: "researcher",
});

flux.expose("summarize", async (payload: any) => {
  return summarize(payload.text);
});

await flux.start();

// join a workspace -- scoped collaboration
await flux.join("project-alpha");

// shared context -- any peer can read/write
await flux.ctx.set("project-alpha", "findings", { topics: ["perf", "latency"] });
const docs = await flux.ctx.get("project-alpha", "docs");

// call any peer by capability (auto-routed)
const result = await flux.send("translate", { text: "hello", lang: "es" });

// stream live data to the workspace
await flux.stream("project-alpha", "my-analysis", (async function* () {
  for await (const token of llm.stream("analyze this...")) {
    yield token;
  }
})());

// listen to everything happening
flux.on("peer:joined", (e) => console.log(`${e.peerName} joined`));
flux.on("ctx:updated", (e) => console.log(`${e.peerName} updated ${e.key}`));
flux.onStream(peer.peerId, "reasoning", (chunk) => process.stdout.write(chunk));
```

## Core Concepts

### Peers
Any process that connects to Flux. Agents, services, scripts, UIs. They register with a name and capabilities, heartbeat to stay alive, and disappear cleanly when they stop.

### Workspaces
Scoped collaboration rooms. Peers join a workspace to work together on something. Events, context, and streams are scoped to workspaces. A peer can be in multiple workspaces.

### Shared Context
Key-value state within a workspace. Any peer can read and write. No fetching from each other -- just read the shared memory directly. When context changes, every peer in the workspace gets a real-time event.

### Capabilities
Peers advertise what they can do, not where they live. `flux.expose("summarize", handler)` means "I can summarize." When someone calls `flux.send("summarize", data)`, Flux routes it to a peer with that capability automatically.

### Streams
Publish live data that other peers can subscribe to. Token-by-token LLM output, sensor readings, progress updates. Delivered via pub/sub to the entire workspace in real-time.

## API

### `new Flux(config)`

| Option | Default | Description |
|--------|---------|-------------|
| `url` | required | Lux connection (`lux://host:port`) |
| `name` | random | Human-readable peer name |
| `jobTimeout` | 30000 | Timeout in ms for `send()` calls |

### Lifecycle

| Method | Description |
|--------|-------------|
| `flux.expose(name, handler)` | Register a capability. Call before `start()` |
| `flux.start()` | Connect, register, begin consuming jobs |
| `flux.stop()` | Deregister, cleanup, disconnect |

### Workspaces

| Method | Description |
|--------|-------------|
| `flux.join(workspace)` | Join a workspace, returns current peers |
| `flux.leave(workspace)` | Leave a workspace |
| `flux.peers(workspace?)` | List peers (in workspace or globally) |

### Communication

| Method | Description |
|--------|-------------|
| `flux.send(fn, payload, timeout?)` | RPC to any peer with capability `fn` |
| `flux.ctx.set(ws, key, value)` | Write shared context |
| `flux.ctx.get(ws, key)` | Read shared context |
| `flux.ctx.del(ws, key)` | Delete shared context |
| `flux.ctx.keys(ws)` | List context keys |
| `flux.stream(ws, key, iterable)` | Stream data to workspace |
| `flux.onStream(peerId, key, handler)` | Subscribe to a peer's stream |

### Events

| Event | Fired when |
|-------|------------|
| `peer:joined` | A peer joins a workspace you're in |
| `peer:left` | A peer leaves or disconnects |
| `ctx:updated` | Shared context changes |
| `stream:data` | Stream chunk received |
| `stream:end` | Stream finished |

## Lux Key Patterns

| Key | Type | Purpose |
|-----|------|---------|
| `flux:peer:{id}` | String + TTL | Peer metadata, expires on missed heartbeat |
| `flux:peers` | Set | All active peer IDs |
| `flux:fn:{name}` | Set | Peers with a given capability |
| `flux:q:{peerId}` | List | Job queue per peer |
| `flux:notify:{peerId}` | Pub/Sub | Wake peer when job arrives |
| `flux:res:{peerId}` | Pub/Sub | Deliver results back to caller |
| `flux:ws:{name}:peers` | Set | Peers in a workspace |
| `flux:ws:{name}:ctx:{key}` | String | Shared context within workspace |
| `flux:ws:{name}:events` | Pub/Sub | Workspace event channel |

## License

MIT
