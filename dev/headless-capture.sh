#!/usr/bin/env bash
# Headless smoke-test + screenshot for the suspend-later extension.
#
# Runs a throwaway GNOME Shell 48 on a virtual X display, fully isolated from
# your live session (private session bus via dbus-run-session + its own Xvfb
# display). It loads this extension from its installed symlink, auto-opens the
# dropdown, captures a screenshot, and reports whether the extension came up
# ACTIVE with no JS errors. Nothing touches your real GNOME session.
#
# This is the fast inner loop: it catches load/parse/render errors WITHOUT a
# logout/login. (Wayland still needs one logout/login to load a *new* version
# into your real session — see TESTING.md.)
#
# Requires: Xvfb, gnome-shell, ImageMagick (`import`), dbus-run-session.
# Usage:    dev/headless-capture.sh [output_dir]    (default: <repo>/scratch, gitignored)
#           CYCLE=1 dev/headless-capture.sh          also disable+re-enable the extension
#                                                    after it settles (what the lock screen
#                                                    does) and shoot 1s after re-enable, so
#                                                    the shot can only be the remembered data
set -uo pipefail

UUID="suspend-later@davidheryanto"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${1:-$REPO/scratch}"
SIZE="820x700"          # tall enough for the full two-provider dropdown
OPEN_AFTER=${CYCLE:+1}   # seconds after enable() to auto-open the dropdown
OPEN_AFTER=${OPEN_AFTER:-10}   # (1s in CYCLE mode so the re-enabled menu opens at once)
SETTLE=17               # seconds to let the shell start + open the menu
STAMP="$(date +%Y%m%d-%H%M%S)"
GS_LOG="/tmp/suspend-later-headless-gs.log"
PNG="$OUT_DIR/dropdown-$STAMP.png"
STATE_FILE="/tmp/suspend-later-headless-state-$STAMP.txt"

# Pick a free X display so we never collide with — or later kill — someone
# else's Xvfb. (We then track only the PIDs we spawn; no pattern-based pkill.)
DISP=""
for n in $(seq 99 120); do
    [ -e "/tmp/.X${n}-lock" ] || { DISP=":$n"; break; }
done
[ -n "$DISP" ] || { echo "no free X display in :99..:120" >&2; exit 1; }
GS_PIDFILE="/tmp/suspend-later-headless-gs-$STAMP.pid"

for bin in Xvfb gnome-shell import dbus-run-session; do
    command -v "$bin" >/dev/null || { echo "missing required tool: $bin" >&2; exit 1; }
done
mkdir -p "$OUT_DIR"

cleanup() {
    # Kill only the processes this script started, by tracked PID — never a
    # broad pattern that could match another session's gnome-shell or Xvfb.
    [ -f "$GS_PIDFILE" ] && kill -9 "$(cat "$GS_PIDFILE")" 2>/dev/null || true
    [ -n "${XVFB_PID:-}" ] && kill -9 "$XVFB_PID" 2>/dev/null || true
    rm -f "$GS_PIDFILE" "$STATE_FILE" "/tmp/.X${DISP#:}-lock" 2>/dev/null || true
}
trap cleanup EXIT

# Start a fresh virtual X server on the free display chosen above.
Xvfb "$DISP" -screen 0 "${SIZE}x24" -nolisten tcp >/tmp/suspend-later-headless-xvfb.log 2>&1 &
XVFB_PID=$!
sleep 3

# Run gnome-shell on the virtual display under a private session bus, so its
# org.gnome.Shell name never collides with the real session. gnome-extensions
# is queried on that same private bus to read the real load state.
DISPLAY="$DISP" SUSPEND_LATER_DEBUG_OPEN="$OPEN_AFTER" timeout 60 dbus-run-session -- bash -c "
    export DISPLAY='$DISP'
    gnome-shell --x11 >'$GS_LOG' 2>&1 &
    GS=\$!
    echo \$GS > '$GS_PIDFILE'
    sleep $SETTLE
    if [ -n '${CYCLE:-}' ]; then
        echo '=== disable/enable cycle ==='
        gnome-extensions disable '$UUID' && sleep 1 && gnome-extensions enable '$UUID' && sleep 2
    fi
    echo '=== extension state ==='
    gnome-extensions info '$UUID' > '$STATE_FILE' 2>&1 || true
    grep -E 'Enabled|State' '$STATE_FILE' || echo '  (extension not reported)'
    echo '=== capture ==='
    import -window root '$PNG' 2>&1 && echo \"saved $PNG\" || echo 'capture failed'
    kill \$GS 2>/dev/null || true
"

# The capture canvas is sized tall to fit the open dropdown, so most shots have a
# big empty desktop above the content. Crop down to the content (dropdown + panel)
# and leave a small margin — no point keeping the dead background.
if [ -f "$PNG" ] && command -v magick >/dev/null; then
    BG='srgb(36,40,48)'   # the throwaway session's desktop background
    magick "$PNG" -bordercolor "$BG" -border 1 -fuzz 8% -trim +repage \
        -bordercolor "$BG" -border 20 "$PNG" 2>/dev/null && echo "cropped to content"
fi

echo "=== JS errors from our extension (if any) ==="
grep -iE "suspend-later.*(error|exception)|JS ERROR.*suspend-later" "$GS_LOG" 2>/dev/null | grep -iv "no version information" | head -10 \
    || true

echo
echo "Screenshot: $PNG"
echo "Shell log:  $GS_LOG"

# This is the pre-logout gate (see TESTING.md), so it must fail hard rather than
# print a worry and exit 0. Pass only if all three hold: the extension came up
# ACTIVE, a screenshot was captured, and no JS error from *our* extension shows
# in the shell log.
FAIL=0
if ! grep -q "State: ACTIVE" "$STATE_FILE" 2>/dev/null; then
    echo "FAIL: extension is not ACTIVE (see state above)" >&2
    FAIL=1
fi
if [ ! -s "$PNG" ]; then
    echo "FAIL: no screenshot captured ($PNG)" >&2
    FAIL=1
fi
if grep -iqE "JS ERROR.*suspend-later|suspend-later.*TypeError" "$GS_LOG" 2>/dev/null; then
    echo "FAIL: JS errors from the extension (see $GS_LOG)" >&2
    FAIL=1
fi

echo
if [ "$FAIL" -ne 0 ]; then
    echo "RESULT: FAILED" >&2
    exit 1
fi
echo "RESULT: PASSED — extension ACTIVE, screenshot captured, no JS errors"
