#!/usr/bin/env bash
# Everything a box needs to be a place you can work from.
# Idempotent: safe to re-run.
set -euo pipefail
log() { echo "[box] $*" >&2; }

export DEBIAN_FRONTEND=noninteractive
log "base packages"
sudo apt-get update -qq
sudo apt-get install -y -qq git curl jq ripgrep build-essential ca-certificates >/dev/null

# Node 22 via NodeSource — the runtime the dev servers will actually use.
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1)" != "v22" ]; then
  log "node 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null 2>&1
  sudo apt-get install -y -qq nodejs >/dev/null
fi

# herdr — the thing that holds the terminals open. Pinned to the version the
# LOCAL client speaks: client and server negotiate a protocol number and a
# mismatch fails the attach with a message that does not say so.
HERDR_VERSION="${HERDR_VERSION:-0.8.2}"
mkdir -p "$HOME/.local/bin"
if [ "$("$HOME/.local/bin/herdr" --version 2>/dev/null | awk '{print $2}')" != "$HERDR_VERSION" ]; then
  log "herdr $HERDR_VERSION"
  curl -fsSL -o /tmp/herdr \
    "https://github.com/herdrdev/herdr/releases/download/v${HERDR_VERSION}/herdr-linux-x86_64"
  chmod +x /tmp/herdr
  mv /tmp/herdr "$HOME/.local/bin/herdr"
fi

log "claude code"
sudo npm install -g @anthropic-ai/claude-code >/dev/null 2>&1 || log "claude code install failed (not fatal)"

grep -q '.local/bin' "$HOME/.bashrc" || echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"

log "versions"
node -v; "$HOME/.local/bin/herdr" --version; (claude --version 2>/dev/null || echo "claude: not installed")
