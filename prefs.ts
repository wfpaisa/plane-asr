/* prefs.ts
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class PlaneAsrPreferences extends ExtensionPreferences {
  _settings?: Gio.Settings;

  fillPreferencesWindow(window: Adw.PreferencesWindow): Promise<void> {
    this._settings = this.getSettings();

    const page = new Adw.PreferencesPage({
      title: _('General'),
      iconName: 'dialog-information-symbolic',
    });

    const animationGroup = new Adw.PreferencesGroup({
      title: _('Animation'),
      description: _('Configure move/resize animation'),
    });
    page.add(animationGroup);

    const animationEnabled = new Adw.SwitchRow({
      title: _('Enabled'),
      subtitle: _('Whether to animate windows'),
    });
    animationGroup.add(animationEnabled);

    const paddingGroup = new Adw.PreferencesGroup({
      title: _('Paddings'),
      description: _('Configure the padding between windows'),
    });
    page.add(paddingGroup);

    const paddingInner = new Adw.SpinRow({
      title: _('Inner'),
      subtitle: _('Padding between windows'),
      adjustment: new Gtk.Adjustment({
        lower: 0,
        upper: 1000,
        stepIncrement: 1,
      }),
    });
    paddingGroup.add(paddingInner);

    window.add(page);

    this._settings!.bind('animate', animationEnabled, 'active', Gio.SettingsBindFlags.DEFAULT);
    this._settings!.bind('padding-inner', paddingInner, 'value', Gio.SettingsBindFlags.DEFAULT);

    return Promise.resolve();
  }
}
