import { Flux } from "../src";

const flux = new Flux({
  url: "lux://10.0.0.176:6379",
  name: "researcher",
});

flux.expose("research", async (payload: any) => {
  const { topic } = payload;
  console.log(`\n  researching: "${topic}"...`);

  await sleep(800);

  const findings: Record<string, string[]> = {
    "climate change": [
      "Global temperatures rose 1.1C since pre-industrial era",
      "Arctic sea ice declining at 13% per decade",
      "Ocean acidification increased 30% since 1750",
      "2023 was the hottest year on record",
    ],
    "artificial intelligence": [
      "LLM parameters grew from 1.5B (GPT-2) to 1.8T (GPT-4) in 4 years",
      "AI chip market projected to reach $300B by 2030",
      "70% of enterprises experimenting with generative AI",
      "Energy consumption of AI training doubled annually since 2020",
    ],
    default: [
      `Found 12 relevant sources on "${topic}"`,
      `Key theme: rapid growth in ${topic} sector`,
      `Notable trend: increasing public interest since 2022`,
      `Warning: conflicting data in 3 sources`,
    ],
  };

  const results = findings[topic.toLowerCase()] || findings.default;
  console.log(`  found ${results.length} findings`);
  return results;
});

flux.expose("fact-check", async (payload: any) => {
  const { claim } = payload;
  console.log(`\n  fact-checking: "${claim.slice(0, 60)}..."`);
  await sleep(400);
  const confidence = 0.7 + Math.random() * 0.3;
  return {
    claim,
    verified: confidence > 0.8,
    confidence: Math.round(confidence * 100) / 100,
  };
});

await flux.start();
await flux.join("demo");

flux.on("peer:joined", (e) => console.log(`  + ${e.peerName} joined`));
flux.on("peer:left", (e) => console.log(`  - ${e.peerName} left`));
flux.on("ctx:updated", (e) => console.log(`  ctx "${e.key}" updated by ${e.peerName}`));

console.log("researcher online");
console.log("capabilities: research, fact-check");
console.log("workspace: demo\n");
console.log("waiting for work...");

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
