# plane-asr

A GNOME Shell extension (`planeasr@wfelipe.com`) written in TypeScript, following the official
[TypeScript and LSP](https://gjs.guide/extensions/development/typed.html) guide.

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
