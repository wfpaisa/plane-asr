# plane-asr

A GNOME Shell extension (`planeasr@wfelipe.com`) for local ASR, written in TypeScript and
following the official [TypeScript and LSP](https://gjs.guide/extensions/development/typed.html)
guide.

## Project structure

```
plane-asr/
├── src/                      # TypeScript sources (modular)
│   ├── ambient.d.ts          # GJS / GNOME Shell ambient type imports
│   ├── extension/
│   │   ├── index.ts          # PlaneAsrExtension (enable/disable lifecycle)
│   │   └── indicator.ts      # Panel indicator UI
│   ├── prefs/
│   │   └── index.ts          # PlaneAsrPreferences (Adwaita prefs window)
│   └── config/
│       └── settings.ts       # Centralized GSettings keys
├── extension.ts              # Root entry point (re-exports src/extension)
├── prefs.ts                  # Root entry point (re-exports src/prefs)
├── schemas/                  # GSettings schema
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
