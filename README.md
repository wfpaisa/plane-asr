# Plane-ASR

## IMPORTANT

After installing the extension, open Preferences to download the required

## Description

transcribe.cpp binary and an ASR model before using speech recognition.

Turn your voice into text instantly, right on your desktop—no cloud, no
accounts, no waiting.

Plane-ASR is a GNOME Shell extension that transcribes speech to text in real
time. Press a keyboard shortcut, speak, and watch the text appear directly at
your cursor or be copied to your clipboard.

## Default keyboard shortcuts

Toggle Recording
Ctrl+Alt+Space
Press once to start recording. Press again to stop.

Push-to-Talk
Ctrl+Shift+Space
Hold to record. Release to stop.

Both are configurable (and can be disabled) from Preferences.

## Screenshots

![](screenshot/screenshot01.png) ![](screenshot/screenshot02.png)<br>
<details>
<summary>Show screenshots</summary>

![](screenshot/screenshot03.png) <br>
![](screenshot/screenshot04.png) <br>
![](screenshot/screenshot05.png) <br>
![](screenshot/screenshot06.png) <br>
![](screenshot/screenshot07.png) <br>
</details>

## Features

- **Panel indicator** — left-click toggles record/stop (or cancels a running
  transcription); right-click opens a menu.
- **Global shortcut** — configurable in Preferences to toggle recording (no
  default binding is shipped, per GNOME extension review guidelines on
  clipboard-interacting shortcuts).
- **Output modes** — copy the transcription to the clipboard, or auto-paste it
  at the cursor.
- **Live chunked transcription** — long takes are carved into overlapping
  N-second chunks and transcribed while you speak, so backends with a
  per-call output cap don't truncate and the first words land early.
- **Model catalog** — browse, download (resumable, checksum-verified) and
  select GGUF models from HuggingFace directly in Preferences, or point to a
  custom model path.
- **Process an existing audio file** — pick any audio file; it is converted to
  the required format (ffmpeg / gst-launch-1.0) and transcribed.
- **CPU or GPU** — use a `transcribe-cli` found on your PATH, download the
  CPU-only engine (x86_64) with one click from the "Setup" page (checksum
  verified, not bundled with the extension), or point to your own
  Vulkan/CUDA build; the compute device is chosen from the CLI's own
  `--list-devices`.

## Requirements

- GNOME Shell 50
- Node.js + [pnpm](https://pnpm.io)
- `tsc` (provided via `typescript` devDependency)
- `glib-compile-schemas`, `zip`, `gnome-extensions` (provided by your distro)
    - Arch: `sudo pacman -S glib2 zip gnome-shell`
    - Debian/Ubuntu: `sudo apt install libglib2.0-bin zip gnome-shell`
    - Fedora: `sudo dnf install glib2 zip gnome-shell`

## Install dependencies

```bash
pnpm install
```

## Build

Compile `extension.ts` and `prefs.ts` into `dist/`:

```bash
# Pack and install
pnpm run setup

# Debug:
pnpm run setup
```

## Test

The pure logic (chunk stitching, argument tokenizing, model-params
normalization, WAV header handling, `--list-devices` parsing) is covered by
Node's built-in test runner. It compiles those modules to `dist-test/` and runs
them under plain Node — no GJS required:

```bash
pnpm run test
```

## Updating the engine binary

`transcribe-cli` isn't bundled in the zip (GNOME review guidelines forbid
shipping binaries) — it's downloaded on demand from a GitHub Release, pinned
by URL/size/SHA-256 in [`src/models/engine-manifest.ts`](src/models/engine-manifest.ts).

```bash
# 1. Build the binary out-of-band (transcribe.cpp, CPU-only, x86_64)
#    and commit it
cp /path/to/new/transcribe-cli bin/transcribe-cli.bin
git add bin/transcribe-cli.bin

# 2. Compute its checksum and size
sha256sum bin/transcribe-cli.bin
stat -c%s bin/transcribe-cli.bin

# 3. Edit src/models/engine-manifest.ts: bump `version` and set
#    `url`, `size_bytes`, `sha256` for the x86_64 build (version
#    must match the tag below)

# 4. Commit, tag and push — release-engine.yml renames the binary,
#    re-verifies its hash and publishes the release with the asset
git commit -m "engine: bump to v1.0.3"
git tag engine-v1.0.3 && git push origin engine-v1.0.3

# 5. Verify the asset is live (expect HTTP/200)
curl -sIL https://github.com/wfpaisa/plane-asr/releases/download/engine-v1.0.3/transcribe-cli-x86_64 | grep -i '^HTTP/'
```

For a new CPU architecture, add another entry to the manifest's `builds`
array instead of replacing `x86_64`.

## License

GPL-2.0-or-later — see [LICENSE](./LICENSE).
