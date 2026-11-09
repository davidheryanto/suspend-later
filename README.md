# suspend-later

Suspend this machine after a delay — for leaving home while long jobs keep running.
Replaces `sleep 3600 && systemctl suspend` in a terminal with something you can see,
cancel and extend.

```
suspend-later 1h          # suspend in 1 hour (replaces any existing schedule)
suspend-later 90m         # also: 1h30m, 2.5h, 45 (bare number = minutes)
suspend-later 23:30       # at the next 23:30
suspend-later +30m        # extend (or schedule, if nothing is pending)
suspend-later cancel
suspend-later             # status: "Suspend scheduled at 15:24 (in 58m)."
suspend-later status --json
suspend-later 10s --dry-run   # log instead of suspending, to try it out
```

## Install

```
./install.sh   # symlinks bin/suspend-later into ~/.local/bin and extension/ into GNOME Shell
```

On Wayland a new extension loads after one logout/login. After that, `git pull` updates both;
extension changes still need a logout/login to load.

## Panel extension

A moon icon in the panel. While a suspend is scheduled it shows the countdown (`☾ 58m`); click
for the deadline, **Suspend in** 30m / 1h / 2h / 3h, **Extend** +15m / +30m / +1h / +2h, and **Cancel**.
It only runs the CLI with `--json` and draws the result. It re-reads as soon as systemd reports
the timer created or removed (so terminal/SSH changes show at once), plus every 30 s, when the menu
opens, after unlock and after resume, and counts down locally in between. A failed suspend
attempt turns it orange with the reason. A dry-run countdown is dimmed and italic; a real one is bright.

Smoke test without logging out: `dev/headless-capture.sh` (throwaway gnome-shell on Xvfb,
screenshot in `scratch/`).

Needs only systemd and `/usr/bin/python3` (both stock on Fedora).

## How it works

- A schedule is a transient systemd **user** timer, `suspend-later.timer`, that runs
  `systemctl suspend`. It survives closing the terminal and shows up in
  `systemctl --user list-timers`, so you can check or cancel it over SSH too.
- Set / extend replace the timer (stop + re-create), so there is only ever one.
- `AccuracySec=1s`, so it fires when the countdown says (systemd's default is a 1-minute window).
- **Sleeping early cancels the schedule.** The timer counts monotonic time, which pauses during
  suspend — left alone, a schedule from before you manually suspended would resume after wake
  and suspend you again. Each schedule records how long the machine had slept so far; if that
  has grown when the timer fires (or when `status` runs), the schedule is dropped instead.
- Logging out ends the user manager and the schedule with it — fine for "leaving the house".
- Firing log: `journalctl --user -u suspend-later.service`.

## Status JSON

```json
{"active": true, "deadline": "2026-11-09T16:06:37+08:00", "deadline_epoch": 1794211597.675,
 "remaining_seconds": 5400, "dry_run": false}
{"active": false}
```

Every command accepts `--json` and prints this status afterwards (`1h --json`, `cancel --json`).
`"error"` appears when the last suspend attempt failed. Consumers should count down from `deadline_epoch`
locally and re-poll occasionally, rather than spawning the CLI every second.
