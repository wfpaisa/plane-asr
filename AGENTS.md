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
- **`tsconfig.json` keeps `useDefineForClassFields: false` on purpose.** With
  the default (`true` under `target: ES2023`), TypeScript emits
  `Object.defineProperty(this, '_field', {value: undefined})` for every class
  field — including definite-assignment ones (`_icon!: St.Icon`). In GJS the
  `GObject.registerClass` lifecycle means `super._init(...)` can fire callbacks
  that touch those fields *before* your `_init` body runs, and the field
  initializer then clobbers them back to `undefined`. Symptom: cryptic runtime
  `TypeError: can't access property "x", this._y is undefined`. Do NOT remove
  this flag and do NOT add class-field initializers with side effects; assign
  fields inside `_init()` only.

## Debugging

A loaded extension is patched into the live `gnome-shell` process, so debugging
uses non-standard methods. Source: the [GJS debugging guide](https://gjs.guide).

### Running a nested Shell

`pnpm run debug` runs `dbus-run-session gnome-shell --devkit --wayland`, opening
a nested instance in a new D-Bus session. The terminal shows Mutter/GNOME debug
logs. This is NOT fully isolated — don't run it against a session with real data.

To get maximum verbosity, set both env vars before launching:

```bash
export G_MESSAGES_DEBUG=all      # GLib/mutter debug messages
export SHELL_DEBUG=all           # backtrace-warnings + backtrace-segfaults
pnpm run debug
```

`SHELL_DEBUG` accepts `backtrace-warnings`, `backtrace-segfaults`, or `all`. The
former prints the JS stack on every `console.warn()` / `console.error()`.

### Restarting the Shell after a rebuild

`pnpm run setup` repacks and reinstalls, but the running Shell keeps the old
code. On **Wayland** there is no in-place restart — log out and back in. On
**X11** press `Alt+F2` → type `restart` → Enter; debug output goes to the
terminal where the Shell was started.

### Reading logs

- `journalctl --user -b /usr/bin/gnome-shell` — system log (systemd users).
- `~/.xsession-errors` — fallback on non-systemd systems.
- `console.debug()` → `LEVEL_DEBUG`, `console.warn()` → `LEVEL_WARNING`,
  `console.error()` → `LEVEL_CRITICAL`. Keep logging minimal; everything lands
  in the system journal.

### Looking Glass (built-in inspector)

`Alt+F2` → `lg` opens an inspector/REPL running in the live Shell. `GLib`,
`GObject`, `Gio`, `Clutter`, `Meta`, `St`, `Shell`, and `Main` are pre-imported.
Notable pages: **Evaluator** (REPL), **Extensions** (shows per-extension errors
+ "view source" — the fastest way to see a runtime stack from this repo),
**Actors** (widget tree). It is not a stepping debugger.

### GDB (advanced, for native crashes)

When the Shell segfaults or a warning must be traced to C/JS source:

```bash
dbus-run-session -- gdb --args gnome-shell --devkit --wayland
(gdb) set env G_DEBUG=fatal-criticals      # trap on console.error()
(gdb) run
# at the SIGTRAP:
(gdb) backtrace
(gdb) call (void)gjs_dumpstack()           # print the JS stack on top of C
```

`System.breakpoint()` in JS halts at a chosen source line for stepping. Install
debug symbols (including `mozjs`) for useful frames.

### Iteration loop for this repo

1. Edit `src/**/*.ts`.
2. `pnpm run build && pnpm run lint` — must pass before testing in the Shell.
3. `pnpm run setup` to repack+install.
4. Log out/in (Wayland) or `Alt+F2 → restart` (X11).
5. Reproduce; inspect via `lg → Extensions → planeasr` or `journalctl --user`.

## Reference documentation

Primary sources of truth when in doubt about GNOME Shell / GJS APIs or UI
patterns:

- **GJS guide** — <https://gjs.guide/extensions/>: official documentation for
  writing extensions (creation, upkeeping, debugging, preferences, uploaded
  extensions). Start here for concepts and lifecycle.
- **gnome-shell UI sources** —
  <https://gitlab.gnome.org/GNOME/gnome-shell/-/tree/main/js/ui?ref_type=heads>:
  the actual JavaScript implementations of the UI classes this extension
  subclasses and consumes (`panelMenu.js`, `popupMenu.js`, `main.js`,
  `windowManager.js`, …). When type defs are ambiguous or a class behaves
  unexpectedly, read the real source here — it is the authoritative behavior
  reference for `PanelMenu.Button`, `PopupMenu.*`, `Main.wm`, etc. Match the
  `main` branch only loosely; our target is `shell-version: ["50"]`, so cross
  -check against the `@girs/gnome-shell@50` type defs installed in
  `node_modules/@girs/gnome-shell/`.
