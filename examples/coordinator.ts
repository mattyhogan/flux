import { Flux } from "../src";

const flux = new Flux({
  url: "lux://10.0.0.176:6379",
  name: "coordinator",
});

await flux.start();
await flux.join("demo");

flux.on("peer:joined", (e) => console.log(`  + ${e.peerName} joined`));
flux.on("peer:left", (e) => console.log(`  - ${e.peerName} left`));

console.log("coordinator online");
console.log("workspace: demo\n");

const topic = process.argv[2] || "artificial intelligence";
console.log(`=== starting pipeline: "${topic}" ===\n`);

console.log("[1/5] discovering peers...");
const peers = await flux.peers("demo");
console.log(`  found ${peers.length} peers: ${peers.map((p) => p.name).join(", ")}`);

const caps = peers.flatMap((p) => p.capabilities);
const needed = ["research", "draft"];
const missing = needed.filter((c) => !caps.includes(c));
if (missing.length > 0) {
  console.log(`\n  missing capabilities: ${missing.join(", ")}`);
  console.log("  start the researcher and writer peers first.");
  await flux.stop();
  process.exit(1);
}

console.log("\n[2/5] researching...");
const findings = await flux.send("research", { topic }) as string[];
console.log(`  got ${findings.length} findings`);
findings.forEach((f) => console.log(`    - ${f}`));

await flux.ctx.set("demo", "findings", findings);
await flux.ctx.set("demo", "status", "research-complete");

console.log("\n[3/5] fact-checking top findings...");
const checks = await Promise.all(
  findings.slice(0, 3).map(async (claim) => {
    return flux.send("fact-check", { claim });
  })
);
console.log("  results:");
for (const check of checks as any[]) {
  const icon = check.verified ? "Y" : "?";
  console.log(`    [${icon}] ${check.confidence} - ${check.claim.slice(0, 60)}...`);
}

console.log("\n[4/5] drafting report...");
const report = await flux.send("draft", { topic, findings, style: "report" }) as string;

await flux.ctx.set("demo", "report", report);
await flux.ctx.set("demo", "status", "draft-complete");

console.log("\n[5/5] summarizing...");
const summary = await flux.send("summarize", { text: report, maxLength: 200 }) as string;

await flux.ctx.set("demo", "summary", summary);
await flux.ctx.set("demo", "status", "complete");

console.log("\n=== pipeline complete ===\n");
console.log("--- REPORT ---");
console.log(report);
console.log("\n--- SUMMARY ---");
console.log(summary);

console.log("\n--- SHARED CONTEXT ---");
const keys = await flux.ctx.keys("demo");
console.log(`  keys: ${keys.join(", ")}`);

await flux.stop();
