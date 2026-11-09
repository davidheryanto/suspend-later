#!/usr/bin/env bash
# Symlink the CLI into ~/.local/bin. The repo stays the source of truth; `git pull` updates it.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$HOME/.local/bin/suspend-later"

mkdir -p "$(dirname "$BIN")"
if [ -e "$BIN" ] && [ ! -L "$BIN" ]; then
    echo "Refusing: $BIN exists and is not a symlink. Remove it first." >&2
    exit 1
fi
ln -sfn "$SRC/bin/suspend-later" "$BIN"
echo "Linked $BIN -> $SRC/bin/suspend-later"
