/* model-store.ts
 *
 * In-memory state of downloads and catalog presence, exposed as a GObject
 * singleton emitting signals so both the extension and the preferences UI can
 * observe download progress / completion without polling.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

import type {ModelFile} from './catalog.js';

/** Per-model download progress payload. */
export interface DownloadProgress {
    modelId: string;
    /** Bytes downloaded so far (includes any resumed prefix). */
    downloaded: number;
    /** Total expected bytes (0 if unknown). */
    total: number;
    /** 0..1 fraction, or -1 when total is unknown. */
    fraction: number;
}

/** Singleton download-state store. */
export const ModelStore = GObject.registerClass(
    {
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
    },
    class ModelStoreClass extends GObject.Object {
        /** modelId -> active download descriptor. */
        private _active = new Map<string, ActiveDownload>();

        getActiveDownload(modelId: string): ActiveDownload | null {
            return this._active.get(modelId) ?? null;
        }

        isDownloading(modelId: string): boolean {
            return this._active.has(modelId);
        }

        /** Currently downloading model ids. */
        get activeIds(): string[] {
            return [...this._active.keys()];
        }

        markStarted(
            modelId: string,
            file: ModelFile,
            cancellable: Gio.Cancellable
        ): void {
            this._active.set(modelId, {file, cancellable});
            this.emit('download-started', modelId);
        }

        markProgress(modelId: string, downloaded: number, total: number): void {
            const fraction = total > 0 ? downloaded / total : -1;
            this.emit('download-progress', modelId, fraction);
        }

        markComplete(modelId: string): void {
            this._active.delete(modelId);
            this.emit('download-complete', modelId);
        }

        markFailed(modelId: string, message: string): void {
            this._active.delete(modelId);
            this.emit('download-failed', modelId, message);
        }

        markCancelled(modelId: string): void {
            this._active.delete(modelId);
            this.emit('download-cancelled', modelId);
        }

        markDeleted(modelId: string): void {
            this.emit('model-deleted', modelId);
        }
    }
);

/** Tracked in-flight download. */
export interface ActiveDownload {
    file: ModelFile;
    cancellable: Gio.Cancellable;
}

/** Process-wide singleton. Lazily created on first access. */
let _instance: InstanceType<typeof ModelStore> | null = null;

export function getModelStore(): InstanceType<typeof ModelStore> {
    if (!_instance) _instance = new ModelStore();
    return _instance;
}
