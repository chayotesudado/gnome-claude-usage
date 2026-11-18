import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';

import {Extension, gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';

import * as Usage from './lib/usage.js';

// Claude plan usage, in Quick Settings. The status area of the top bar shows
// the Claude icon and/or the 5-hour session's percentage; a Claude tile in the
// Quick Settings grid shows or hides it, and its arrow opens a menu with the
// session and weekly bars.
//
// The numbers come from the same report Claude Code's /usage reads, signed in
// with Claude Code's own login (~/.claude/.credentials.json). The token is only
// read, never refreshed here: refreshing would rotate it out from under Claude
// Code. When it expires, running `claude` refreshes it and the file monitor
// picks that up.

const TICK_SECONDS = 60;
const MIN_FETCH_GAP_MS = 60 * 1000;
const VERTICAL = {orientation: Clutter.Orientation.VERTICAL};

function fill(template, ...args) {
    return template.replace(/%(\d)/g, (m, i) => (args[i - 1] ?? m));
}

const DIM = 178;
function dim(actor) {
    actor.opacity = DIM;
    return actor;
}

const pct = n => fill(_('%1%'), Number(n).toLocaleString());

function credentialsPath() {
    const dir = GLib.getenv('CLAUDE_CONFIG_DIR') || GLib.build_filenamev([GLib.get_home_dir(), '.claude']);
    return GLib.build_filenamev([dir, '.credentials.json']);
}

// "%H:%M" or "%l:%M %p", as the top bar clock is set (Settings › Date & Time).
function timeFormat() {
    const iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    return iface.get_string('clock-format') === '12h' ? '%l:%M %p' : '%H:%M';
}

function resetsIn(target) {
    if (target === null)
        return '';
    const {hours, minutes} = Usage.untilParts(target, Date.now());
    if (hours === 0 && minutes === 0)
        return _('Resetting now');
    const m = fill(ngettext('%1 min', '%1 min', minutes), minutes);
    if (hours === 0)
        return fill(_('Resets in %1'), m);
    const h = fill(ngettext('%1 h', '%1 h', hours), hours);
    return fill(_('Resets in %1 %2'), h, m);
}

function resetsAt(target) {
    if (target === null)
        return '';
    const dt = GLib.DateTime.new_from_unix_local(Math.floor(target / 1000));
    const days = (target - Date.now()) / 86400000;
    const day = days < 6 ? '%a' : '%e %b';
    return fill(_('Resets %1'), dt.format(`${day} ${timeFormat()}`).replace(/\s+/g, ' ').trim());
}

const ERRORS = {
    'signed-out': () => _('Sign in with Claude Code'),
    'expired': () => _('Sign-in expired, run Claude Code'),
    'rate-limited': () => _('Too many requests, retrying later'),
    'unavailable': () => _('Couldn’t reach Claude'),
};

// A level bar: a trough the width of the menu, filled to the fraction used.
// The fill is the accent color, then warning and error colors near the limit.
const UsageBar = GObject.registerClass(
class UsageBar extends St.Widget {
    _init() {
        super._init({style_class: 'claude-usage-bar', x_expand: true});
        this._fraction = 0;
        this._fill = new St.Widget({style_class: 'claude-usage-bar-fill'});
        this.add_child(this._fill);
    }

    setPercent(percent) {
        this._fraction = Math.min(1, Math.max(0, percent / 100));
        for (const l of ['normal', 'warning', 'critical'])
            this._fill[l === Usage.level(percent) ? 'add_style_class_name' : 'remove_style_class_name'](l);
        this.queue_relayout();
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const content = this.get_theme_node().get_content_box(box);
        const child = new Clutter.ActorBox();
        child.set_origin(content.x1, content.y1);
        child.set_size(Math.round(content.get_width() * this._fraction), content.get_height());
        this._fill.allocate(child);
    }
});

// One window in the menu: name and percentage, the bar, and when it resets.
class WindowSection {
    constructor(menu, title) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'claude-usage-section'});
        menu.addMenuItem(item);
        this._item = item;
        const box = new St.BoxLayout({...VERTICAL, x_expand: true, style_class: 'claude-usage-section-box'});
        item.add_child(box);

        const head = new St.BoxLayout();
        this._title = title;
        head.add_child(new St.Label({text: title, x_expand: true, style_class: 'claude-usage-title'}));
        this._value = new St.Label({style_class: 'claude-usage-value'});
        head.add_child(this._value);
        box.add_child(head);

        this._bar = new UsageBar();
        box.add_child(this._bar);

        this._caption = dim(new St.Label({style_class: 'claude-usage-caption'}));
        box.add_child(this._caption);
    }

    update(win, caption) {
        this._value.text = win ? pct(win.percent) : '–';
        this._bar.setPercent(win?.percent ?? 0);
        this._caption.text = win ? caption(win.resetsAt) : _('No data yet');
        this._caption.visible = this._caption.text !== '';
        this._item.accessible_name = win
            ? [this._title, pct(win.percent), this._caption.text].join(', ')
            : this._title;
    }
}

