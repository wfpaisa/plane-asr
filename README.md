# plane-asr

A GNOME Shell extension (`planeasr@wfelipe.com`) for local ASR (speech-to-text),
written in TypeScript and following the official
[TypeScript and LSP](https://gjs.guide/extensions/development/typed.html) guide.
Transcription runs entirely on your machine via `transcribe-cli`
(transcribe.cpp); nothing is sent to the cloud.

![](screenshot/screenshot01.png) ![](screenshot/screenshot02.png)<br>
![](screenshot/screenshot03.png)<br>
![](screenshot/screenshot04.png)<br>
![](screenshot/screenshot05.png)<br>
![](screenshot/screenshot06.png)<br>
![](screenshot/screenshot07.png)<br>

## Features

- **Panel indicator** — left-click toggles record/stop (or cancels a running
  transcription); right-click opens a menu.
- **Global shortcut** — `<Super>A` by default toggles recording.
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
- **CPU or GPU** — use the bundled CPU-only binary (x86_64) or point to your
  own Vulkan/CUDA build; the compute device is chosen from the CLI's own
  `--list-devices`.

## Project structure

```
plane-asr/
├── src/                      # TypeScript sources (modular)
│   ├── ambient.d.ts          # GJS / GNOME Shell ambient type imports
│   ├── extension/            # Runtime code loaded into gnome-shell
│   │   ├── index.ts          #   PlaneAsrExtension (enable/disable lifecycle)
│   │   ├── indicator.ts      #   Panel indicator UI + menu
│   │   ├── asr-service.ts    #   Record → transcribe → output state machine
│   │   ├── asr-backends.ts   #   transcribe-cli argv builder + arg tokenizer
│   │   ├── recorder.ts       #   WAV capture (pw-record / parecord)
│   │   ├── transcriber.ts    #   Runs the ASR CLI subprocess
│   │   ├── audio-chunker.ts  #   Live WAV chunk slicing
│   │   ├── audio-converter.ts#   ffmpeg / gst format conversion
│   │   ├── device-lister.ts  #   `--list-devices` probe
│   │   ├── cli-resolver.ts   #   Locate the CPU/GPU binary
│   │   └── file-picker.ts    #   Out-of-process Gtk.FileDialog helper
│   ├── prefs/                # Adwaita preferences window
│   │   ├── index.ts          #   Pages: Models / Backend / General
│   │   ├── models-page.ts    #   Catalog browser + downloader
│   │   └── widgets.ts        #   Shared row builders
│   ├── models/               # Catalog + downloader + download state store
│   ├── config/               # settings.ts (GSettings keys) + paths.ts
│   └── util/                 # Pure helpers (paste, text-merge, wav, …)
├── test/                     # node:test suites over the pure util logic
├── extension.ts / prefs.ts   # Root entry points (re-export src/)
├── schemas/                  # GSettings schema
├── data/                     # Icons + bundled model catalog
├── bin/transcribe-cli        # Bundled CPU-only binary (x86_64)
├── metadata.json             # GNOME Shell extension metadata
├── stylesheet.css            # Custom styling
├── tsconfig.json             # tsc config (NodeNext, outDir: dist)
├── Makefile                  # build / pack / install targets
└── package.json              # pnpm scripts and dependencies
```

GNOME Shell loads `extension.js` and `prefs.js` from the extension root, so the thin root
entry points re-export the implementations living under `src/`.

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
pnpm run setup

# ts -> js
pnpm run build
# or
make
```

## Test

The pure logic (chunk stitching, argument tokenizing, model-params
normalization, WAV header handling, `--list-devices` parsing) is covered by
Node's built-in test runner. It compiles those modules to `dist-test/` and runs
them under plain Node — no GJS required:

```bash
pnpm run test
```

## Pack and install

```bash
make pack      # generates planeasr@wfelipe.com.zip
make install   # installs it for the current user via gnome-extensions
make clean     # removes dist/, node_modules/ and the generated zip
```

After `make install`, log out and back in (or restart the Shell) to see the extension in the
Extension Manager.

## License

GPL-2.0-or-later — see [LICENSE](./LICENSE).
