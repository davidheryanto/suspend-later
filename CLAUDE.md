# suspend-later — agent context

Personal tool: schedule a delayed `systemctl suspend` on the owner's Fedora 42 / GNOME 48
desktop, so long jobs (e.g. Claude Code) keep running after they leave home.

## Shape
- `bin/suspend-later` — single-file Python CLI (stdlib only, `/usr/bin/python3`). The **only**
  thing that touches systemd. Schedule = transient user timer `suspend-later.timer` running
  `bin/suspend-later _fire <sleep-offset>`.
- Planned: `extension/` — GNOME Shell panel indicator that only spawns the CLI and parses
  `status --json` (same pattern as `../codexbar-gnome`). Must stay a thin UI: no timers of its
  own that suspend, so a broken/disabled extension never loses or fires a schedule.

## Rules
1. Keep it small and boring. systemd is the source of truth; no state files.
2. **Never run a real suspend while testing** — use `--dry-run` (the fire step logs instead).
   `_fire 0 --dry-run` exercises the stale-after-sleep guard (the machine has slept since boot).
3. Sleep guard: `CLOCK_BOOTTIME - CLOCK_MONOTONIC` = seconds slept since boot. Recorded at
   schedule time in the ExecStart args; if it grew by > 5 s, the schedule is stale and dropped.

## Verified facts
- `systemctl --user list-timers <timer> -o json` → `next` is the deadline in **realtime µs**
  (the `left` field is not a duration — ignore it). `NextElapseUSecRealtime` is empty for
  `--on-active` timers.
- A `systemd-run --user` service is polkit-authorized for `org.freedesktop.login1.suspend`
  (checked with `pkcheck`), same as an interactive terminal (both live in `user@1000.service`).
  `suspend-ignore-inhibit` is NOT authorized from either.
- GNOME automatic suspend on AC is `'nothing'` on this machine, so no idle inhibitor is needed.
