#!/usr/bin/env node
// postinstall patch: @qvac/sdk declares zod ^4.3.0 but our project uses zod v3.
// The SDK's download-asset.js calls z.url() — a zod v4 API that doesn't exist in v3.
// We patch it to z.string().url() which exists in both.
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "node_modules", "@qvac", "sdk", "dist", "schemas", "download-asset.js");

try {
  let content = readFileSync(target, "utf8");
  if (content.includes("z.string().url()")) {
    process.stdout.write("[triage-0] @qvac/sdk download-asset.js already patched\n");
  } else {
    const patched = content.replace(/\bz\.url\(\)/g, "z.string().url()");
    if (patched !== content) {
      writeFileSync(target, patched, "utf8");
      process.stdout.write("[triage-0] patched @qvac/sdk download-asset.js: z.url() → z.string().url()\n");
    } else {
      process.stdout.write("[triage-0] @qvac/sdk download-asset.js: pattern not found — may already be fixed\n");
    }
  }
} catch (err) {
  if (err.code !== "ENOENT") process.stderr.write(`[triage-0] patch-sdk-zod: ${err.message}\n`);
}
