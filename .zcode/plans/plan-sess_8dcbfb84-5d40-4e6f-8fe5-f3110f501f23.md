# Plan: Modo automático (binario CPU empaquetado) + modo manual

## Resumen de decisiones (confirmadas)

- **Modo automático (default)**: la extensión trae un `transcribe-cli` **solo-CPU** empaquetado en `bin/transcribe-cli` (el ya compilado en `transcribe.cpp_vulkan/build-cpu/bin/`, 4.2MB, x86_64). Cero configuración: "funciona por defecto".
- **Modo manual**: igual que hoy — el usuario escribe el path absoluto de su propio binario (p.ej. uno compilado con Vulkan/CUDA).
- Solo x86_64 para el auto; arquitecturas sin binario empaquetado caen a modo manual automáticamente.

## Precondición técnica (verificar primero en implementación)

El binario `build-cpu/bin/transcribe-cli` debe ser **portable** (`ldd` sin `libvulkan`/`libcuda`/`libggml` dinámicos; solo libc/libstdc++/libgomp universales). Se ejecutará `ldd` y `grep -iE 'vulkan|cuda'`. Si aparece Vulkan, se recompila con `-DGGML_VULKAN=OFF -DBUILD_SHARED_LIBS=OFF` y se re-verifica. No se empaqueta hasta pasar este check.

## Archivos a tocar

| Archivo | Cambio |
|---|---|
| `bin/transcribe-cli` | **NUEVO** — copia del binario CPU (fuera de `dist/`, lo empaqueta el Makefile) |
| `Makefile` | añadir `@cp -r bin dist/` en la regla del zip (línea 27-30) |
| `.gitignore` | excluir `bin/transcribe-cli` si procede (decidir: al ser un artefacto grande, podría no commitearse — ver nota) |
| `src/config/settings.ts` | +`CLI_MODE: 'cli-mode'` key, +`CliMode = 'manual'\|'auto'` type |
| `schemas/...gschema.xml` | +key `cli-mode` con `<choices>` manual/auto, **default `'auto'`** |
| `src/extension/cli-resolver.ts` | **NUEVO** — resolutor de path puro (sin spawn): devuelve el binario a usar según el modo |
| `src/extension/asr-service.ts` | gate de `_startRecording` (~línea 137) respeta el modo |
| `src/extension/transcriber.ts` | `_buildArgvOptions` (~línea 187) usa el resolver para `cliPath` |
| `src/prefs/index.ts` | ComboRow "Binary mode", mostrar/ocultar el campo de path manual, info del binario auto, y `validateSetup` adaptado |

## Diseño detallado

### 1. Settings y schema
- `settings.ts`: añadir `CLI_MODE: 'cli-mode'` y `export type CliMode = 'manual' | 'auto';`.
- `gschema.xml`: `<key name="cli-mode" type="s"><choices><choice value="manual"/><choice value="auto"/></choices><default>'auto'</default>...</key>` — default `auto` para que "funcione por defecto".

### 2. Paquetetizado del binario CPU
- Copiar `transcribe.cpp_vulkan/build-cpu/bin/transcribe-cli` → `plane-asr/bin/transcribe-cli`.
- En el `Makefile`, regla `$(NAME)@$(DOMAIN).zip` (líneas 27-30): añadir `@cp -r bin dist/` junto a los demás `cp`. Así `bin/transcribe-cli` acaba en el zip y, al instalar, en `${extensionDir}/bin/transcribe-cli`.
- En runtime, `extensionDir` (=`this.path`) apunta al raíz instalado, así que el binario está en `${extensionDir}/bin/transcribe-cli`.
- **Nota de git**: `bin/transcribe-cli` es un binario de 4.2MB. Se evaluará commitearlo (simple, reproducible para quien clone) vs. gitignorarlo + documentar `make download-cli`/ruta. Recomendación inicial: **commitearlo** dado que no hay un release GitHub público de donde descargarlo, y simplifica el `make pack`. Se confirmará al implementar.

### 3. `src/extension/cli-resolver.ts` (nuevo, puro, sin dependencias GJS pesadas)
```ts
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const BUNDLED_SUBPATH = ['bin', 'transcribe-cli'];

/** Resuelve el binario empaquetado: ${extensionDir}/bin/transcribe-cli. */
export function bundledCliPath(extensionDir: string): string {
    return GLib.build_filenamev([extensionDir, ...BUNDLED_SUBPATH]);
}

/** ¿El binario empaquetado existe y es ejecutable en esta arquitectura? */
export function bundledCliAvailable(extensionDir: string): boolean {
    const p = bundledCliPath(extensionDir);
    const f = Gio.File.new_for_path(p);
    if (!f.query_exists(null)) return false;
    try {
        const info = f.query_info('access::can-execute',
            Gio.FileQueryInfoFlags.NONE, null);
        return info.get_attribute_boolean('access::can-execute');
    } catch {
        return false;
    }
}

/** Busca un CLI en PATH (fallback para arquitecturas sin binario empaquetado). */
export function findCliInPath(name: string): string | null {
    return GLib.find_program_in_path(name) ?? null;
}
```
Patrón análogo a cómo `recorder.ts` usa `GLib.find_program_in_path('pw-record')`. Sin spawn, barato.

