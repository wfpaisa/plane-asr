/* file-picker.ts
 *
 * Standalone out-of-process Gtk file picker.
 *
 * GNOME Shell's UI runs on St/Clutter, which has no native file chooser. GTK's
 * `Gtk.FileDialog` only works inside a Gtk-based process, so when the user
 * wants to transcribe an existing audio file the indicator spawns this script
 * via `gjs -m` (see `Indicator._pickAndTranscribe`), reads the chosen path off
 * its stdout, and feeds it to `AsrService.transcribeFile`.
 *
 * This is a *leaf* script: it does NOT import anything from `src/` and has no
 * access to the running gnome-shell process (no gettext domain, no settings,
 * no indicator). All translatable strings are produced by the caller and passed
 * on the command line:
 *   ARGV[0] = dialog title
 *   ARGV[1] = accept-button label
 *
 * Exit codes:
 *   0  → file chosen; its absolute path is printed to stdout
 *   1  → user cancelled / dismissed the dialog (no output)
 *   2  → unexpected error; a diagnostic is written to stderr
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

/** Build the audio filter: every common container, plus a glob fallback. */
function buildAudioFilter(): Gtk.FileFilter {
    const filter = new Gtk.FileFilter();
    filter.name = 'Audio';
    // `add_mime_type` does not accept wildcards, so name the common ones
    // explicitly; the patterns below catch anything we missed by extension.
    for (const mime of [
        'audio/wav',
        'audio/x-wav',
        'audio/mpeg',
        'audio/ogg',
        'audio/flac',
        'audio/aac',
        'audio/mp4',
        'audio/x-m4a',
        'audio/opus',
        'audio/webm',
        'audio/x-ms-wma',
    ]) {
        filter.add_mime_type(mime);
    }
    for (const pat of [
        '*.wav',
        '*.mp3',
        '*.ogg',
        '*.oga',
        '*.flac',
        '*.m4a',
        '*.aac',
        '*.opus',
        '*.webm',
        '*.wma',
        '*.aiff',
        '*.aif',
    ]) {
        filter.add_pattern(pat);
    }
    return filter;
}

function main(): void {
    // Initialize GTK so the dialog has a working display connection even when
    // invoked from a non-interactive D-Bus activation context.
    Gtk.init();

    const title = ARGV[0] ?? 'Select audio file';
    const acceptLabel = ARGV[1] ?? 'Open';

    const loop = new GLib.MainLoop(null, false);

    const filters = new Gio.ListStore();
    filters.append(buildAudioFilter());

    const dialog = new Gtk.FileDialog({
        title,
        acceptLabel,
        filters,
    });

    dialog.open(
        null,
        null,
        (_self: Gtk.FileDialog, res: Gio.AsyncResult) => {
            let file: Gio.File;
            try {
                file = dialog.open_finish(res);
            } catch (e) {
                // Gtk.DialogError.DISMISSED is the documented "user cancelled"
                // path — exit silently with code 1 so the caller can tell it
                // apart from a real failure (code 2).
                if (e instanceof GLib.Error) {
                    if (
                        e.matches(
                            Gtk.DialogError.$gtype,
                            Gtk.DialogError.DISMISSED
                        )
                    ) {
                        loop.quit();
                        return;
                    }
                }
                printerr(String(e));
                loop.quit();
                return;
            }
            const path = file.get_path();
            if (path) print(path);
            loop.quit();
        }
    );

    loop.run();
}

main();
