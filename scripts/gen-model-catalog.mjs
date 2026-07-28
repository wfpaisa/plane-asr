#!/usr/bin/env node
// Genera src/models/model-catalog-data.ts a partir de data/model-catalog.json,
// para que el catálogo de modelos se importe como módulo ESM en vez de
// leerse con IO síncrono de archivo en runtime (Gio.File.load_contents),
// que las directrices de revisión de extensiones GNOME desaconsejan en
// código del shell. Se ejecuta como parte de `pnpm run build`; el archivo
// generado no se versiona (ver .gitignore), igual que dist/.

import {readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const srcPath = path.join(root, 'data', 'model-catalog.json');
const outPath = path.join(root, 'src', 'models', 'model-catalog-data.ts');

const raw = readFileSync(srcPath, 'utf8');
JSON.parse(raw); // valida que el JSON sea sintácticamente correcto antes de embeberlo

const header =
    '/* model-catalog-data.ts\n' +
    ' *\n' +
    ' * GENERADO por scripts/gen-model-catalog.mjs a partir de\n' +
    ' * data/model-catalog.json. No editar a mano — editar el JSON y correr\n' +
    ' * `pnpm run build` (o el script directamente) para regenerarlo.\n' +
    ' *\n' +
    ' * SPDX-License-Identifier: GPL-2.0-or-later\n' +
    ' */\n\n' +
    "import type {ModelCatalog} from './catalog.js';\n\n" +
    'export const MODEL_CATALOG: ModelCatalog = ';

// Nota: sin `as const` — el catálogo se tipa contra la interfaz mutable
// `ModelCatalog` (arrays no readonly), y combinar `as const` con una
// anotación de tipo mutable falla a compilar (TS rechaza asignar
// `readonly T[]` a `T[]`).
writeFileSync(outPath, `${header}${raw.trim()};\n`);
