// File: src/rag/ingest.ts
// Real WHO protocol ingest: PDF -> per-page text (pdf-parse, non-AI) -> SDK chunker ->
// batch embed (GTE_LARGE_FP16) -> native ragSaveEmbeddings, with page-level citations.
// PDF->text is non-AI (disclosed in remote-api-manifest). Idempotent: resets the workspace.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { registry } from "../config.js";
import { loadModelTimed, unloadModelTimed, chunkText } from "../qvac/engine.js";
import { close, ragReindex } from "../qvac/sdk.js";
import { config } from "../config.js";
import { IngestChunk, resetWorkspace, saveChunks, chunkCount } from "./store.js";

// pdf-parse ships as CommonJS; load it via createRequire under ESM.
const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse") as (
  buf: Buffer,
  opts?: { pagerender?: (page: any) => Promise<string> },
) => Promise<{ text: string; numpages: number }>;

interface ProtocolSource {
  protocol: "IMCI" | "mhGAP";
  title: string; // human title used in every citation built from this document
  file: string; // path under data/protocols/
  format: "pdf" | "txt"; // txt = curated [p.N | Section] blocks (decision-tree 1.2)
}

const SOURCES: ProtocolSource[] = [
  // IMCI: the OFFICIAL WHO IMCI Chart Booklet, March 2014 (ISBN 978-92-4-150682-3) from
  // cdn.who.int — born-digital and text-extractable (verified with our own pdf-parse pipeline:
  // classification rows extract coherently and in correct reading order). Ingested live.
  // (The 473 KB IRIS copy we first tried was a different, CID-encoded, non-extractable file.)
  { protocol: "IMCI", title: "WHO IMCI Chart Booklet (2014)", file: "data/protocols/imci-chart-booklet.pdf", format: "pdf" },
  // mhGAP: WHO mhGAP Intervention Guide v2.0 — text-extractable PDF, ingested live.
  { protocol: "mhGAP", title: "WHO mhGAP Intervention Guide v2.0", file: "data/protocols/mhgap-intervention-guide.pdf", format: "pdf" },
];

interface RawBlock { page: number; section: string; text: string; }

/** pdf.js text extraction per page; pushes each page's text into `pages` in call order. */
function pageCapturer(pages: string[]) {
  return async (pageData: any): Promise<string> => {
    const tc = await pageData.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false });
    let lastY: number | undefined;
    let text = "";
    for (const item of tc.items as Array<{ str: string; transform: number[] }>) {
      if (lastY === item.transform[5] || lastY === undefined) text += item.str;
      else text += "\n" + item.str;
      lastY = item.transform[5];
    }
    pages.push(text);
    return text;
  };
}

const cleanSection = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 70);
const hasLexicalContent = (s: string) => (s.match(/[A-Za-z0-9]/g)?.length ?? 0) >= 25;

// Drop CID-glyph garbage (the booklet's back-page recording forms render as cipher text like
// "7HPSHUDWXUH"). Real clinical prose contains many common English/clinical words; garbage ~none.
const COMMON_WORDS =
  /\b(the|and|or|of|to|a|in|is|are|for|with|if|not|no|yes|child|give|days|sign|signs|fever|cough|see|ask|look|refer|treat|dose|per|minute|month|months|year|years|up|blood|skin|eyes|drink|breath|breathing|diarrhoea|severe)\b/gi;
export const looksLikeEnglish = (s: string) => (s.match(COMMON_WORDS)?.length ?? 0) >= 3;

/**
 * Detect CID-glyph cipher text (the booklet's recording-form pages extract as e.g. "7HPSHUDWXUH"
 * = Temperature, "$JH" = Age, ":HLJKW" = Weight). The tell is tokens where a digit/symbol is
 * immediately followed by a run of uppercase letters — vanishingly rare in real prose, ubiquitous
 * in the cipher. Reject a chunk whose cipher-token fraction is high. (ALL-CAPS real headers like
 * "SEVERE PNEUMONIA" do NOT match — no leading digit/symbol.)
 */
