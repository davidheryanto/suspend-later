// suspend-later — a thin GNOME Shell panel front-end for the `suspend-later` CLI.
//
// The schedule lives in a systemd user timer that the CLI owns. This extension only
// spawns the CLI (`status --json`, `<duration> --json`, `cancel --json`) and draws the
// result, counting down locally from `deadline_epoch` between polls. It never suspends
// anything itself, so disabling or breaking it can neither lose nor fire a schedule.

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const POLL_SECONDS = 30;           // re-read the timer (catches CLI/SSH changes)
const CLI_TIMEOUT_SECONDS = 15;
const PRESETS = ['30m', '1h', '2h', '3h'];
const EXTENDS = ['+15m', '+30m', '+1h'];

function findCli() {
    return GLib.find_program_in_path('suspend-later') ??
        [`${GLib.get_home_dir()}/.local/bin/suspend-later`]
            .find(p => GLib.file_test(p, GLib.FileTest.IS_EXECUTABLE)) ?? null;
}

// Seconds -> "1h05m" / "12m" / "45s" (panel label).
function fmtLeft(sec) {
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (h)
        return `${h}h${String(m).padStart(2, '0')}m`;
    if (m)
        return `${m}m`;
    return `${sec}s`;
}

function fmtClock(epoch) {
    return GLib.DateTime.new_from_unix_local(Math.floor(epoch)).format('%H:%M');
}

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.5, 'Suspend Later');
        this._ext = ext;

        const box = new St.BoxLayout({style_class: 'suspend-later-panel'});
        this._icon = new St.Icon({icon_name: 'weather-clear-night-symbolic', style_class: 'system-status-icon'});
        this._label = new St.Label({y_align: Clutter.ActorAlign.CENTER, visible: false});
        box.add_child(this._icon);
        box.add_child(this._label);
        this.add_child(box);

        this._header = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._header.label.add_style_class_name('suspend-later-header');
        this.menu.addMenuItem(this._header);
        this._note = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._note.label.add_style_class_name('suspend-later-note');
        this._note.label.clutter_text.line_wrap = true;
        this.menu.addMenuItem(this._note);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._presetRow = this._buttonRow('Suspend in', PRESETS);
        this._extendRow = this._buttonRow('Extend', EXTENDS);
        this.menu.addMenuItem(this._presetRow);
        this.menu.addMenuItem(this._extendRow);

        this._cancelItem = new PopupMenu.PopupMenuItem('Cancel scheduled suspend');
        this._cancelItem.connect('activate', () => ext.run(['cancel']));
        this.menu.addMenuItem(this._cancelItem);

        this.menu.connect('open-state-changed', (_m, open) => {
            if (open)
                ext.refresh();
        });
    }

    _buttonRow(title, args) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        item.add_child(new St.Label({
            text: title, y_align: Clutter.ActorAlign.CENTER, style_class: 'suspend-later-row-title',
        }));
        const buttons = new St.BoxLayout({x_expand: true, style_class: 'suspend-later-buttons'});
        for (const arg of args) {
            const b = new St.Button({label: arg, style_class: 'button suspend-later-button', can_focus: true});
            b.connect('clicked', () => this._ext.run([arg]));
            buttons.add_child(b);
        }
        item.add_child(buttons);
        return item;
    }

    // Repaint from the last status; called on every result and every second while active.
    render(st) {
        this.remove_style_class_name('suspend-later-active');
        this.remove_style_class_name('suspend-later-error');
        this._note.visible = false;

        if (st?.fatal) {
            this.add_style_class_name('suspend-later-error');
            this._label.visible = false;
            this._header.label.text = 'suspend-later unavailable';
            this._note.label.text = st.fatal;
            this._note.visible = true;
            this._presetRow.visible = this._extendRow.visible = this._cancelItem.visible = false;
            return;
        }

        const active = Boolean(st?.active);
        this._extendRow.visible = this._cancelItem.visible = active;
        this._presetRow.visible = true;

        if (active) {
            const left = st.deadline_epoch - Date.now() / 1000;
            this.add_style_class_name('suspend-later-active');
            this._label.text = fmtLeft(left);
            this._label.visible = true;
            const dry = st.dry_run ? '  (dry run)' : '';
            this._header.label.text = `Suspends at ${fmtClock(st.deadline_epoch)}, in ${fmtLeft(left)}${dry}`;
        } else {
            this._label.visible = false;
            this._header.label.text = 'No suspend scheduled';
        }

        const note = st?.error ?? st?.note;
        if (note) {
            if (st.error)
                this.add_style_class_name('suspend-later-error');
            this._note.label.text = note;
            this._note.visible = true;
        }
    }
});

