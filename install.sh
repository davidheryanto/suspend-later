#!/usr/bin/env bash
# Symlink the CLI into ~/.local/bin and the extension into GNOME Shell.
# The repo stays the source of truth; `git pull` updates both.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UUID="suspend-later@davidheryanto"

link() {  # link <target> <link-path>
    mkdir -p "$(dirname "$2")"
    if [ -e "$2" ] && [ ! -L "$2" ]; then
        echo "Refusing: $2 exists and is not a symlink. Remove it first." >&2
        exit 1
    fi
    ln -sfn "$1" "$2"
    echo "Linked $2 -> $1"
}

link "$SRC/bin/suspend-later" "$HOME/.local/bin/suspend-later"
link "$SRC/extension" "$HOME/.local/share/gnome-shell/extensions/$UUID"

gnome-extensions enable "$UUID" 2>/dev/null \
    && echo "Enabled $UUID." \
    || echo "On Wayland, log out and back in once, then: gnome-extensions enable $UUID"
