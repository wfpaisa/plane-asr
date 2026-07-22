/* asr-service.ts
 *
 * Orchestrates the record -> transcribe -> output pipeline and exposes a tiny
 * state machine to the UI. The `Indicator` only observes states and calls
 * `toggle()` / `cancel()`; all subprocess bookkeeping lives here.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { SETTINGS_KEYS } from '../config/settings.js';
import { Recorder } from './recorder.js';
import { Transcriber } from './transcriber.js';
import { copyToClipboard, pasteAtCursor } from '../util/paste.js';

/** Coarse lifecycle states surfaced to the UI. */
export enum AsrState {
    Idle,
    Recording,
    Transcribing,
}

/** Optional context passed alongside a state change. */
export interface AsrChangeContext {
    /** Error message, when transitioning back to Idle after a failure. */
    error?: string;
    /** Transcription text produced this cycle, when available. */
    text?: string;
}

type ChangeCb = (state: AsrState, ctx?: AsrChangeContext) => void;

const CACHE_DIR_NAME = 'planeasr';

/**
 * Single owner of the {@link Recorder} and {@link Transcriber}. Drives the
 * IDLE -> RECORDING -> TRANSCRIBING -> IDLE cycle and dispatches the resulting
 * text to the clipboard or the focused widget.
 */
export class AsrService {
    private _settings: Gio.Settings;
    private _onChange: ChangeCb;
    private _state: AsrState = AsrState.Idle;
    private _recorder = new Recorder();
    private _transcriber: Transcriber;
    private _currentAudioPath: string | null = null;

    constructor(settings: Gio.Settings, onChange: ChangeCb) {
        this._settings = settings;
        this._onChange = onChange;
        this._transcriber = new Transcriber(settings);
    }

    /** Current lifecycle state. */
    get state(): AsrState {
        return this._state;
    }

    /**
     * Advance the state machine:
     * - Idle        -> start recording
     * - Recording   -> stop and transcribe
     * - Transcribing -> ignored (use {@link cancel})
     */
    async toggle(): Promise<void> {
        switch (this._state) {
            case AsrState.Idle:
                await this._startRecording();
                break;
            case AsrState.Recording:
                await this._stopAndTranscribe();
                break;
            case AsrState.Transcribing:
                // Intentionally a no-op; the user can cancel explicitly.
                break;
        }
    }

    /** Abort whatever is running and return to Idle. */
    cancel(): void {
        if (this._state === AsrState.Recording) {
            this._recorder.stop().catch(e => logError(e));
        } else if (this._state === AsrState.Transcribing) {
            this._transcriber.forceExit();
        }
        this._currentAudioPath = null;
        this._setState(AsrState.Idle);
    }

    /** Tear down everything on extension disable. */
    destroy(): void {
        this.cancel();
    }

    // -- state transitions -------------------------------------------------

    private async _startRecording(): Promise<void> {
        const cliPath = this._settings.get_string('cli-path') ?? '';
        if (!cliPath || !Gio.File.new_for_path(cliPath).query_exists(null)) {
            this._setState(AsrState.Idle, {
                error: _('ASR binary not found. Set it in preferences.'),
            });
            return;
        }

        const audioPath = this._newAudioPath();
        this._currentAudioPath = audioPath;

        try {
            this._recorder.start(audioPath);
            this._setState(AsrState.Recording);
        } catch (e) {
            this._currentAudioPath = null;
            this._setState(AsrState.Idle, { error: this._errMsg(e) });
        }
    }

    private async _stopAndTranscribe(): Promise<void> {
        const audioPath = this._currentAudioPath;
        this._currentAudioPath = null;
        try {
            await this._recorder.stop();
        } catch (e) {
            this._setState(AsrState.Idle, { error: this._errMsg(e) });
            return;
        }

        if (!audioPath) {
            this._setState(AsrState.Idle);
            return;
        }

        // The WAV is finalized now, so record it as the openable "last audio".
        this._settings.set_string(SETTINGS_KEYS.LAST_AUDIO_PATH, audioPath);

        this._setState(AsrState.Transcribing);
        try {
            const result = await this._transcriber.transcribe(audioPath);
            if (result.cancelled) {
                this._setState(AsrState.Idle);
                return;
            }
            this._settings.set_string(SETTINGS_KEYS.LAST_TEXT, result.text);
            const pasted = this._dispatch(result.text);
            Main.notify(
                pasted
                    ? _('Plane ASR: transcription pasted')
                    : _('Plane ASR: transcription copied')
            );
            this._setState(AsrState.Idle, { text: result.text });
        } catch (e) {
            this._setState(AsrState.Idle, { error: this._errMsg(e) });
        }
    }

    // -- helpers -----------------------------------------------------------

    private _dispatch(text: string): boolean {
        const mode = this._settings.get_string('output-mode');
        if (mode === 'paste') {
            pasteAtCursor(text);
            return true;
        }
        copyToClipboard(text);
        return false;
    }

    private _setState(state: AsrState, ctx?: AsrChangeContext): void {
        this._state = state;
        this._onChange(state, ctx);
    }

    private _newAudioPath(): string {
        const dir = GLib.build_filenamev([
            GLib.get_user_cache_dir(),
            CACHE_DIR_NAME,
        ]);
        GLib.mkdir_with_parents(dir, 0o755);
        const stamp = GLib.get_real_time(); // microseconds since epoch
        return GLib.build_filenamev([dir, `recording_${stamp}.wav`]);
    }

    private _errMsg(e: unknown): string {
        return e instanceof GLib.Error ? e.message : String(e);
    }
}
