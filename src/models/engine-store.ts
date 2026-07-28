/* engine-store.ts
 *
 * Estado en memoria de la descarga del binario del motor, expuesto como un
 * singleton GObject que emite señales para que tanto la extensión como la
 * interfaz de preferencias observen el progreso sin necesidad de sondeo.
 * Análogo a model-store.ts, pero para un único artefacto global (el
 * binario `transcribe-cli`) en vez de un mapa por id de modelo.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

/** Almacén singleton del estado de la descarga del motor. */
export const EngineStore = GObject.registerClass(
    {
        Signals: {
            'download-started': {},
            'download-progress': {
                param_types: [GObject.TYPE_DOUBLE], // fraction 0..1 (-1 unknown)
            },
            'download-complete': {},
            'download-failed': {
                param_types: [GObject.TYPE_STRING],
            },
            'download-cancelled': {},
        },
    },
    class EngineStoreClass extends GObject.Object {
        private _active: Gio.Cancellable | null = null;

        /** Indica si hay una descarga del motor en curso actualmente. */
        get isDownloading(): boolean {
            return this._active !== null;
        }

        /** Registra el inicio de la descarga y emite `download-started`. */
        markStarted(cancellable: Gio.Cancellable): void {
            this._active = cancellable;
            this.emit('download-started');
        }

        /** Calcula la fracción descargada y emite `download-progress`. */
        markProgress(downloaded: number, total: number): void {
            const fraction = total > 0 ? downloaded / total : -1;
            this.emit('download-progress', fraction);
        }

        /** Marca la descarga como completa y emite `download-complete`. */
        markComplete(): void {
            this._active = null;
            this.emit('download-complete');
        }

        /** Marca la descarga como fallida y emite `download-failed` con el motivo. */
        markFailed(message: string): void {
            this._active = null;
            this.emit('download-failed', message);
        }

        /** Marca la descarga como cancelada y emite `download-cancelled`. */
        markCancelled(): void {
            this._active = null;
            this.emit('download-cancelled');
        }

        /** Cancela la descarga en curso, si la hay (no-op si no hay ninguna). */
        cancel(): void {
            this._active?.cancel();
        }
    }
);

/**
 * Singleton a nivel de proceso, creado de forma perezosa en el primer
 * acceso para que la extensión y las preferencias compartan la misma
 * instancia dentro del mismo proceso GJS.
 */
let _instance: InstanceType<typeof EngineStore> | null = null;

/** Devuelve la instancia única del store, creándola en la primera llamada. */
export function getEngineStore(): InstanceType<typeof EngineStore> {
    if (!_instance) _instance = new EngineStore();
    return _instance;
}
