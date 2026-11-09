# suspend-later

Suspend the machine after a delay. See README.md for usage and design.

- `bin/suspend-later`: single-file Python CLI (stdlib only). The only code that touches systemd.
  A schedule is the transient user timer `suspend-later.timer`.
- `extension/`: GNOME Shell panel icon. A thin UI: it only runs the CLI with `--json` and
  draws the result. It must never suspend, and never kill a CLI call (the CLI holds a lock
  while it changes the timer).

## Rules

- Keep it small. systemd is the source of truth; no state files.
- Test with `--dry-run`. Never trigger a real suspend.
- Run `suspend-later status` before scheduling a test. Any schedule replaces the current one,
  including a real one the owner set.
- Before asking for a logout/login, run `dev/headless-capture.sh` (it must print PASSED).
  It runs stock GNOME, so check panel layout changes in the real session too.

## Gotchas

- `systemctl --user list-timers <timer> -o json`: `next` is the deadline in realtime µs.
  Ignore `left`. `NextElapseUSecRealtime` is empty for `--on-active` timers.
- Sleep detection: `CLOCK_BOOTTIME - CLOCK_MONOTONIC` is total time slept since boot.
