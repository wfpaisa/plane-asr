# AGENTS.md

Guidance for ZCode agents working in this repository.

## What this is

`plane-asr` (`planeasr@wfelipe.com`) is a **GNOME Shell 50 extension** for local
ASR, written in TypeScript and compiled to GJS-compatible JavaScript. It is NOT a
Node/web app — there is no runtime `node`; the compiled output is loaded by
GNOME Shell's GJS runtime.

Read [README.md](./README.md) first; it documents the project structure and build
flow in detail.

## Build / lint / format

Uses **pnpm**. Toolchain commands:

```bash
pnpm install        # install deps
pnpm run build      # tsc -> dist/ (this is the only "test"-like gate)
pnpm run lint       # eslint .
pnpm run format     # prettier --write .
pnpm run setup      # build + pack + install (full local deploy)
```

Make targets wrap the same flow: `make` / `make pack` / `make install` /
`make clean`. `make pack` requires the system `zip`, `glib-compile-schemas`,
and `gnome-extensions` binaries — these are distro packages, not npm deps.

**There is no test runner in this repo.** Treat `pnpm run build` (tsc typecheck)
and `pnpm run lint` as the correctness gates.

## Architecture & layer rules

- **Entry points**: GNOME Shell loads `extension.js` and `prefs.js` from the
  repo root. These are thin re-export shims — do not put logic in `extension.ts`
  / `prefs.ts`. Real code lives under `src/`.
  - `src/extension/index.ts` — `PlaneAsrExtension` (`enable`/`disable` lifecycle,
    owns the `Indicator` and `Gio.Settings`).
  - `src/extension/indicator.ts` — panel indicator (`PanelMenu.Button` subclass).
  - `src/prefs/index.ts` — `PlaneAsrPreferences` (Adwaita prefs window).
  - `src/config/settings.ts` — **single source of truth for GSettings keys**.
    Add a key here AND in the schema together (see below).

- When touching settings: edit both
  `schemas/org.gnome.shell.extensions.planeasr.gschema.xml` **and**
  `src/config/settings.ts` (`SETTINGS_KEYS`) so they stay in sync. Re-run
  `glib-compile-schemas schemas` (done automatically by `make pack`) after
  schema changes.

- `src/ambient.d.ts` is the GJS/GNOME Shell ambient type entry — keep it as the
  `tsconfig.json` `include` (plus the two root `files`). Don't add stray files
  to `files`/`include` without reason.

## Coding conventions

- **GNOME/GJS style** — follow the [GJS guide](https://gjs.guide).
  - TypeScript strict mode is on (`tsconfig.json`).
  - Module: `NodeNext`. **Imports of internal modules must use the `.js`
    extension** (e.g. `import {Indicator} from './indicator.js';`) even though
    the source is `.ts` — GJS/tsc resolves it at runtime.
  - GNOME library imports use the `gi://` or `resource:///` schemes.
- **Formatting** (`.prettierrc.yml` / `.editorconfig`): 4-space indent, single
  quotes, semicolons, no bracket spacing, `arrowParens: avoid`, trailing comma
  `es5`, LF line endings. `Makefile` uses tabs.
- **ESLint**: `prefer-const`, `no-var`, `eqeqeq` are errors; unused vars are
  warnings. Prettier owns style; ESLint owns correctness.
- License header: source files carry an SPDX-License-Identifier line
  (`GPL-2.0-or-later` for extension/prefs; `MIT OR LGPL-2.0-or-later` for
  config files like `.editorconfig`). Match the file's existing header style.

## GNOME Shell / GJS gotchas

- Target shell version is **50 only** (`metadata.json` `shell-version: ["50"]`).
  Type definitions are `@girs/gnome-shell@50` + `@girs/gjs@4`. APIs may differ
  across versions; check the type defs under `node_modules/@girs/gnome-shell/`
  (or `node_modules/.pnpm/@girs+clutter-18*/...` for Clutter) when in doubt.
- Type defs are referenced via the `@girs/*` ambient packages — `Clutter`,
  `St`, `Gio`, `GObject`, etc. are imported from `gi://...`, and the ambient
  declarations provide the global `global` object.
- After installing an extension build, the user must **log out/in or restart the
  Shell** to pick up changes — there's no hot reload in normal use.
- Debugging/iteration: `pnpm run debug` starts `gnome-shell --devkit --wayland`
  via dbus-run-session.
