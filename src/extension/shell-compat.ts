/* shell-compat.ts
 *
 * Capa delgada que concentra las llamadas a GNOME Shell sensibles a la
 * versión detrás de funciones nombradas. Plane ASR toca muy poco del Shell
 * (indicador de panel, atajos globales, estado de modificadores del puntero),
 * así que una capa `API` completa al estilo de otras extensiones sería
 * prematura. Esto es lo mínimo: si `Main.wm.addKeybinding`, `addToStatusArea`
 * o la firma de `global.get_pointer()` cambian en Shell 51+, se arregla aquí
 * en un solo sitio en vez de esparcido por `index.ts`.
 *
 * No abstrae `PanelMenu.Button` (una extensión de clase en indicator.ts, no
 * una llamada): envolverla no aportaría un punto único de arreglo, solo
 * ceremonia.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import type * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

/**
 * Añade un indicador a la barra superior bajo `role` (por convención el uuid
 * de la extensión). Envuelve `Main.panel.addToStatusArea`.
 */
export function addPanelIndicator(
    role: string,
    indicator: PanelMenu.Button
): void {
    Main.panel.addToStatusArea(role, indicator);
}

/**
 * Registra un atajo global respaldado por la clave `name` de GSettings,
 * disponible en todos los modos del Shell. Envuelve `Main.wm.addKeybinding`
 * con las banderas/modos fijos que usa esta extensión, para que quien lo
 * llame solo pase la clave y el handler.
 */
export function addGlobalKeybinding(
    name: string,
    settings: Gio.Settings,
    handler: () => void
): void {
    Main.wm.addKeybinding(
        name,
        settings,
        Meta.KeyBindingFlags.NONE,
        Shell.ActionMode.ALL,
        handler
    );
}

/** Retira un atajo registrado con {@link addGlobalKeybinding}. */
export function removeKeybinding(name: string): void {
    Main.wm.removeKeybinding(name);
}

/**
 * Devuelve la máscara actual de modificadores del teclado/puntero.
 * `global.get_pointer()` devuelve `[x, y, modifiers]`; esto expone solo el
 * tercer elemento, que es lo único que el modo "mantener para hablar"
 * necesita sondear.
 */
export function pointerModifiers(): number {
    return global.get_pointer()[2];
}
