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

const POLL_SECONDS = 30;           // fallback re-read; changes normally arrive via D-Bus
const UNIT_PREFIX = 'suspend-later.';
const PRESETS = ['30m', '1h', '2h', '3h'];
const EXTENDS = ['+15m', '+30m', '+1h', '+2h'];

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

// Deadline as a clock time, following GNOME's clock-format setting (12h -> "5:10 PM").
let interfaceSettings = null;
function fmtClock(epoch) {
    interfaceSettings ??= new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    const fmt = interfaceSettings.get_string('clock-format') === '12h' ? '%-l:%M %p' : '%H:%M';
    return GLib.DateTime.new_from_unix_local(Math.floor(epoch)).format(fmt);
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

        // Header: deadline text, with Cancel beside it while a schedule is active.
        this._header = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this._header.label = new St.Label({
            x_expand: true, y_align: Clutter.ActorAlign.CENTER, style_class: 'suspend-later-header',
        });
        this._cancelButton = new St.Button({
            label: 'Cancel', can_focus: true, style_class: 'button suspend-later-button suspend-later-cancel',
        });
        this._cancelButton.connect('clicked', () => ext.run(['cancel']));
        this._header.add_child(this._header.label);
        this._header.add_child(this._cancelButton);
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
            this._presetRow.visible = this._extendRow.visible = this._cancelButton.visible = false;
            return;
        }

        const active = Boolean(st?.active);
        this._extendRow.visible = this._cancelButton.visible = active;
        this._presetRow.visible = true;

        if (active) {
            const left = st.deadline_epoch - Date.now() / 1000;
            this.add_style_class_name('suspend-later-active');
            // Dim the countdown for a dry run: bright = a real suspend is armed.
            if (st.dry_run)
                this._label.add_style_class_name('suspend-later-dry');
            else
                this._label.remove_style_class_name('suspend-later-dry');
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
        this._procs = new Map();   // proc -> isAction, for this enable() lifecycle
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
        this._watchUnits();
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
        for (const id of [this._pollId, this._tickId, this._debugId, this._unitDebounceId])
            if (id)
                GLib.Source.remove(id);
        this._pollId = this._tickId = this._debugId = this._unitDebounceId = 0;
        if (this._unitsId)
            Gio.DBus.session.signal_unsubscribe(this._unitsId);
        this._unitsId = 0;
        if (this._sleepId)
            Gio.DBus.system.signal_unsubscribe(this._sleepId);
        this._sleepId = 0;
        // Never kill a CLI call, not even a status read: status can cancel a stale
        // schedule, and killing it midway would release the CLI's lock with a
        // `systemctl stop` still on its way. Let calls finish; their callbacks see they
        // belong to an old lifecycle and do nothing.
        this._procs = new Map();
        this._actions = 0;
        this._indicator?.destroy();
        this._indicator = null;
        this._status = null;
    }

    // React at once when the CLI (terminal, SSH) creates or removes our timer/service,
    // instead of waiting for the next poll. The systemd user manager only emits
    // UnitNew/UnitRemoved to clients that called Subscribe(); calling it again is harmless.
    _watchUnits() {
        const bus = Gio.DBus.session;
        bus.call('org.freedesktop.systemd1', '/org/freedesktop/systemd1',
            'org.freedesktop.systemd1.Manager', 'Subscribe', null, null,
            Gio.DBusCallFlags.NONE, -1, null, (c, res) => {
                try {
                    c.call_finish(res);
                } catch {} // no user manager on this bus (e.g. headless test): polling still works
            });
        const onUnit = (_c, _s, _p, _i, _n, params) => {
            const [id] = params.deep_unpack();
            if (!String(id).startsWith(UNIT_PREFIX))
                return;
            // One schedule change is a burst (stop + start of timer and service): debounce.
            if (this._unitDebounceId)
                GLib.Source.remove(this._unitDebounceId);
            this._unitDebounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                this._unitDebounceId = 0;
                this.refresh();
                return GLib.SOURCE_REMOVE;
            });
        };
        this._unitsId = bus.signal_subscribe('org.freedesktop.systemd1',
            'org.freedesktop.systemd1.Manager', null, '/org/freedesktop/systemd1', null,
            Gio.DBusSignalFlags.NONE, (c, s, p, i, name, params) => {
                if (name === 'UnitNew' || name === 'UnitRemoved')
                    onUnit(c, s, p, i, name, params);
            });
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
        const isAction = args[0] !== 'status';
        // One action at a time, so clicks can't run out of order (e.g. a Cancel landing
        // before the schedule clicked just before it). Actions take a fraction of a second.
        if (isAction && this._actions)
            return;
        const seq = ++this._seq;
        let proc;
        try {
            proc = Gio.Subprocess.new([cli, ...args, '--json'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            this._apply({fatal: `could not run suspend-later: ${e.message}`});
            return;
        }
        const procs = this._procs;
        procs.set(proc, isAction);
        if (isAction)
            this._actions++;
        // No kill-on-timeout either (see disable()). A stuck status read only delays
        // its own result; polls and signals start fresh reads regardless.
        proc.communicate_utf8_async(null, null, (p, res) => {
            // Ignore a callback from an earlier enable() lifecycle (disabled meanwhile)
            // before touching any counters of the current one.
            if (procs !== this._procs || !procs.delete(p) || !this._indicator)
                return;
            if (isAction)
                this._actions--;
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
