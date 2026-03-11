import { Flux } from "../src";

const LUX_URL = "lux://localhost:6379";

async function main() {
  const alice = new Flux({ url: LUX_URL, name: "alice" });
  const bob = new Flux({ url: LUX_URL, name: "bob" });

  alice.expose("summarize", async (payload: any) => {
    return `Summary of "${payload.text.slice(0, 50)}..." by alice`;
  });

  bob.expose("translate", async (payload: any) => {
    return `[translated to ${payload.lang}]: ${payload.text}`;
  });

  await alice.start();
  await bob.start();

  await alice.join("project-alpha");
  await bob.join("project-alpha");

  bob.on("peer:joined", (e) => console.log(`${e.peerName} joined ${e.workspace}`));
  bob.on("ctx:updated", (e) => console.log(`context "${e.key}" updated by ${e.peerName}`));

  await alice.ctx.set("project-alpha", "docs", {
    title: "Flux Protocol",
    body: "A real-time peer-to-peer protocol built on Lux...",
  });

  const docs = await bob.ctx.get("project-alpha", "docs");
  console.log("bob reads shared context:", docs);

  const summary = await bob.send("summarize", { text: "A real-time peer-to-peer protocol built on Lux for connecting models, agents, and services." });
  console.log("bob got summary:", summary);

  const translated = await alice.send("translate", { text: "hello world", lang: "es" });
  console.log("alice got translation:", translated);

  const peers = await alice.peers("project-alpha");
  console.log("peers in project-alpha:", peers.map((p) => p.name));

  let streamed = "";
  bob.onStream(alice.peerId, "analysis", (chunk) => {
    streamed += chunk;
  });

  await alice.stream("project-alpha", "analysis", (async function* () {
    yield "The data ";
    yield "suggests ";
    yield "strong growth.";
  })());

  await new Promise((r) => setTimeout(r, 100));
  console.log("bob received stream:", streamed);

  await alice.stop();
  await bob.stop();
}

main().catch(console.error);
