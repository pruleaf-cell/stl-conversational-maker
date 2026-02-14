#!/usr/bin/env bash
set -euo pipefail

REPO="${REPO:-pruleaf-cell/stl-conversational-maker}"

run_id=$(gh workflow run CI -R "$REPO" --json id --jq '.id' 2>/dev/null || true)
if [ -z "$run_id" ]; then
  # fallback for gh versions without --json support
  gh workflow run CI -R "$REPO"
  run_id=$(gh run list -R "$REPO" --workflow CI --limit 1 --json databaseId --jq '.[0].databaseId')
fi

echo "Watching run: $run_id"
gh run watch "$run_id" -R "$REPO" --interval 5