export default class SuspendLaterExtension extends Extension {
    enable() {
        this._status = null;
        this._seq = 0;          // only the newest CLI call's result is applied
        this._procs = new Set();
        this._actions = 0;      // schedule/cancel calls in flight
        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        // Re-read on enable (this also runs after unlock, since GNOME disables
        // extensions on the lock screen) and after resume — that read is what makes
        // the CLI drop a schedule left over from before a manual suspend.
        this.refresh();
        this._pollId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_SECONDS, () => {
            this.refresh();
            return GLib.SOURCE_CONTINUE;
        });
        this._sleepId = Gio.DBus.system.signal_subscribe(
            'org.freedesktop.login1', 'org.freedesktop.login1.Manager', 'PrepareForSleep',
            '/org/freedesktop/login1', null, Gio.DBusSignalFlags.NONE,
            (_c, _s, _p, _i, _n, params) => {
                const [goingToSleep] = params.deep_unpack();
                if (!goingToSleep)
                    this.refresh();
            });
        // Dev only, inert by default: dev/headless-capture.sh sets this to auto-open the menu.
        const autoOpen = parseInt(GLib.getenv('SUSPEND_LATER_DEBUG_OPEN') ?? '', 10);
        if (autoOpen) {
            this._debugId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, autoOpen, () => {
                this._debugId = 0;
                this._indicator?.menu.open();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    disable() {
        for (const id of [this._pollId, this._tickId, this._debugId])
            if (id)
                GLib.Source.remove(id);
        this._pollId = this._tickId = this._debugId = 0;
        if (this._sleepId)
            Gio.DBus.system.signal_unsubscribe(this._sleepId);
        this._sleepId = 0;
        // Only aborts reads of status/actions in flight; a schedule change the CLI
        // already started completes on its own, which is fine.
        for (const p of this._procs)
            p.force_exit();
        this._procs.clear();
        this._indicator?.destroy();
        this._indicator = null;
        this._status = null;
    }

    refresh() {
        // A status read racing an in-flight action could report the pre-action state
        // and supersede the action's own (fresher) result, so skip it.
        if (!this._actions)
            this.run(['status']);
    }

    run(args) {
        const cli = findCli();
        if (!cli) {
            this._apply({fatal: 'suspend-later CLI not found on PATH or in ~/.local/bin (run install.sh)'});
            return;
        }
        const seq = ++this._seq;
        const isAction = args[0] !== 'status';
        let proc;
        try {
            proc = Gio.Subprocess.new([cli, ...args, '--json'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            this._apply({fatal: `could not run suspend-later: ${e.message}`});
            return;
        }
        this._procs.add(proc);
        if (isAction)
            this._actions++;
        const watchdog = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, CLI_TIMEOUT_SECONDS, () => {
            proc.force_exit();
            return GLib.SOURCE_REMOVE;
        });
        proc.communicate_utf8_async(null, null, (p, res) => {
            GLib.Source.remove(watchdog);
            if (isAction)
                this._actions--;
            if (!this._procs.delete(p) || !this._indicator)
                return; // disabled meanwhile
            let stdout = '', stderr = '';
            try {
                [, stdout, stderr] = p.communicate_utf8_finish(res);
            } catch (e) {
                stderr = e.message;
            }
            if (seq !== this._seq)
                return; // a newer call superseded this one
            try {
                this._apply(JSON.parse(stdout));
            } catch {
                this._apply({fatal: (stderr || stdout || 'no output').trim()});
            }
        });
    }

    _apply(status) {
        this._status = status;
        this._indicator.render(status);
        // Tick once a second only while a countdown is showing.
        if (status?.active && !this._tickId) {
            this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                const st = this._status;
                if (!st?.active) {
                    this._tickId = 0;
                    return GLib.SOURCE_REMOVE;
                }
                if (st.deadline_epoch - Date.now() / 1000 <= 0) {
                    this.refresh(); // fired (or about to): let the CLI say what happened
                    st.active = false;
                }
                this._indicator.render(st);
                return GLib.SOURCE_CONTINUE;
            });
        }
    }
}
