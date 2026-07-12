#!/bin/bash
# Fix npm 11.6.2 corruption of @qvac native addon packages.
# npm 11.6.2 strips package.json, all JS files, and truncates prebuild binaries.
# This script recreates the missing pieces:
#   1. Fetches full packages from npm cache for llm-llamacpp + embed-llamacpp (critical)
#   2. Creates stub packages for non-critical addons (ocr, diffusion, parakeet, etc.)
#   3. Ensures proper ESM/CJS exports for all packages
#
# Run: bash scripts/fix-addon-packages.sh
set -e

NM="$(cd "$(dirname "$0")/.." && pwd)/node_modules/@qvac"
CACHE_HIT=false

# ── Phase 1: Restore critical addons from npm cache ──────────────────────────
restore_from_cache() {
  local pkg=$1 ver=$2
  local dir="$NM/$pkg"
  echo "=== Restoring @qvac/$pkg@$ver from cache ==="
  cd /tmp
  if npm pack --prefer-offline "@qvac/$pkg@$ver" 2>/dev/null; then
    local tgz=$(ls qvac-${pkg}-${ver}.tgz 2>/dev/null)
    if [ -n "$tgz" ]; then
      tar xzf "$tgz"
      cp package/binding.js package/addon.js package/addonLogging.js \
         package/addonLogging.d.ts package/index.js package/index.d.ts \
         package/package.json "$dir/" 2>/dev/null
      cp package/prebuilds/darwin-arm64/*.exports \
         "$dir/prebuilds/darwin-arm64/" 2>/dev/null
      # Also copy the full prebuild if the npm-installed one is truncated
      cp package/prebuilds/darwin-arm64/*.bare \
         "$dir/prebuilds/darwin-arm64/" 2>/dev/null
      cp -r package/lib "$dir/" 2>/dev/null
      rm -rf package qvac-*.tgz
      CACHE_HIT=true
      echo "✅ Restored from cache"
    fi
  else
    echo "⚠️  Not in cache — will create stub"
  fi
}

restore_from_cache "llm-llamacpp" "0.24.0"
restore_from_cache "embed-llamacpp" "0.19.1"
restore_from_cache "tts-ggml" "0.2.5"
restore_from_cache "bci-whispercpp" "0.2.0"

# ── Phase 2: Create stubs for remaining addons ────────────────────────────────
create_stub() {
  local pkg=$1
  local dir="$NM/$pkg"
  [ -f "$dir/binding.js" ] && [ -f "$dir/addonLogging.js" ] && [ -f "$dir/package.json" ] && return
  echo "Creating stub for @qvac/$pkg"

  # Non-functional binding (avoids loading corrupted .bare binary)
  cat > "$dir/binding.js" << 'JS'
module.exports = { setLogger() {}, releaseLogger() {} }
JS
  cat > "$dir/addonLogging.js" << 'JS'
module.exports = { setLogger() {}, releaseLogger() {} }
JS

  # Package.json with correct exports
  cat > "$dir/package.json" << JSON
{
  "name": "@qvac/$pkg",
  "addon": true,
  "engines": { "bare": ">=1.24.0" },
  "exports": {
    "./package": "./package.json",
    ".": "./index.js",
    "./addonLogging": "./addonLogging.js",
    "./addonLogging.js": "./addonLogging.js",
    "./addon.js": "./addon.js",
    "./binding.js": "./binding.js"
  }
}
JSON
}

# Non-critical addons — stubs are fine (Triage-0 doesn't use them)
for pkg in tts-ggml bci-whispercpp transcription-whispercpp \
           transcription-parakeet translation-nmtcpp \
           diffusion-cpp ocr-ggml vla-ggml; do
  create_stub "$pkg"
  # Create ESM-compatible index.js stubs
  case "$pkg" in
    diffusion-cpp)
      echo 'class ImgStableDiffusion {}; class EsrganUpscaler {}; class VideoStableDiffusion {}; module.exports = { ImgStableDiffusion, EsrganUpscaler, VideoStableDiffusion }' > "$dir/index.js"
      ;;
    ocr-ggml)
      echo 'class OcrGgml {}; module.exports = { OcrGgml }' > "$dir/index.js"
      ;;
    vla-ggml)
      echo 'class VlaModel {}; module.exports = { VlaModel }' > "$dir/index.js"
      ;;
    *)
      echo "class Stub {}; module.exports = Stub" > "$dir/index.js"
      ;;
  esac
done

# ── Phase 3: Verify ──────────────────────────────────────────────────────────
echo ""
echo "Verification:"
for pkg in llm-llamacpp embed-llamacpp tts-ggml bci-whispercpp \
           transcription-whispercpp transcription-parakeet translation-nmtcpp \
           diffusion-cpp ocr-ggml vla-ggml; do
  missing=""
  [ -f "$NM/$pkg/binding.js" ] || missing="$missing binding.js"
  [ -f "$NM/$pkg/addonLogging.js" ] || missing="$missing addonLogging.js"
  [ -f "$NM/$pkg/index.js" ] || missing="$missing index.js"
  [ -f "$NM/$pkg/package.json" ] || missing="$missing package.json"
  if [ -n "$missing" ]; then
    echo "❌ @qvac/$pkg missing:$missing"
  else
    echo "✅ @qvac/$pkg"
  fi
done

echo ""
if [ "$CACHE_HIT" = true ]; then
  echo "✅ Critical addons restored from cache. Run: PORT=3010 npm start"
else
  echo "⚠️  Cache miss for critical addons. The worker may fail to start."
  echo "   Try: MODEL_ID=4b PORT=3010 npm start (downloads model from HF)"
fi
echo ""
echo "To download the MedPsy model:"
echo "  mkdir -p .models"
echo "  curl -L -o .models/medpsy-1.7b-q4_k_m-imat.gguf \\"
echo "    https://huggingface.co/qvac/MedPsy-1.7B-GGUF/resolve/main/medpsy-1.7b-q4_k_m-imat.gguf"
echo ""
echo "Or use the 4B variant (auto-downloads from HF):"
echo "  MODEL_ID=4b PORT=3010 npm start"
