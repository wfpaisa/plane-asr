# Plane-ASR

A GNOME Shell extension (`planeasr@wfelipe.com`) for local ASR (speech-to-text),
written in TypeScript and following the official
[TypeScript and LSP](https://gjs.guide/extensions/development/typed.html) guide.
Transcription runs entirely on your machine via `transcribe-cli`
(transcribe.cpp); nothing is sent to the cloud.

![](screenshot/screenshot01.png) ![](screenshot/screenshot02.png)<br>
<details>
    <summary>Show screenshots</summary>
    ![](screenshot/screenshot03.png)<br>
    ![](screenshot/screenshot04.png)<br>
    ![](screenshot/screenshot05.png)<br>
    ![](screenshot/screenshot06.png)<br>
    ![](screenshot/screenshot07.png)<br>
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

The `transcribe-cli` engine (CPU-only, x86_64) is **not** bundled in the
extension zip — that would violate the GNOME extension review guidelines
([EGO-P-005](https://gjs.guide/extensions/review-guidelines/review-guidelines.html#scripts-and-binaries)).
Instead it is published as a **GitHub Release asset** and downloaded on demand
from the "Setup" page. [`src/models/engine-manifest.ts`](src/models/engine-manifest.ts)
pins the exact URL, size and SHA-256, and the downloader refuses anything that
does not match.

To ship a new engine build:

1. **Build the binary out-of-band** (from transcribe.cpp, CPU-only) and place it
   at `bin/transcribe-cli.bin`. It is committed to the repo (git only, never the
   zip) so the release workflow can pick it up.

2. **Compute its checksum and size:**

    ```bash
    sha256sum bin/transcribe-cli.bin
    stat -c%s bin/transcribe-cli.bin
    ```

3. **Update the manifest** in [`src/models/engine-manifest.ts`](src/models/engine-manifest.ts):
   bump `version` and set `url`, `size_bytes` and `sha256` for the `x86_64`
   build. The `version` **must** match the tag you push in the next step, and
   the URL follows the pattern
   `…/releases/download/engine-v<version>/transcribe-cli-x86_64`. Compute the
   checksum from the actual binary first — never edit the hash by hand.

4. **Publish the release.** Two options:

    - **Automated (recommended)** — commit the binary + manifest, then tag and
      push. The [`release-engine.yml`](.github/workflows/release-engine.yml)
      workflow renames the binary to `transcribe-cli-x86_64`, re-verifies its
      SHA-256 against the manifest, and creates the release with the asset
      attached:

        ```bash
        git tag engine-v1.0.3 && git push origin engine-v1.0.3
        ```

    - **Manual** — on GitHub, _Releases → Draft a new release_, create the tag
      `engine-v<version>`, and upload the binary. It **must** be uploaded with
      the exact asset name `transcribe-cli-x86_64` (no extension), since that is
      the filename the manifest URL points to.

5. **Verify** the asset resolves and its hash matches the manifest:

    ```bash
    curl -sIL https://github.com/wfpaisa/plane-asr/releases/download/engine-v1.0.3/transcribe-cli-x86_64 | grep -i '^HTTP/'   # expect 200
    ```

The "download engine" button will then fetch the binary, validate the hash and
mark it executable. For a new CPU architecture, add another entry to the
manifest's `builds` array instead of replacing the `x86_64` one.

## License

GPL-2.0-or-later — see [LICENSE](./LICENSE).
