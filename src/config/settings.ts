/* settings.ts
 *
 * Centralized GSettings keys and defaults for the Plane ASR extension.
 * Keeps magic strings in one place so the schema, extension and prefs stay
 * in sync.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

/** Keys defined in schemas/org.gnome.shell.extensions.planeasr.gschema.xml. */
export const SETTINGS_KEYS = {
    /** Whether the extension's animated feedback is enabled (boolean). */
    ANIMATE: 'animate',
    /** Inner spacing, in pixels, used by the panel indicator UI (int). */
    PADDING_INNER: 'padding-inner',
} as const;

export type SettingsKey = (typeof SETTINGS_KEYS)[keyof typeof SETTINGS_KEYS];
