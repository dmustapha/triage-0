// File: tests/unit/egress-host.test.ts
// MODEL-FREE. Pins isExternalHost — the single predicate the offline-egress proof depends on. A false
// negative here would let a real external connection slip past the guard unrecorded (the headline thesis
// is "the patient's data never leaves the device"), so the loopback/unix-socket allow-list and the
// "everything else is external" rule are tested exhaustively. Pure function: no guard arming, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isExternalHost } from "../../src/qvac/egress-guard.js";

test("loopback + IPC + empty are NOT external (allowed)", () => {
  // No host (unix socket / pathless connect).
  assert.equal(isExternalHost(undefined), false);
  assert.equal(isExternalHost(null), false);
  assert.equal(isExternalHost(""), false);
  // Loopback names + addresses.
  assert.equal(isExternalHost("localhost"), false);
  assert.equal(isExternalHost("LOCALHOST"), false, "case-insensitive");
  assert.equal(isExternalHost("127.0.0.1"), false);
  assert.equal(isExternalHost("127.0.0.53"), false, "any 127.x loopback");
  assert.equal(isExternalHost("::1"), false);
  assert.equal(isExternalHost("0.0.0.0"), false);
  assert.equal(isExternalHost("::"), false);
  // Unix-domain socket paths.
  assert.equal(isExternalHost("/tmp/qvac.sock"), false);
  assert.equal(isExternalHost("/var/run/some.socket"), false, "leading slash = unix path");
  assert.equal(isExternalHost("qvac.sock"), false, "contains .sock");
});

test("any non-loopback host IS external (recorded as a violation)", () => {
  assert.equal(isExternalHost("huggingface.co"), true);
  assert.equal(isExternalHost("8.8.8.8"), true);
  assert.equal(isExternalHost("example.com"), true);
  assert.equal(isExternalHost("api.openai.com"), true);
  // Near-loopback decoys that are NOT loopback must still count as external.
  assert.equal(isExternalHost("128.0.0.1"), true, "128.x is not 127.x");
  assert.equal(isExternalHost("10.0.0.5"), true, "private LAN is still off-device egress");
  assert.equal(isExternalHost("localhost.evil.com"), true, "not exactly 'localhost'");
});
