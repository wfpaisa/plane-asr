## Plan: "Process audio file" menu item

Add a new panel-menu entry that opens a native file picker, validates the picked audio against the ASR's required format (16 kHz / mono / s16le PCM WAV), converts it when possible (ffmpeg → gst-launch fallback), and transcribes it via the existing pipeline. Converted files are written to `~/.cache/planeasr/records/imported_*` and are **not** pruned.

### Decisions (confirmed)
- **Picker**: out-of-process Gtk helper spawned via `gjs -m` (GTK file dialogs can't run inside the gnome-shell St/Clutter process).
- **Converter**: probe `ffmpeg` first; fall back to `gst-launch-1.0` (always present on GNOME); show a format-required warning if neither exists.
- **Converted files**: `records/imported_<basename>_<µs>.wav`, excluded from pruning (existing `pruneRecordings` regex `^recording_\d+\.wav$` already ignores them).

### Files to change

**1. `src/extension/file-picker.ts` (NEW — ships as `dist/extension/file-picker.js`)**
A standalone GJS script run in its own process. Uses `Gtk.FileDialog` (GTK 4.10+, GNOME 50 era). The dialog title/accept-label are passed via `ARGV` (translated by the indicator, which has gettext — the picker itself is i18n-agnostic since it can't reach gnome-shell resources). Prints the chosen path to stdout, exits:
- `0` + path on stdout → picked
- `1` + empty stdout → user cancelled (`Gtk.DialogError.DISMISSED`)
- `2` + stderr → error

Structure: callback form + explicit `GLib.MainLoop` (defensive against GJS top-level-await quirks), not top-level await. Adds a `Gtk.FileFilter` for audio (mime `audio/*` + common suffixes `.wav .mp3 .ogg .m4a .flac .opus .aac .wma`). `Gtk.init()` called for safety.

**2. `tsconfig.json`** — add `"src/extension/file-picker.ts"` to `files` so tsc compiles it to `dist/extension/file-picker.js` (Makefile already zips `dist/` wholesale → installs to `<extdir>/extension/file-picker.js`). Type-checks via the existing `@girs/gnome-shell` ambient (which already provides Gtk types to `src/prefs/*`).

**3. `src/extension/audio-converter.ts` (NEW)** — mirrors the `Transcriber` pattern (own `Gio.Subprocess`, `forceExit()` for cancellation):
- `convert(srcPath, destPath): Promise<void>` — probes `ffmpeg` (priority 1), then `gst-launch-1.0` (priority 2); throws with stderr on failure; throws a sentinel error (`NoConverterError`) when neither binary is present so the caller can show the format-required warning instead of a generic failure.
- ffmpeg argv: `['ffmpeg', '-y', '-loglevel', 'error', '-i', src, '-ar', '16000', '-ac', '1', '-sample_fmt', 's16', dest]`
- gst-launch argv: `['gst-launch-1.0', 'filesrc', `location=${src}`, '!', 'decodebin', '!', 'audioconvert', '!', 'audioresample', '!', 'audio/x-raw,rate=16000,channels=1,format=S16LE', '!', 'wavenc', '!', 'filesink', `location=${dest}`]`
- Format check reuses `getWavDataOffset` from `audio-chunker.ts` (returns data offset or `null` when not 16 kHz mono s16le PCM WAV).

**4. `src/extension/asr-service.ts`** —
- Own a `private _converter = new AudioConverter();`
- Add `cancel()` line: `this._converter.forceExit();`
- Extract the body of `_transcribeWhole` into `_runTranscription(audioPath, isPaste, prune: boolean)`; `_transcribeWhole` becomes a one-line call with `prune=true`.
- Add public `async transcribeFile(srcPath: string): Promise<void>`:
  1. **Guard**: `if (this._state !== AsrState.Idle) { notify busy; return; }` (no concurrency guard exists today; `toggle()`'s switch is the only one — a direct entry point must self-guard).
  2. Reuse `_validateCliBinary()` → if missing, `_setState(Idle, {error})` and return.
  3. If `getWavDataOffset(srcPath) !== null` → already correct, `finalPath = srcPath`.
  4. Else → resolve `destPath = records/imported_<sanitized-basename>_<µs>.wav` via `recordsDir()`; `Main.notify(_('Converting audio…'))`; `await this._converter.convert(srcPath, destPath)`; on `NoConverterError` → `_setState(Idle, {error: _('No audio converter found. Install ffmpeg, or use a 16 kHz mono 16-bit WAV.')})` and return; on other errors → `_setState(Idle, {error})` and return.
  5. `await this._runTranscription(finalPath, isPaste, /*prune*/ false)`.
- `isPaste` read as today: `(get_string('output-mode') ?? 'clipboard') === 'paste'`.

**5. `src/extension/indicator.ts`** —
- Extend `AsrServiceLike` with `transcribeFile(path: string): Promise<void>;`
- Add field `private _processFileItem!: PopupMenu.PopupMenuItem;`
- In `_buildMenu()`, add the item after `_openAudioItem` (keeps audio actions grouped before the separator), wired with the existing `connect('activate', () => { menu.close(); this._pickAndTranscribe(); })` pattern.
- Add `private _pickAndTranscribe(): Promise<void>`:
  - Bail if `this.service?.state !== AsrState.Idle`.
  - Resolve picker path: `GLib.build_filenamev([this.extension.path, 'extension', 'file-picker.js'])`.
  - Spawn `['gjs', '-m', pickerPath, _('Select audio file'), _('Open')]` via `Gio.Subprocess` + `communicate_utf8_async` (mirrors `transcriber.ts`).
  - Empty stdout → cancelled, return silently. Non-empty → `this.service.transcribeFile(stdout.trim())`.
- In `_refreshMenuSensitivity()`: `this._processFileItem.sensitive = this.service?.state === AsrState.Idle;` (gates during Recording/Transcribing/conversion).

**6. `po/planeasr.pot` + `po/es.po`** — run `make pot` (xgettext auto-picks new `_()` strings; `src/extension/{indicator,asr-service}.ts` are already in `POTFILES.in`), then `msgmerge po/es.po po/planeasr.pot`, then translate the new entries (es): "Process audio file" → "Procesar audio", "Select audio file" → "Seleccionar archivo de audio", "Open" → "Abrir", "Converting audio…" → "Convirtiendo audio…", "No audio converter found…" → "No se encontró conversor de audio. Instala ffmpeg o usa un WAV de 16 kHz mono 16-bit.", "Plane ASR is busy" → "Plane ASR está ocupado".

### What is NOT touched
- No GSettings keys / no schema changes (feature is stateless).
- No changes to `src/extension/index.ts` (the `AsrServiceLike` threading via `this._indicator.service = this._service` already carries the new method).
- No new npm dependencies (`@girs/gtk-4.0` is already present transitively via `@girs/gnome-shell`, which already types `src/prefs/*`'s `gi://Gtk` imports).
- No Makefile changes (`dist/` is zipped wholesale).

### Known limitation (v1)
During the conversion window (before `Transcribing` is set), the converter subprocess is cancellable via `cancel()`/`forceExit()`, but the indicator's record-item label still reads "Start recording" — minor UX gap. The conversion step is gated behind `state === Idle` so it won't race an in-flight recording.

### Verification
- `pnpm run build` (tsc strict typecheck) — must pass.
- `pnpm run lint` (eslint) — must pass.
- `make pot && msgmerge po/es.po po/planeasr.pot` then edit `es.po`.
- `pnpm run setup` + log out/in, then exercise: pick a 16 kHz WAV (transcribes directly), pick an MP3 with ffmpeg present (converts + transcribes), pick an MP3 with only gst-launch (converts via fallback), pick a non-audio / no-converter case (warning shown), cancel the dialog (silent).