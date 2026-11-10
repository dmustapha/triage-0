import { createQvacBackend } from "../src/backends/qvac.js";

const schema = {
  type: "object",
  properties: { page_id: { enum: ["choking", "seizure"] } },
  required: ["page_id"],
  additionalProperties: false,
};

const b = createQvacBackend({ model: "medpsy-1.7b", ctxSize: 2048 });
console.error("loading medpsy-1.7b ...");
await b.start();
const r = await b.complete({
  system: "You route emergencies to a page id. Answer with JSON only.",
  user: "she is coughing hard and cannot speak, holding her throat",
  jsonSchema: schema,
  maxTokens: 32,
  signal: new AbortController().signal,
});
console.log("parsed:", JSON.parse(r.text));
console.log("timing:", { ttftMs: r.ttftMs, totalMs: r.totalMs, tokensPerS: r.tokensPerS });
await b.stop();
process.exit(0);
