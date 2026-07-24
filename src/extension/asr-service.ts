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
import {
    SAMPLE_RATE,
    cleanupChunks,
    getWavDataOffset,
    wavAvailableSamples,
    writeWavChunk,
} from './audio-chunker.js';
import { copyToClipboard, pasteAtCursor } from '../util/paste.js';
import { dedupChunkJoin } from '../util/text-merge.js';

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
    /** Progress label while transcribing several chunks, e.g. "2/5". */
    progress?: string;
}

type ChangeCb = (state: AsrState, ctx?: AsrChangeContext) => void;

/**
 * Mutable state of one live-transcription run. Held per recording so a cancelled
 * worker keeps its own view even after a new recording starts (the worker only
 * ever touches the object it was handed, never the service's current session).
 */
interface StreamSession {
    /** Set once the recorder has stopped, so the worker drains the tail. */
    ended: boolean;
    /** Set on cancel; the worker exits without emitting more text. */
    cancelled: boolean;
    /** Transcribed pieces in order, joined for the final total. */
    texts: string[];
    /** Byte offset of the PCM data in the WAV, once the header is readable. */
    dataOffset: number | null;
}

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
    /** Active live-transcription session while streaming; null otherwise. */
    private _stream: StreamSession | null = null;
    /** Resolves when the live worker has fully drained the recording. */
    private _streamDone: Promise<void> | null = null;

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
        if (this._stream) this._stream.cancelled = true;
        if (this._recorder.isRecording()) {
            this._recorder.stop().catch(e => logError(e));
        }
        this._transcriber.forceExit();
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
            return;
        }

        // Kick off live transcription: while the recorder keeps appending to
        // the WAV, a background worker carves ready N-second chunks off the tail
        // and streams each one out (pasted or copied) so the first words land
        // while the user is still speaking. With chunking off we fall back to a
        // single whole-file pass on stop.
        if (this._streamingEnabled()) {
            const session: StreamSession = {
                ended: false,
                cancelled: false,
                texts: [],
                dataOffset: null,
            };
            this._stream = session;
            this._streamDone = this._runStream(audioPath, session);
        }
    }

    private async _stopAndTranscribe(): Promise<void> {
        const audioPath = this._currentAudioPath;
        this._currentAudioPath = null;
        try {
            await this._recorder.stop();
        } catch (e) {
            if (this._stream) this._stream.cancelled = true;
            this._setState(AsrState.Idle, { error: this._errMsg(e) });
            return;
        }

        if (!audioPath) {
            this._setState(AsrState.Idle);
            return;
        }

        // The WAV is finalized now, so record it as the openable "last audio".
        this._settings.set_string(SETTINGS_KEYS.LAST_AUDIO_PATH, audioPath);

        const isPaste =
            (this._settings.get_string('output-mode') ?? 'clipboard') ===
            'paste';

        const session = this._stream;
        if (session) {
            // Live path: signal end-of-recording, let the worker transcribe the
            // trailing partial chunk, then publish the joined total.
            this._setState(AsrState.Transcribing);
            session.ended = true;
            try {
                await this._streamDone;
            } catch (e) {
                this._stream = null;
                this._streamDone = null;
                this._setState(AsrState.Idle, { error: this._errMsg(e) });
                return;
            }
            this._stream = null;
            this._streamDone = null;
            if (session.cancelled) {
                this._setState(AsrState.Idle);
                return;
            }
            // The full transcript is always copied so "Copy last text" and the
            // clipboard hold every chunk joined together, even in paste mode.
            const full = session.texts.join(' ').trim();
            this._settings.set_string(SETTINGS_KEYS.LAST_TEXT, full);
            if (full) copyToClipboard(full);
            Main.notify(
                isPaste
                    ? _('Plane ASR: transcription pasted')
                    : _('Plane ASR: transcription copied')
            );
            this._setState(AsrState.Idle, { text: full });
            return;
        }

        // Non-streaming path: transcribe the whole recording in one pass.
        await this._transcribeWhole(audioPath, isPaste);
    }

    /** Transcribe a whole WAV at once (chunking disabled). */
    private async _transcribeWhole(
        audioPath: string,
        isPaste: boolean
    ): Promise<void> {
        this._setState(AsrState.Transcribing);
        try {
            const result = await this._transcriber.transcribe(audioPath);
            if (result.cancelled) {
                this._setState(AsrState.Idle);
                return;
            }
            const full = result.text.trim();
            this._settings.set_string(SETTINGS_KEYS.LAST_TEXT, full);
            if (full) {
                if (isPaste) await pasteAtCursor(full);
                else copyToClipboard(full);
            }
            Main.notify(
                isPaste
                    ? _('Plane ASR: transcription pasted')
                    : _('Plane ASR: transcription copied')
            );
            this._setState(AsrState.Idle, { text: full });
        } catch (e) {
            this._setState(AsrState.Idle, { error: this._errMsg(e) });
        }
    }

    /**
     * Live-transcription worker. Loops until the session is cancelled or the
     * recording has ended and every sample has been transcribed. Each iteration:
     * waits for a full N-second chunk (or, once ended, the shorter remainder),
     * writes it to a temp WAV, transcribes it and streams the text out.
     *
     * Consecutive windows overlap by `overlapSeconds` so a word straddling a seam
     * is re-transcribed and the duplicate is removed with fuzzy text matching
     * (the ASR gives no timestamps to do it deterministically). With overlap 0
     * the windows are contiguous and dedup is skipped, matching the legacy path.
     *
     * Only this worker touches the transcriber while streaming, so runs never
     * overlap. Any transcription/IO error rejects the returned promise, which
     * `_stopAndTranscribe` surfaces to the UI.
     */
    private async _runStream(
        audioPath: string,
        session: StreamSession
    ): Promise<void> {
        const isPaste =
            (this._settings.get_string('output-mode') ?? 'clipboard') ===
            'paste';
        const chunkSamples = Math.max(
            1,
            Math.floor(
                this._settings.get_int(SETTINGS_KEYS.CHUNK_SECONDS) * SAMPLE_RATE
            )
        );
        const overlapSeconds = Math.max(
            0,
            this._settings.get_int(SETTINGS_KEYS.CHUNK_OVERLAP_SECONDS)
        );
        // Keep at least 1 s of fresh audio per chunk so the window keeps moving
        // forward even for a large overlap on a short chunk.
        const overlapSamples = Math.min(
            overlapSeconds * SAMPLE_RATE,
            chunkSamples - SAMPLE_RATE
        );
        const step = chunkSamples - Math.max(0, overlapSamples);
        // How many words of head we are willing to drop at each seam. Scales
        // with the overlap so longer re-transcription can match longer phrases;
        // 0 disables dedup entirely (contiguous-window path).
        const maxOverlapWords =
            overlapSamples > 0
                ? Math.max(3, Math.ceil((overlapSeconds * 5) + 2))
                : 0;

        const cacheDir = GLib.build_filenamev([
            GLib.get_user_cache_dir(),
            CACHE_DIR_NAME,
        ]);
        const base = GLib.path_get_basename(audioPath).replace(/\.wav$/i, '');
        let part = 0;
        // Start of the current window in samples; advances by `step` each pass.
        let cursor = 0;
        // Highest sample offset already fed to the transcriber. `cursor` can lag
        // behind it (overlap), so termination is tracked on the covered span.
        let covered = 0;
        // Full (untrimmed) transcript of the previous chunk, used as the
        // reference tail for the next seam's dedup.
        let lastFull = '';

        while (!session.cancelled) {
            // The recorder writes the WAV header first; wait for it to appear.
            if (session.dataOffset === null) {
                session.dataOffset = getWavDataOffset(audioPath);
                if (session.dataOffset === null) {
                    if (session.ended) break; // never produced a valid header
                    await this._sleep(200);
                    continue;
                }
            }

            const available = wavAvailableSamples(
                audioPath,
                session.dataOffset
            );

            let take: number;
            const need = cursor + chunkSamples;
            if (available >= need) {
                take = chunkSamples; // a full N-second window is ready
            } else if (session.ended) {
                // Recording stopped: transcribe whatever tail hasn't been
                // covered yet (may be shorter than a full window, or empty).
                const tail = available - covered;
                if (tail <= 0) break; // fully drained
                take = Math.min(chunkSamples, tail);
            } else {
                await this._sleep(300); // keep waiting for more audio
                continue;
            }

            const outPath = GLib.build_filenamev([
                cacheDir,
                `${base}_live${++part}.wav`,
            ]);
            let piece = '';
            try {
                writeWavChunk(
                    audioPath,
                    session.dataOffset,
                    cursor,
                    take,
                    outPath
                );
                const result = await this._transcriber.transcribe(outPath);
                if (result.cancelled) {
                    session.cancelled = true;
                    break;
                }
                piece = result.text.trim();
            } finally {
                cleanupChunks([outPath]);
            }

            // Advance past what we just read. `covered` moves to the window's
            // end; `cursor` advances by `step`, re-reading the overlap tail.
            covered = cursor + take;
            cursor += step;

            if (!piece) {
                lastFull = ''; // no text to anchor the next seam against
                continue;
            }

            // Strip the overlap duplicate from this piece's head (skipped on the
            // first chunk and whenever overlap is off). The full, untrimmed
            // piece is what gets carried forward as the reference tail.
            const emitted =
                lastFull && maxOverlapWords > 0
                    ? dedupChunkJoin(lastFull, piece, maxOverlapWords)
                    : piece;
            lastFull = piece;
            if (!emitted) continue; // whole piece was overlap

            if (isPaste) {
                // A leading space on every piece but the first keeps words from
                // running together, mirroring the ' ' join used for the total.
                await pasteAtCursor(
                    session.texts.length === 0 ? emitted : ` ${emitted}`
                );
            } else {
                // Progressive clipboard: the running total is always ready to
                // paste even before the recording stops.
                copyToClipboard([...session.texts, emitted].join(' '));
            }
            session.texts.push(emitted);
        }
    }

    /** Whether long recordings should be transcribed live in N-second chunks. */
    private _streamingEnabled(): boolean {
        return (
            this._settings.get_boolean(SETTINGS_KEYS.CHUNK_ENABLED) &&
            this._settings.get_int(SETTINGS_KEYS.CHUNK_SECONDS) > 0
        );
    }

    /** Promise that resolves after `ms` via a GLib main-loop timeout. */
    private _sleep(ms: number): Promise<void> {
        return new Promise(resolve => {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                resolve();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    // -- helpers -----------------------------------------------------------

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
