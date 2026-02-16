#!/usr/bin/env bash
set -euo pipefail

REPO="${REPO:-pruleaf-cell/stl-conversational-maker}"

required=(
  RENDER_DEPLOY_HOOK_API
  RENDER_DEPLOY_HOOK_WORKER
  NEXT_PUBLIC_API_BASE_URL
)

for key in "${required[@]}"; do
  if [ -z "${!key:-}" ]; then
    echo "Missing required environment variable: $key" >&2
    exit 1
  fi
done

printf '%s' "${RENDER_DEPLOY_HOOK_API}" | gh secret set "RENDER_DEPLOY_HOOK_API" -R "$REPO"
echo "Set RENDER_DEPLOY_HOOK_API"

printf '%s' "${RENDER_DEPLOY_HOOK_WORKER}" | gh secret set "RENDER_DEPLOY_HOOK_WORKER" -R "$REPO"
echo "Set RENDER_DEPLOY_HOOK_WORKER"

gh variable set NEXT_PUBLIC_API_BASE_URL -R "$REPO" --body "${NEXT_PUBLIC_API_BASE_URL}"
echo "Set NEXT_PUBLIC_API_BASE_URL variable"

echo "Deployment secrets/variables configured for $REPO"
