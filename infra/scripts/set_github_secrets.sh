#!/usr/bin/env bash
set -euo pipefail

REPO="${REPO:-pruleaf-cell/stl-conversational-maker}"

required=(
  VERCEL_TOKEN
  VERCEL_ORG_ID
  VERCEL_PROJECT_ID
  RENDER_DEPLOY_HOOK_API
  RENDER_DEPLOY_HOOK_WORKER
)

for key in "${required[@]}"; do
  if [ -z "${!key:-}" ]; then
    echo "Missing required environment variable: $key" >&2
    exit 1
  fi
done

for key in "${required[@]}"; do
  printf '%s' "${!key}" | gh secret set "$key" -R "$REPO"
  echo "Set $key"
done

echo "All deployment secrets configured for $REPO"
