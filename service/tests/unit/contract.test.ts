import { test } from "node:test";
import assert from "node:assert/strict";
import { RouteRequestSchema, RouteResponseSchema } from "../../src/contract.js";

test("RouteRequestSchema rejects whitespace-only text", () => {
  assert.equal(RouteRequestSchema.safeParse({ text: "  \n\t " }).success, false);
});
test("RouteRequestSchema rejects emoji-only text", () => {
  assert.equal(RouteRequestSchema.safeParse({ text: "😭😭" }).success, false);
});
test("RouteRequestSchema rejects 2001 chars and accepts 2000", () => {
  assert.equal(RouteRequestSchema.safeParse({ text: "a".repeat(2001) }).success, false);
  assert.equal(RouteRequestSchema.safeParse({ text: "a".repeat(2000) }).success, true);
});
test("RouteRequestSchema rejects an unknown age band", () => {
  assert.equal(RouteRequestSchema.safeParse({ text: "he fell", age_band: "teen" }).success, false);
});
test("RouteResponseSchema requires fallback and confidence", () => {
  assert.equal(RouteResponseSchema.safeParse({ candidates: [], next_question: null }).success, false);
});
