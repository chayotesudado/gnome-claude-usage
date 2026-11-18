import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const DISPLAYS = ['Icon', 'Percentage', 'Both'];

export default class ClaudeUsagePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;
        window.search_enabled = false;

        const page = new Adw.PreferencesPage({title: _('Claude Usage'), icon_name: 'preferences-system-symbolic'});
        window.add(page);

        // ---- top bar
        const bar = new Adw.PreferencesGroup({
            title: _('Top Bar'),
            description: _('The Claude tile in Quick Settings shows or hides it.'),
        });
        page.add(bar);

        const show = new Adw.SwitchRow({title: _('Show in Top Bar')});
        settings.bind('show-indicator', show, 'active', 0);
        bar.add(show);

        const display = new Adw.ComboRow({
            title: _('Show'),
            subtitle: _('The percentage is the current 5-hour session'),
            model: Gtk.StringList.new([_('Icon'), _('Percentage'), _('Icon and Percentage')]),
        });
        const syncDisplay = () => {
            display.selected = Math.max(0, DISPLAYS.indexOf(settings.get_string('panel-display')));
        };
        syncDisplay();
        display.connect('notify::selected', () => {
            const value = DISPLAYS[display.selected] ?? 'Both';
            if (settings.get_string('panel-display') !== value)
                settings.set_string('panel-display', value);
        });
        settings.connect('changed::panel-display', syncDisplay);
        bar.add(display);

        // ---- updates
        const updates = new Adw.PreferencesGroup({
            title: _('Updates'),
            description: _('Usage is read with Claude Code’s sign-in. If it expires, run Claude Code to renew it.'),
        });
        page.add(updates);

        const minutes = new Adw.SpinRow({
            title: _('Refresh Every'),
            subtitle: _('Minutes'),
            adjustment: new Gtk.Adjustment({lower: 1, upper: 60, step_increment: 1, page_increment: 5}),
        });
        settings.bind('refresh-minutes', minutes, 'value', 0);
        updates.add(minutes);
    }
}