export function looksLikeCipher(s: string): boolean {
  const tokens = s.split(/\s+/).filter(Boolean);
  if (tokens.length < 4) return false;
  const cipher = tokens.filter((t) => /[0-9$&:;%#@/]\p{Lu}{2,}/u.test(t)).length;
  return cipher / tokens.length > 0.2;
}

export const usableChunk = (s: string) => hasLexicalContent(s) && looksLikeEnglish(s) && !looksLikeCipher(s);

/**
 * Repair born-digital chart-PDF extraction artifacts before chunking:
 * - rejoin line-broken words ("Count the\nbreaths" -> "Count the breaths") by collapsing whitespace,
 * - strip "Page x of y" footers (real text or glyph remnants),
 * - fix the °C glyph that pdf.js renders as "&" near temperatures.
 * Improves embedding quality without altering clinical wording.
 */
export function normalizePdfText(s: string): string {
  return s
    .replace(/Page\s*\d+\s*of\s*\d+/gi, " ")
    .replace(/(\d)\s*&\s*C\b/g, "$1°C")
    .replace(/\s+/g, " ")
    .trim();
}

/** Parse a curated `[p.N | Section]` text file into citation blocks. */
function parseTxtBlocks(raw: string): RawBlock[] {
  const lines = raw.split(/\r?\n/);
  const blocks: RawBlock[] = [];
  let cur: RawBlock | null = null;
  const marker = /^\[p\.(\d+)\s*\|\s*(.+?)\]\s*$/;
  for (const line of lines) {
    if (line.startsWith("#")) continue; // provenance comments
    const m = line.match(marker);
    if (m) {
      if (cur) blocks.push(cur);
      cur = { page: Number(m[1]), section: m[2].trim(), text: "" };
    } else if (cur) {
      cur.text += (cur.text ? "\n" : "") + line;
    }
  }
  if (cur) blocks.push(cur);
  return blocks.filter((b) => hasLexicalContent(b.text));
}

async function ingestTxt(src: ProtocolSource, abs: string, embedModelId: string): Promise<number> {
  const blocks = parseTxtBlocks(readFileSync(abs, "utf8"));
  process.stdout.write(`  parsed ${blocks.length} curated citation blocks\n`);
  if (blocks.length === 0) throw new Error(`No [p.N | Section] blocks found in ${src.file}.`);

  let inserted = 0;
  for (let b = 0; b < blocks.length; b++) {
    const blk = blocks[b];
    const chunks = await chunkText(blk.text);
    const items: IngestChunk[] = chunks
      .map((content, idx) => ({
        id: `${src.protocol}|p${blk.page}|b${b}c${idx}`,
        content: content.trim(),
        protocol: src.protocol,
        title: src.title,
        page: blk.page,
        section: blk.section, // the curated heading is the citation anchor
      }))
      .filter((c) => usableChunk(c.content));
    if (items.length) inserted += await saveChunks(embedModelId, items);
  }
  return inserted;
}

async function ingestPdf(src: ProtocolSource, abs: string, embedModelId: string): Promise<number> {
  const pages: string[] = [];
  const { numpages } = await pdfParse(readFileSync(abs), { pagerender: pageCapturer(pages) });
  const nonEmpty = pages.filter((p) => p.replace(/\s+/g, "").length > 80).length;
  process.stdout.write(`  parsed ${numpages} pages, ${nonEmpty} with text\n`);
  if (numpages < 1 || nonEmpty === 0) {
    throw new Error(
      `PDF extraction failed (numpages=${numpages}, nonEmptyPages=${nonEmpty}). ` +
      `Likely scanned/image-only or CID-encoded — see data/protocols/README.md decision tree (OCR or curated .txt).`,
    );
  }

  let inserted = 0;
  for (let i = 0; i < pages.length; i++) {
    const pageNo = i + 1;
    const pageText = normalizePdfText(pages[i]);
    if (!hasLexicalContent(pageText)) continue; // skip blank pages (SDK chunker rejects empty)
    const chunks = await chunkText(pageText);
    const items: IngestChunk[] = chunks
      .map((content, idx) => ({
        id: `${src.protocol}|p${pageNo}|c${idx}`,
        content: content.trim(),
        protocol: src.protocol,
        title: src.title,
        page: pageNo,
        section: cleanSection(content),
      }))
      // Require real, English-looking clinical prose; drops whitespace, TOC lines, CID-glyph garbage.
      .filter((c) => usableChunk(c.content));
    if (items.length) inserted += await saveChunks(embedModelId, items);
  }
  return inserted;
}

async function ingestSource(src: ProtocolSource, embedModelId: string): Promise<number> {
  const abs = resolve(process.cwd(), src.file);
  if (!existsSync(abs)) {
    throw new Error(`Missing source: ${src.file}. See data/protocols/README.md to fetch/restore it.`);
  }
  process.stdout.write(`Ingesting ${src.protocol} from ${src.file} (${src.format})\n`);
  const inserted = src.format === "txt"
    ? await ingestTxt(src, abs, embedModelId)
    : await ingestPdf(src, abs, embedModelId);
  process.stdout.write(`  ${src.protocol}: ${inserted} chunks ingested\n`);
  return inserted;
}

/** Full ingest. Loads embeddings, resets the workspace, processes both PDFs. */
export async function ingestAll(): Promise<{ total: number }> {
  await resetWorkspace();
  const { modelId: embedModelId } = await loadModelTimed(registry.embeddings, "ingest");
  let total = 0;
  try {
    for (const src of SOURCES) total += await ingestSource(src, embedModelId);
    // REQUIRED: build IVF centroids over the full corpus, else search recall is poor.
    const rr = await ragReindex(config.ragWorkspace);
    process.stdout.write(`  reindex: ${rr.reindexed ? "centroids built" : "skipped (<16 docs, exact search)"}\n`);
  } finally {
    await unloadModelTimed(embedModelId, "embeddings", "ingest");
    close();
  }
  process.stdout.write(`Done. Store now holds ${chunkCount()} chunks.\n`);
  return { total };
}
