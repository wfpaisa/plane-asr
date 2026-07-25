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

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import system from 'system';

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
    // Exit code surfaced after the loop drains. 0 = picked, 1 = cancelled,
    // 2 = error. Defaults to 2 so any unexpected early return is treated as
    // a failure rather than silently succeeding with empty stdout.
    let exitCode = 2;

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
        (_self: Gtk.FileDialog | null, res: Gio.AsyncResult) => {
            let file: Gio.File;
            try {
                file = dialog.open_finish(res);
            } catch (e) {
                // Gtk.DialogError.DISMISSED is the documented "user cancelled"
                // path — exit silently (code 1) so the caller can tell it apart
                // from a real failure (code 2). Anything else is logged.
                const err = e as GLib.Error;
                if (
                    err?.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED)
                ) {
                    exitCode = 1;
                } else {
                    printerr(String(e));
                }
                loop.quit();
                return;
            }
            const path = file.get_path();
            if (path) {
                print(path);
                exitCode = 0;
            } else {
                exitCode = 2;
            }
            loop.quit();
        }
    );

    loop.run();
    system.exit(exitCode);
}

main();
