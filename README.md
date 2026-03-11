# Flux

A service mesh protocol built on [Lux](https://github.com/mattyhogan/lux). Machines on a network discover each other and exchange work at wire speed.

## How it works

Every host connects to a single Lux instance. On startup, a host registers itself and advertises what functions it can handle. Other hosts discover available services automatically and send work to them. Results come back over pub/sub in milliseconds.

No hardcoded IPs between peers. Just point everyone at Lux and they find each other.

```
  Host A                     Lux                      Host B
    |                         |                         |
    |--- register ----------->|<--- register -----------|
    |    "resize", "compress" |     "transcode"         |
    |                         |                         |
    |--- send("transcode") -->|                         |
    |    { file: "v.mp4" }    |--- job pushed --------->|
    |                         |                         |-- executes transcode()
    |                         |<--- result published ---|
    |<-- result returned -----|                         |
    |    { url: "out.mp4" }   |                         |
```

## Quick Start

```bash
bun add lux-flux
```

### Worker (Machine B)

```typescript
import { Flux } from "lux-flux";

const flux = new Flux({
  url: "lux://10.0.0.176:6379",
  name: "media-worker",
});

flux.expose("transcode", async (payload) => {
  const { file, format } = payload as any;
  // do the work
  return { output: `${file}.${format}`, size: 1024 };
});

await flux.start();
```

### Caller (Machine A)

```typescript
import { Flux } from "lux-flux";

const flux = new Flux({
  url: "lux://10.0.0.176:6379",
  name: "api-server",
});

await flux.start();

const result = await flux.send("transcode", {
  file: "video.mp4",
  format: "webm",
});
// { output: "video.mp4.webm", size: 1024 }
```

### Discovery

```typescript
const hosts = await flux.discover();
// [
//   { id: "...", name: "media-worker", handlers: ["transcode"], startedAt: ... },
//   { id: "...", name: "api-server", handlers: [], startedAt: ... },
// ]
```

## API

### `new Flux(config)`

| Option | Default | Description |
|--------|---------|-------------|
| `url` | required | Lux connection string (`lux://host:port`) |
| `name` | random | Human-readable host name |
| `jobTimeout` | 30000 | Timeout in ms for `send()` calls |
| `heartbeatInterval` | 3000 | How often to refresh registration |

### `flux.expose(name, handler)`

Register a function this host can handle. Call before `start()`.

### `flux.start()`

Connect to Lux, register the host, begin consuming jobs.

### `flux.send(name, payload, timeout?)`

Send work to any host that handles `name`. Returns the result. Throws on timeout or handler error.

### `flux.discover()`

Returns all currently registered hosts and their capabilities.

### `flux.stop()`

Deregister, drain pending jobs, disconnect.

## Architecture

Flux uses five key patterns in Lux:

| Key | Type | Purpose |
|-----|------|---------|
| `flux:host:{id}` | String + TTL | Host metadata, expires if heartbeat stops |
| `flux:hosts` | Set | Registry of all active host IDs |
| `flux:fn:{name}` | Set | Which hosts handle a given function |
| `flux:q:{hostId}` | List | Job queue per host |
| `flux:notify:{hostId}` | Pub/Sub | Wake worker when job arrives |
| `flux:res:{hostId}` | Pub/Sub | Deliver results back to caller |

Hosts select targets via round-robin. Each host subscribes to exactly two pub/sub channels (notify + results), keeping connection overhead minimal.

## License

MIT
