<!-- File: data/protocols/README.md -->
# WHO Protocol Sources (real, citation-grounded)

Triage-0 grounds every recommendation in REAL World Health Organization field protocols, ingested
**live** at build time from their official born-digital PDFs. Triage-0 never fabricates citations —
the strings the judge sees are extracted verbatim from these public documents.

Both PDFs are **not committed** (gitignored, large). Fetch them before `npm run ingest`.

## 1. IMCI — child illness (`imci-chart-booklet.pdf`)
- **Document:** WHO Integrated Management of Childhood Illness (IMCI) Chart Booklet, **March 2014** (ISBN 978-92-4-150682-3).
- **Covers:** cough/fast breathing (pneumonia), general danger signs, diarrhoea/dehydration, fever, malnutrition — the child cases in the demo.
- **Official PDF (text-extractable, born-digital):** https://cdn.who.int/media/docs/default-source/mca-documents/child/imci-integrated-management-of-childhood-illness/imci-in-service-training/imci-chart-booklet.pdf
- **WHO publications page:** https://www.who.int/publications/m/item/integrated-management-of-childhood-illness---chart-booklet-(march-2014)
- Note: an older 473 KB copy on WHO IRIS is CID-encoded and NOT text-extractable — use the cdn.who.int file above.

## 2. mhGAP — mental health (`mhgap-intervention-guide.pdf`)
- **Document:** WHO mhGAP Intervention Guide v2.0 (ISBN 9789241549790, 2016).
- **Covers:** depression assessment, follow-up, referral — the adult mental-health case in the demo.
- **IRIS item:** https://iris.who.int/items/9c42b21c-dfc9-4c2b-b32d-e1caa5befbbc
- **Direct PDF:** https://iris.who.int/server/api/core/bitstreams/6ded7ffd-9d69-493a-b48a-0b3e6250c173/content

## Fetch both
```bash
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
curl -A "$UA" -L -o data/protocols/imci-chart-booklet.pdf \
  "https://cdn.who.int/media/docs/default-source/mca-documents/child/imci-integrated-management-of-childhood-illness/imci-in-service-training/imci-chart-booklet.pdf"
curl -A "$UA" -L -o data/protocols/mhgap-intervention-guide.pdf \
  "https://iris.who.int/server/api/core/bitstreams/6ded7ffd-9d69-493a-b48a-0b3e6250c173/content"
```

## Then ingest
```bash
npm run ingest    # PDF -> per-page text (pdf-parse, non-AI) -> normalize -> SDK chunk + 700-char cap
                  # -> embed (GTE_LARGE_FP16) -> native @qvac/rag store (~/.qvac/rag-hyperdb) -> reindex
```
~989 chunks (IMCI ~293 + mhGAP ~696). PDF→text is the only non-AI processing and is disclosed in
`remote-api-manifest.json`; zero AI inference calls leave the device. A grounding check confirms each
demo symptom query retrieves the correct WHO page above the 0.70 similarity threshold.

> The booklet's back-page recording forms use a CID font that extracts as glyph cipher; an
> English-quality filter drops those chunks so only real clinical prose is indexed. If a future
> WHO edition is fully scanned/image-only (pdf-parse empty), run QVAC OCR or curate the relevant
> chapters into a `[p.N | Section]` `.txt` (the ingest pipeline still supports that format).