const ClaudeToggle = GObject.registerClass(
class ClaudeToggle extends QuickSettings.QuickMenuToggle {
    _init(gicon) {
        super._init({title: _('Claude'), gicon, toggleMode: true});
    }
});

const ClaudeIndicator = GObject.registerClass(
class ClaudeIndicator extends QuickSettings.SystemIndicator {
    _init(extension) {
        super._init();
        this._extension = extension;
        this._settings = extension.getSettings();
        this._gicon = Gio.icon_new_for_string(`${extension.path}/icons/claude-symbolic.svg`);

        this._usage = null;
        this._error = null;
        this._updatedAt = 0;
        this._lastFetch = 0;
        this._cancellable = null;
        this._session = new Soup.Session({user_agent: 'gnome-claude-usage', timeout: 20});

        // Status area of the top bar: icon, then the session percentage.
        this.add_style_class_name('claude-usage-panel');
        this._panelIcon = new St.Icon({gicon: this._gicon, style_class: 'system-status-icon'});
        this._panelLabel = new St.Label({y_align: Clutter.ActorAlign.CENTER, style_class: 'claude-usage-panel-label'});
        this.add_child(this._panelIcon);
        this.add_child(this._panelLabel);
        // A SystemIndicator only shows itself for icons added with
        // _addIndicator(), so track our own children's visibility.
        for (const child of [this._panelIcon, this._panelLabel])
            child.connect('notify::visible', () => this._syncIndicatorsVisible());

        // Quick Settings tile and its menu.
        this._toggle = new ClaudeToggle(this._gicon);
        this.quickSettingsItems.push(this._toggle);
        this._settings.bind('show-indicator', this._toggle, 'checked', Gio.SettingsBindFlags.DEFAULT);

        const menu = this._toggle.menu;
        menu.box.add_style_class_name('claude-usage-menu');
        this._sessionSection = new WindowSection(menu, _('Current Session'));
        this._weeklySection = new WindowSection(menu, _('Weekly'));

        const footer = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'claude-usage-footer'});
        this._status = dim(new St.Label({x_expand: true, y_align: Clutter.ActorAlign.CENTER, style_class: 'claude-usage-caption'}));
        footer.add_child(this._status);
        const refresh = new St.Button({
            style_class: 'icon-button claude-usage-refresh',
            can_focus: true,
            accessible_name: _('Refresh'),
            child: new St.Icon({icon_name: 'view-refresh-symbolic'}),
        });
        refresh.connect('clicked', () => this._fetch(true));
        footer.add_child(refresh);
        menu.addMenuItem(footer);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addAction(_('Settings'), () => {
            Main.panel.statusArea.quickSettings.menu.close();
            this._extension.openPreferences();
        });

        menu.connect('open-state-changed', (_m, open) => {
            if (open)
                this._fetch(false);
        });

        this._settingsId = this._settings.connect('changed', () => this._render());

        // Claude Code rewrites its credentials when it refreshes the token;
        // that is the moment a stale or missing sign-in becomes good again.
        this._credsFile = Gio.File.new_for_path(credentialsPath());
        try {
            this._monitor = this._credsFile.get_parent().monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
        } catch {
            this._monitor = null; // no ~/.claude yet: the minute timer still retries
        }
        this._monitorId = this._monitor?.connect('changed', (_mon, file, other) => {
            const name = '.credentials.json';
            if (file?.get_basename() !== name && other?.get_basename() !== name)
                return;
            if (this._error === 'expired' || this._error === 'signed-out')
                this._scheduleFetch();
        });

        // Once a minute: refresh the "resets in" text, and fetch when the
        // interval is up or a window has just reset.
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TICK_SECONDS, () => {
            const now = Date.now();
            const interval = this._settings.get_uint('refresh-minutes') * 60000;
            const reset = [this._usage?.session, this._usage?.weekly]
                .some(w => w?.resetsAt && w.resetsAt <= now && w.resetsAt > this._lastFetch);
            if (now - this._lastFetch >= interval || reset)
                this._fetch(false);
            else
                this._render();
            return GLib.SOURCE_CONTINUE;
        });

        this._render();
        this._fetch(true);
    }

    // ------------------------------------------------------------ fetching

    _scheduleFetch() {
        if (this._debounce)
            return;
        this._debounce = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
            this._debounce = 0;
            this._fetch(true);
            return GLib.SOURCE_REMOVE;
        });
    }

    _fetch(force) {
        if (this._cancellable)
            return;
        if (!force && Date.now() - this._lastFetch < MIN_FETCH_GAP_MS)
            return;
        this._lastFetch = Date.now();
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;

        this._credsFile.load_contents_async(cancellable, (file, res) => {
            let creds = null;
            try {
                const [, bytes] = file.load_contents_finish(res);
                creds = Usage.parseCredentials(new TextDecoder().decode(bytes));
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    return;
            }
            if (!creds)
                return this._done(cancellable, null, 'signed-out');
            if (creds.expiresAt && creds.expiresAt < Date.now())
                return this._done(cancellable, null, 'expired');

            const msg = Soup.Message.new('GET', Usage.USAGE_URL);
            msg.request_headers.append('Authorization', `Bearer ${creds.token}`);
            msg.request_headers.append('anthropic-beta', Usage.BETA_HEADER);
            msg.request_headers.append('Accept', 'application/json');
            this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable, (session, r) => {
                try {
                    const bytes = session.send_and_read_finish(r);
                    const status = msg.get_status();
                    if (status !== Soup.Status.OK)
                        return this._done(cancellable, null, Usage.errorForStatus(status));
                    const usage = Usage.parseUsage(new TextDecoder().decode(bytes.get_data()));
                    this._done(cancellable, usage, null);
                } catch (e) {
                    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        return;
                    this._done(cancellable, null, 'unavailable');
                }
            });
        });
    }

    _done(cancellable, usage, error) {
        if (cancellable !== this._cancellable)
            return;
        this._cancellable = null;
        this._error = error;
        if (usage) {
            this._usage = usage;
            this._updatedAt = Date.now();
        } else if (error === 'expired' || error === 'signed-out') {
            // The old numbers can't be trusted to belong to whoever signs in next.
            this._usage = null;
        }
        this._render();
    }

    // ------------------------------------------------------------ view

    _render() {
        const show = this._settings.get_boolean('show-indicator');
        const mode = this._settings.get_string('panel-display');
        const session = this._usage?.session;

        this._panelIcon.visible = show && mode !== 'Percentage';
        this._panelLabel.visible = show && mode !== 'Icon';
        this._panelLabel.text = session ? pct(session.percent) : '–';
        this.accessible_name = session
            ? fill(_('Claude session usage: %1'), pct(session.percent))
            : _('Claude usage');

        const t = this._toggle;
        if (session)
            t.subtitle = fill(_('%1 of session'), pct(session.percent));
        else
            t.subtitle = this._error ? ERRORS[this._error]() : _('Loading…');

        this._sessionSection.update(session, resetsIn);
        this._weeklySection.update(this._usage?.weekly, resetsAt);

        if (this._error)
            this._status.text = ERRORS[this._error]();
        else if (this._updatedAt)
            this._status.text = fill(_('Updated %1'),
                GLib.DateTime.new_from_unix_local(Math.floor(this._updatedAt / 1000))
                    .format(timeFormat()).trim());
        else
            this._status.text = _('Loading…');
    }

    destroy() {
        this._cancellable?.cancel();
        this._cancellable = null;
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
        if (this._debounce)
            GLib.source_remove(this._debounce);
        this._debounce = 0;
        if (this._monitor) {
            this._monitor.disconnect(this._monitorId);
            this._monitor.cancel();
            this._monitor = null;
        }
        this._session?.abort();
        this._session = null;
        Gio.Settings.unbind(this._toggle, 'checked');
        if (this._settingsId)
            this._settings.disconnect(this._settingsId);
        this._settingsId = 0;
        this._settings = null;
        this.quickSettingsItems.forEach(item => item.destroy());
        this.quickSettingsItems = [];
        super.destroy();
    }
});

export default class ClaudeUsageExtension extends Extension {
    enable() {
        this._indicator = new ClaudeIndicator(this);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
