/* model-store.ts
 *
 * Estado en memoria de las descargas y de qué modelos están presentes en el
 * catálogo, expuesto como un singleton GObject que emite señales para que
 * tanto la extensión como la interfaz de preferencias puedan observar el
 * progreso/finalización de descargas sin necesidad de sondeo (polling).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import GObject from 'gi://GObject';
/**
 * Almacén singleton del estado de descargas.
 *
 * Para qué: centralizar el estado de qué modelos se están descargando y
 * emitir señales GObject (`download-started`, `download-progress`, etc.)
 * para que cualquier widget interesado (extensión o preferencias) se
 * actualice reactivamente en vez de tener que consultar el estado a mano.
 */
export const ModelStore = GObject.registerClass({
    Signals: {
        'download-started': {
            param_types: [GObject.TYPE_STRING],
        },
        'download-progress': {
            param_types: [
                GObject.TYPE_STRING, // modelId
                GObject.TYPE_DOUBLE, // fraction 0..1 (-1 unknown)
            ],
        },
        'download-complete': {
            param_types: [GObject.TYPE_STRING],
        },
        'download-failed': {
            param_types: [GObject.TYPE_STRING, GObject.TYPE_STRING],
        },
        'download-cancelled': {
            param_types: [GObject.TYPE_STRING],
        },
        'model-deleted': {
            param_types: [GObject.TYPE_STRING],
        },
    },
}, class ModelStoreClass extends GObject.Object {
    constructor() {
        super(...arguments);
        /** modelId -> descriptor de descarga activa. */
        this._active = new Map();
    }
    /** Devuelve la descarga activa de un modelo, o null si no hay ninguna en curso. */
    getActiveDownload(modelId) {
        return this._active.get(modelId) ?? null;
    }
    /** Indica si el modelo dado se está descargando actualmente. */
    isDownloading(modelId) {
        return this._active.has(modelId);
    }
    /** Ids de los modelos que se están descargando actualmente. */
    get activeIds() {
        return [...this._active.keys()];
    }
    /** Registra el inicio de una descarga y emite la señal `download-started`. */
    markStarted(modelId, file, cancellable) {
        this._active.set(modelId, { file, cancellable });
        this.emit('download-started', modelId);
    }
    /** Calcula la fracción descargada y emite `download-progress`. */
    markProgress(modelId, downloaded, total) {
        const fraction = total > 0 ? downloaded / total : -1;
        this.emit('download-progress', modelId, fraction);
    }
    /** Marca la descarga como completa, la retira del mapa activo y emite `download-complete`. */
    markComplete(modelId) {
        this._active.delete(modelId);
        this.emit('download-complete', modelId);
    }
    /** Marca la descarga como fallida, la retira del mapa activo y emite `download-failed` con el motivo. */
    markFailed(modelId, message) {
        this._active.delete(modelId);
        this.emit('download-failed', modelId, message);
    }
    /** Marca la descarga como cancelada, la retira del mapa activo y emite `download-cancelled`. */
    markCancelled(modelId) {
        this._active.delete(modelId);
        this.emit('download-cancelled', modelId);
    }
    /** Emite `model-deleted` cuando el usuario borra un modelo ya descargado. */
    markDeleted(modelId) {
        this.emit('model-deleted', modelId);
    }
});
/**
 * Singleton a nivel de proceso, creado de forma perezosa en el primer
 * acceso para que la extensión y las preferencias compartan la misma
 * instancia dentro del mismo proceso GJS.
 */
let _instance = null;
/** Devuelve la instancia única del store, creándola en la primera llamada. */
export function getModelStore() {
    if (!_instance)
        _instance = new ModelStore();
    return _instance;
}
//# sourceMappingURL=model-store.js.map