# suspend-later — agent context

Personal tool: schedule a delayed `systemctl suspend` on the owner's Fedora 42 / GNOME 48
desktop, so long jobs (e.g. Claude Code) keep running after they leave home.

## Shape
- `bin/suspend-later` — single-file Python CLI (stdlib only, `/usr/bin/python3`). The **only**
  thing that touches systemd. Schedule = transient user timer `suspend-later.timer` running
  `bin/suspend-later _fire <sleep-offset>`.
- `extension/` — GNOME Shell panel indicator (UUID `suspend-later@davidheryanto`) that only
  spawns the CLI with `--json` and draws the result (same pattern as `../codexbar-gnome`). Must
  stay a thin UI: no timers of its own that suspend, so a broken/disabled extension never loses
  or fires a schedule. Status reads are skipped while an action is in flight (race).
- `dev/headless-capture.sh` — throwaway gnome-shell on Xvfb; gate before any logout/login.
  It runs stock GNOME, not Dash to Panel — see `../codexbar-gnome/CLAUDE.md` gotchas
  (D2P flips vertical `St.BoxLayout`s; lock screen disables/enables extensions).

## Rules
1. Keep it small and boring. systemd is the source of truth; no state files.
2. **Never run a real suspend while testing** — use `--dry-run` (the fire step logs instead).
   `_fire 0 --dry-run` exercises the stale-after-sleep guard (the machine has slept since boot).
3. Sleep guard: `CLOCK_BOOTTIME - CLOCK_MONOTONIC` = seconds slept since boot. Recorded at
   schedule time in the ExecStart args; if it grew by > 5 s, the schedule is stale and dropped.

## Status (2026-11-09)
- CLI done and dry-run tested (schedule/extend/clock/cancel/fire/stale guard/failed fire).
- Extension passes headless smoke test and is live in the real session (D2P panel): countdown
  shows immediately for a CLI-made schedule (systemd UnitNew/UnitRemoved listener, verified
  live 2026-11-09). Menu buttons (+15m, Cancel) verified live. Stale-after-manual-suspend verified live: resume
  16:21:37, the extension's post-wake status read stopped the old timer at 16:21:44.
- **Real suspend verified 2026-11-09:** `suspend-later 10s` → "Suspend accepted by logind." →
  kernel `PM: suspend entry (deep)`, manual wake, `status` clean afterwards. gnome-session's
  `block` sleep inhibitor ("user session inhibited") did not interfere.
- The `systemd-sleep` warning "User sessions remain unfrozen on explicit request" comes from the
  NVIDIA driver setup (`SYSTEMD_SLEEP_FREEZE_USER_SESSIONS=0`), not from this tool.

## Verified facts
- `systemctl --user list-timers <timer> -o json` → `next` is the deadline in **realtime µs**
  (the `left` field is not a duration — ignore it). `NextElapseUSecRealtime` is empty for
  `--on-active` timers.
- A `systemd-run --user` service is polkit-authorized for `org.freedesktop.login1.suspend`
  (checked with `pkcheck`), same as an interactive terminal (both live in `user@1000.service`).
  `suspend-ignore-inhibit` is NOT authorized from either.
- GNOME automatic suspend on AC is `'nothing'` on this machine, so no idle inhibitor is needed.
