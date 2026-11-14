#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# A stable development credential survives server restarts; never print it.
umask 077
mkdir -p .local
if [[ -z "${BEAN_TOKEN:-}" ]]; then
  if [[ ! -s .local/server-token ]]; then
    openssl rand -hex 32 > .local/server-token
  fi
  export BEAN_TOKEN="$(cat .local/server-token)"
fi
export BEAN_DATABASE="${BEAN_DATABASE:-$PWD/.local/bean-budget.sqlite}"
exec node_modules/.bin/tsx watch apps/server/src/main.ts
