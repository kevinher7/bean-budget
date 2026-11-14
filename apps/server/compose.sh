#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

umask 077
mkdir -p .local
if [[ -z "${BEAN_TOKEN:-}" ]]; then
  if [[ ! -s .local/server-token ]]; then
    openssl rand -hex 32 > .local/server-token
  fi
  export BEAN_TOKEN="$(cat .local/server-token)"
fi
exec docker compose "$@"