### 4. `asr-service.ts` — gate de grabación (~línea 137-143)
Reemplazar el bloque que valida `cli-path` por:
```ts
const mode = this._settings.get_string('cli-mode') ?? 'auto';
let missing: string | null = null;
if (mode === 'manual') {
    const cliPath = this._settings.get_string('cli-path') ?? '';
    if (!cliPath || !Gio.File.new_for_path(cliPath).query_exists(null))
        missing = _('ASR binary not found. Set it in preferences.');
} else {
    // auto: binario empaquetado, o fallback a PATH
    if (this._opts.extensionDir && bundledCliAvailable(this._opts.extensionDir)) {
        // ok, el transcriber lo resolverá
    } else {
        const name = getBackend(this._settings.get_string('asr-backend') ?? 'transcribe-cli').defaultCliName;
        if (!name || !findCliInPath(name)) {
            missing = _('No bundled ASR binary for this architecture. ' +
                'Install transcribe-cli or switch to manual mode.');
        }
    }
}
if (missing) { this._setState(AsrState.Idle, {error: missing}); return; }
```

### 5. `transcriber.ts` — `_buildArgvOptions` (~línea 186-193)
Reemplazar `cliPath: this._settings.get_string('cli-path') ?? ''` por una resolución que respete el modo:
```ts
const mode = this._settings.get_string('cli-mode') ?? 'auto';
let cliPath: string;
if (mode === 'manual') {
    cliPath = this._settings.get_string('cli-path') ?? '';
} else {
    // auto: empaquetado优先, fallback a PATH
    cliPath = (this._opts.extensionDir && bundledCliAvailable(this._opts.extensionDir))
        ? bundledCliPath(this._opts.extensionDir)
        : (findCliInPath('transcribe-cli') ?? '');
}
return { cliPath, modelParams, realtime, customTemplate, audioPath, features };
```
El resto del flujo (`getBackend(...).buildArgv(opts)` con `argv[0] = cliPath`) queda intacto — el cambio es solo de dónde viene `cliPath`.

### 6. `prefs/index.ts` — UI (~líneas 282-325 y `syncBackendRows` 590-618)
- Añadir un `Adw.ComboRow` **"Binary mode"** (opciones: Automático / Manual) justo encima del `cliPathRow`, con sync bidireccional a `cli-mode` (mismo patrín que `backendRow`↔`asr-backend`).
- Nueva función `syncCliMode()` conectada a `changed::cli-mode`:
  - `auto`: insensibilizar y ocultar `cliPathRow`; mostrar una `Adw.ActionRow` informativa con subtítulo:
    - si `bundledCliAvailable` → "Usando binario CPU empaquetado (transcribe-cli x86_64)".
    - si no y `findCliInPath('transcribe-cli')` → "Usando transcribe-cli del sistema (PATH)".
    - si ninguno → "No se encontró binario. Cambia a modo manual o instala transcribe-cli." (en color de error/warning).
  - `manual`: mostrar `cliPathRow` activo (como hoy); ocultar la fila informativa.
- `validateSetup()` (~línea 107-132): en modo `auto`, no validar `cli-path` (validar el binario empaquetado/en PATH en su lugar); en `manual`, comportamiento actual.

### 7. Verificación
1. `ldd` + `grep vulkan/cuda` sobre `bin/transcribe-cli` (precondición).
2. `pnpm run build` (tsc typecheck).
3. `pnpm run lint`.
4. `make pack` → verificar que el zip incluye `bin/transcribe-cli`.
5. Probar manualmente: con `cli-mode=auto`, una transcripción debe usar el binario empaquetado sin que `cli-path` esté configurado.

## Lo que NO se hace (honestidad)
- **No hay descarga automática de GPU/CUDA.** El usuario que quiera aceleración compila su propio binario y usa modo manual. Esto cumple exactamente tu idea: "CPU por defecto (auto), GPU la pone el usuario (manual)".
- **Solo x86_64 empaquetado.** ARM64/otros caen a fallback-PATH o modo manual.
- **No se toca el accelerator.** El usuario puede seguir poniendo `accelerator='cpu'`/`'vulkan'`/`'auto'` independientemente; el binario CPU empaquetado simplemente ignorará flags de Vulkan (es solo-CPU).

## Orden de ejecución
1. Verificar `ldd` del binario CPU (gate); copiar a `bin/transcribe-cli`.
2. Settings + schema (`cli-mode`).
3. `cli-resolver.ts`.
4. `asr-service.ts` + `transcriber.ts` (respetan el modo).
5. Makefile (`cp -r bin dist/`).
6. `prefs/index.ts` (UI).
7. Build + lint + pack + verificación.