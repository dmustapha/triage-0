#!/bin/bash
# triage-0 cleanup — kill all qvac workers, free model memory
# Run between sessions when the model gets slow.

set -e

echo "=== triage-0 cleanup ==="

# 1. Kill any triage-0 server processes
echo -n "Server processes: "
SERVERS=$(pgrep -f "tsx.*server.ts" 2>/dev/null || true)
if [ -n "$SERVERS" ]; then
  kill -15 $SERVERS 2>/dev/null || true
  sleep 1
  kill -9 $SERVERS 2>/dev/null || true
  echo "killed $(echo "$SERVERS" | wc -l | tr -d ' ')"
else
  echo "none"
fi

# 2. Kill qvac worker processes (these hold model weights in RAM)
echo -n "Qvac workers: "
QVAC=$(pgrep -f "qvac-worker" 2>/dev/null || true)
if [ -n "$QVAC" ]; then
  kill -15 $QVAC 2>/dev/null || true
  sleep 2
  kill -9 $QVAC 2>/dev/null || true
  echo "killed $(echo "$QVAC" | wc -l | tr -d ' ')"
else
  echo "none"
fi

# 3. Kill any zombie llama.cpp processes
echo -n "Llama processes: "
LLAMA=$(pgrep -f "llama" 2>/dev/null || true)
if [ -n "$LLAMA" ]; then
  kill -9 $LLAMA 2>/dev/null || true
  echo "killed $(echo "$LLAMA" | wc -l | tr -d ' ')"
else
  echo "none"
fi

# 4. Free inactive memory (macOS)
sudo purge 2>/dev/null && echo "Inactive memory purged" || echo "(sudo purge skipped — run manually if needed)"

# 5. Report
echo ""
echo "=== Memory freed ==="
echo "Next session should be fast again."
echo "Start server:  cd triage-0 && PORT=5070 npm start"
