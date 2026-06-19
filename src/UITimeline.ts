/**
 * Copyright 2025 Ceeblue B.V.
 * This file is part of https://github.com/CeeblueTV/wrts-client which is released under GNU Affero General Public License.
 * See file LICENSE or go to https://spdx.org/licenses/AGPL-3.0-or-later.html for full license details.
 */

import { Util } from '@ceeblue/web-utils';
import * as Media from './media/Media';

const root = typeof window !== 'undefined' ? window : (global as unknown as Window);

/** Distinct row colors, assigned to tracks in order of first appearance. */
const PALETTE = ['#78b5bf', '#e6a817', '#9b7ede', '#6fbf8b', '#df7e7e', '#7e9cdf', '#c98bd0', '#b5a06f'];
// Reception-health colors (reception duration vs media duration of a sequence). Picked to read on
// both light and dark backgrounds.
const HEALTH_OK = '#28a745';
const HEALTH_WARN = '#e6a817';
const HEALTH_ERR = '#c0392b';
/** Accent used for the overview window highlight. */
const ACCENT = '#78b5bf';

/** Width (px) of the left gutter holding the per-track labels (not part of the draggable plot area). */
const LABEL_W = 92;
/** Drag-to-pan acceleration: each pixel covers `1 + min(ACCEL_MAX, |dx|/ACCEL_REF)` window-pixels. */
const ACCEL_REF = 8;
const ACCEL_MAX = 14;
/** How long (ms) the overview minimap stays bright after the last navigation gesture. */
const NAV_LINGER = 1400;
/** Height (px) of the overview minimap band at the bottom of the canvas. */
const OV_H = 16;
const OV_GAP = 6;

/** Media kind of a timeline row. */
export type UITimelineTrackType = 'video' | 'audio' | 'data';

/** Time axis used to position sequences. */
export type UITimelineAxis = 'media' | 'reception';

/**
 * One sequence (a group of consecutive samples) drawn as a single rectangle.
 *
 * A video sequence is a GOP, delimited by keyframes. Audio/data sequences inherit the number of the
 * video sequence current at reception time, so they line up vertically under the matching video
 * sequence (GOP alignment is NOT assumed: an audio sequence can start/end past its video sequence).
 * When there is no video track, audio/data fall back to reception-gap grouping with their own counter.
 */
type Sequence = {
    /** Sequence number (the current video sequence number, shared across tracks). */
    n: number;
    /** Media timestamp (DTS, ms) of the first / last sample. */
    dtsStart: number;
    dtsEnd: number;
    /** Wall-clock reception time (ms) of the first / last sample. */
    recvStart: number;
    recvEnd: number;
    /** Number of samples accumulated. */
    frames: number;
    /** Total payload bytes accumulated. */
    bytes: number;
    /** Whether the sequence opened on a keyframe. */
    key: boolean;
};

type Row = {
    id: number;
    type: UITimelineTrackType;
    color: string;
    seqs: Sequence[];
    cur?: Sequence;
    lastRecv: number;
    avgDelta: number;
    seqCounter: number;
};

type Hit = { x0: number; x1: number; y0: number; y1: number; s: Sequence; r: Row };

/**
 * A self-contained, themable canvas widget that visualizes received media sequences over time, one row
 * per track. It is the visual counterpart of the stats graph: where the graph plots scalar metrics,
 * {@link UITimeline} shows the structure of reception — sequences (GOPs) as rectangles, their size,
 * frame count, media-timestamp span and wall-clock reception span.
 *
 * Feed it the per-sample events exposed by {@link Player.onVideo}, {@link Player.onAudio} and
 * {@link Player.onData}. It owns its own canvas and hover tooltip inside the `container` you pass, and
 * redraws on its own animation frame loop. Drag the plot to pan back through the buffer (the faster the
 * drag, the faster it moves), or scrub the overview minimap at the bottom to jump anywhere.
 *
 * Two time axes are available (see {@link axis}):
 *  - `'media'`   — position by sample DTS, so cross-track desync is directly visible; reception health
 *                  is overlaid as a colored edge, and an optional playhead marks the playback time.
 *  - `'reception'` — position by wall-clock arrival, so late / slow tracks stand out.
 *
 * @example
 * const timeline = new UITimeline(document.getElementById('timeline'));
 * timeline.getMediaTime = () => player.currentTime * 1000; // optional playhead (ms)
 * player.onVideo = (track, sample) => timeline.pushVideo(track, sample);
 * player.onAudio = (track, sample) => timeline.pushAudio(track, sample);
 * player.onData  = (track, time, duration, data) => timeline.pushData(track, { time, duration, data });
 */
export class UITimeline {
    /** Maximum sequences retained per row (bounds memory; older sequences are dropped). */
    static MAX_SEQUENCES = 5000;

    /**
     * Event fired when {@link following} changes on its own (e.g. the user grabs the scrollbar, which
     * pauses live-follow). Lets a host UI keep a play/pause button in sync.
     * @param following the new {@link following} value
     * @event
     */
    onFollowingChange(following: boolean) {}

    /**
     * Optional provider for the playback position in milliseconds, used to draw the playhead on the
     * `'media'` axis. Return `undefined` to hide it. Typically `() => player.currentTime * 1000`.
     */
    getMediaTime?: () => number | undefined;

    /** The time axis used to position sequences. Defaults to `'reception'`. */
    get axis(): UITimelineAxis {
        return this._axis;
    }
    set axis(value: UITimelineAxis) {
        if (value === this._axis) {
            return;
        }
        const from = this._axis;
        this._axis = value;
        // Keep the same point in time visible across axes: the frozen view edge lives in the previous
        // axis' value space, so map it into the new one (DTS <-> reception). When following, render
        // re-pins it to the live edge anyway.
        if (!this._following) {
            this._viewEnd = this._mapValue(this._viewEnd, from, value);
        }
    }

    /** Visible time window in seconds. Defaults to 10. */
    get windowDuration(): number {
        return this._windowDuration;
    }
    set windowDuration(seconds: number) {
        this._windowDuration = Math.max(1, seconds);
    }

    /**
     * Whether the view stays pinned to the live edge (following) or is frozen for inspection.
     * Dragging the plot or scrubbing the overview sets this to `false` and fires {@link onFollowingChange}.
     */
    get following(): boolean {
        return this._following;
    }
    set following(value: boolean) {
        if (value === this._following) {
            return;
        }
        this._following = value;
        if (value) {
            this._snap = true; // jump back to live on resume
        }
        this.onFollowingChange(value);
    }

    /** True once at least one sample has been received. */
    get hasData(): boolean {
        return this._hasData;
    }

    private _container: HTMLElement;
    private _canvas: HTMLCanvasElement;
    private _tip: HTMLDivElement;

    private _rows: Map<number, Row> = new Map();
    private _order?: Row[];
    private _hits: Hit[] = [];

    private _axis: UITimelineAxis = 'reception';
    private _windowDuration = 10;
    private _following = true;
    private _hasData = false;

    private _hasVideo = false;
    private _videoSeq = -1;
    private _t0 = 0;

    private _viewEnd = 0; // right edge of the window, in the current axis' value space (ms)
    private _snap = true; // force the view edge back to the live edge on next render
    private _dataMin = 0; // earliest value across all rows, in the current axis' value space
    private _dataLo = 0; // earliest pannable edge (dataMin + window), in the current axis' value space
    private _dataHi = 0; // live edge (dataMax), in the current axis' value space
    private _plotW = 1; // width (px) of the plot area, for px↔value conversion while dragging

    private _dragging = false;
    private _ovDragging = false; // dragging the overview minimap (absolute scrub)
    private _lastX = 0;
    private _navUntil = 0; // overview stays bright until this time (ms), refreshed while navigating
    private _ovRect?: { x0: number; x1: number; y0: number; y1: number }; // overview band hit-box

    private _raf = 0;
    private _onMove: (e: MouseEvent) => void;
    private _onLeave: () => void;
    private _onDown: (e: MouseEvent) => void;
    private _onUp: () => void;

    /**
     * @param container element that will host the canvas, scrollbar and tooltip (it is emptied and made
     * `position: relative`)
     */
    constructor(container: HTMLElement) {
        this._container = container;
        if (getComputedStyle(container).position === 'static') {
            container.style.position = 'relative';
        }

        this._canvas = document.createElement('canvas');
        this._canvas.className = 'uitl-canvas';
        this._canvas.style.cssText = 'display:block;width:100%;cursor:grab;';

        this._tip = document.createElement('div');
        this._tip.className = 'uitl-tip';
        // Functional defaults; visual styling can be overridden via the `.uitl-tip` class.
        this._tip.style.cssText =
            'position:absolute;z-index:20;pointer-events:none;display:none;white-space:nowrap;' +
            'padding:7px 9px;border-radius:6px;font:11px/1.5 ui-monospace,monospace;' +
            'background:rgba(20,24,33,.96);color:#e7ecf3;box-shadow:0 4px 24px rgba(0,0,0,.45);';

        container.append(this._canvas, this._tip);

        this._onMove = e => this._move(e);
        this._onLeave = () => {
            this._tip.style.display = 'none';
        };
        this._onDown = e => this._down(e);
        this._onUp = () => this._up();
        this._canvas.addEventListener('mousemove', this._onMove);
        this._canvas.addEventListener('mouseleave', this._onLeave);
        this._canvas.addEventListener('mousedown', this._onDown);
        // Listen on the window so a drag that ends outside the canvas still releases.
        root.addEventListener('mouseup', this._onUp);

        const loop = () => {
            this.render();
            this._raf = root.requestAnimationFrame(loop);
        };
        this._raf = root.requestAnimationFrame(loop);
    }

    /** Ingest a received video sample (a new sequence starts at every keyframe). */
    pushVideo(track: number, sample: Media.Sample) {
        this._push('video', track, sample);
    }

    /** Ingest a received audio sample (grouped under the current video sequence). */
    pushAudio(track: number, sample: Media.Sample) {
        this._push('audio', track, sample);
    }

    /** Ingest a received data sample (grouped under the current video sequence). */
    pushData(track: number, sample: Media.Sample) {
        this._push('data', track, sample);
    }

    /** Clear all accumulated sequences and reset the view to live. */
    reset() {
        this._rows.clear();
        this._order = undefined;
        this._hits = [];
        this._hasData = false;
        this._hasVideo = false;
        this._videoSeq = -1;
        this._t0 = 0;
        this._viewEnd = 0;
        this._snap = true;
        this._following = true;
        this._tip.style.display = 'none';
    }

    /**
     * Export every retained sequence as CSV (`;`-separated). Reception times are relative to the first
     * received sample. Mirrors the metrics CSV export.
     */
    toCSV(): string {
        // Flatten every sequence across tracks and order by reception time, so the file reads as the
        // chronological arrival of sequences (more meaningful than grouping per track).
        const all: Array<{ row: Row; s: Sequence }> = [];
        for (const row of this._rows.values()) {
            for (const s of row.seqs) {
                all.push({ row, s });
            }
        }
        all.sort((a, b) => a.s.recvStart - b.s.recvStart);

        const lines = ['type;track;seq;frames;bytes;dtsStart_ms;dtsEnd_ms;recvStart_ms;recvEnd_ms;keyframe'];
        for (const { row, s } of all) {
            lines.push(
                [
                    row.type,
                    row.id,
                    s.n,
                    s.frames,
                    s.bytes,
                    s.dtsStart.toFixed(0),
                    s.dtsEnd.toFixed(0),
                    (s.recvStart - this._t0).toFixed(0),
                    (s.recvEnd - this._t0).toFixed(0),
                    s.key ? 1 : 0
                ].join(';')
            );
        }
        return lines.join('\n');
    }

    /** Stop the render loop and remove the elements/listeners created in the container. */
    destroy() {
        root.cancelAnimationFrame(this._raf);
        this._canvas.removeEventListener('mousemove', this._onMove);
        this._canvas.removeEventListener('mouseleave', this._onLeave);
        this._canvas.removeEventListener('mousedown', this._onDown);
        root.removeEventListener('mouseup', this._onUp);
        this._canvas.remove();
        this._tip.remove();
    }

    private _push(type: UITimelineTrackType, track: number, sample: Media.Sample) {
        if (!sample || sample.time == null) {
            return;
        }
        const now = Util.time();
        if (!this._t0) {
            this._t0 = now;
        }
        let row = this._rows.get(track);
        if (!row) {
            row = {
                id: track,
                type,
                color: PALETTE[this._rows.size % PALETTE.length],
                seqs: [],
                lastRecv: 0,
                avgDelta: 0,
                seqCounter: 0
            };
            this._rows.set(track, row);
            this._order = undefined; // re-sort rows on next render
        }

        const dur = sample.duration || 0;
        let n: number;
        let boundary: boolean;
        if (type === 'video') {
            this._hasVideo = true;
            if (sample.isKeyFrame) {
                ++this._videoSeq; // advance the shared sequence number on each GOP
            }
            n = this._videoSeq < 0 ? 0 : this._videoSeq;
            boundary = !row.cur || !!sample.isKeyFrame;
        } else if (this._hasVideo) {
            // Reference the video track: this sample belongs to the current video sequence.
            n = this._videoSeq < 0 ? 0 : this._videoSeq;
            boundary = !row.cur || row.cur.n !== n;
        } else {
            // No video track to reference yet: detect sequences from reception gaps (each WebRTS
            // sequence is a distinct request/burst), adapting the threshold to the track's cadence.
            const dt = row.lastRecv ? now - row.lastRecv : 0;
            boundary = !row.cur || (row.lastRecv > 0 && dt > Math.max(12, (row.avgDelta || 10) * 3));
            if (!boundary && row.lastRecv) {
                row.avgDelta = row.avgDelta ? row.avgDelta * 0.8 + dt * 0.2 : dt;
            }
            n = boundary ? row.seqCounter++ : (row.cur as Sequence).n;
        }

        if (boundary) {
            row.cur = {
                n,
                dtsStart: sample.time,
                dtsEnd: sample.time + dur,
                recvStart: now,
                recvEnd: now,
                frames: 0,
                bytes: 0,
                key: !!sample.isKeyFrame
            };
            row.seqs.push(row.cur);
            if (row.seqs.length > UITimeline.MAX_SEQUENCES) {
                row.seqs.splice(0, row.seqs.length - UITimeline.MAX_SEQUENCES);
            }
        }

        const s = row.cur as Sequence;
        ++s.frames;
        s.bytes += sample.data ? sample.data.byteLength : 0;
        s.dtsEnd = sample.time + dur;
        s.recvEnd = now;
        row.lastRecv = now;
        this._hasData = true;
    }

    /** Draws the current state. Called every animation frame; cheap no-op while hidden. */
    render() {
        const canvas = this._canvas;
        if (canvas.offsetParent === null) {
            return; // hidden (e.g. inactive tab)
        }
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            return;
        }

        const style = getComputedStyle(this._container);
        const colTxt = style.color || '#888';
        const colGrid = 'rgba(128,128,128,.22)';

        const dpr = root.devicePixelRatio || 1;
        const ROW_H = 34;
        const ROW_GAP = 6;
        const TOP = 8;
        const AXIS_H = 20;
        const cssW = this._container.clientWidth || 600;

        if (!this._order) {
            const rank = { video: 0, audio: 1, data: 2 };
            this._order = [...this._rows.values()].sort((a, b) => rank[a.type] - rank[b.type] || a.id - b.id);
        }
        const rows = this._order;

        const rowsBottom = TOP + rows.length * (ROW_H + ROW_GAP);
        const axisBottom = rowsBottom + AXIS_H; // bottom of the time-axis label band
        const cssH = rows.length ? axisBottom + OV_GAP + OV_H : 60;
        if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
            canvas.width = Math.round(cssW * dpr);
            canvas.height = Math.round(cssH * dpr);
            canvas.style.height = cssH + 'px';
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssW, cssH);

        if (!rows.length || !this._hasData) {
            ctx.fillStyle = colTxt;
            ctx.globalAlpha = 0.5;
            ctx.font = 'italic 12px sans-serif';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText('Waiting for media…', 12, cssH / 2);
            ctx.globalAlpha = 1;
            return;
        }

        const media = this._axis === 'media';
        const span = this._windowDuration * 1000;

        // Data bounds in the current axis' value space (seqs are time-ordered, so first/last suffice).
        let dataMin = Infinity;
        let dataMax = -Infinity;
        for (const r of rows) {
            if (!r.seqs.length) {
                continue;
            }
            const first = r.seqs[0];
            const last = r.seqs[r.seqs.length - 1];
            const a = media ? first.dtsStart : first.recvStart;
            const b = media ? last.dtsEnd : last.recvEnd;
            if (a < dataMin) {
                dataMin = a;
            }
            if (b > dataMax) {
                dataMax = b;
            }
        }
        if (!isFinite(dataMin)) {
            return;
        }

        const lo = dataMin + span;
        const hi = dataMax;
        // Expose the pan bounds + plot width to the drag/scrub handlers (px↔value conversion / clamping).
        this._dataMin = dataMin;
        this._dataLo = lo;
        this._dataHi = hi;
        this._plotW = cssW - 8 - LABEL_W;
        if (this._following || this._snap) {
            this._viewEnd = dataMax;
            this._snap = false;
        }
        // Clamp the frozen edge inside the available data.
        this._viewEnd = Math.max(Math.min(lo, hi), Math.min(this._viewEnd || dataMax, hi));
        const winB = this._viewEnd;
        const winA = winB - span;
        const xOf = (v: number) => LABEL_W + ((v - winA) / span) * this._plotW;

        // Grid + axis labels
        ctx.textBaseline = 'middle';
        ctx.font = '10px ui-monospace,monospace';
        const ticks = 6;
        for (let i = 0; i <= ticks; ++i) {
            const v = winA + (span * i) / ticks;
            const gx = xOf(v);
            ctx.strokeStyle = colGrid;
            ctx.beginPath();
            ctx.moveTo(gx, TOP);
            ctx.lineTo(gx, rowsBottom);
            ctx.stroke();
            ctx.fillStyle = colTxt;
            ctx.globalAlpha = 0.6;
            ctx.textAlign = 'center';
            let lbl;
            if (media) {
                lbl = (v / 1000).toFixed(1) + 's';
            } else {
                const ago = (dataMax - v) / 1000;
                lbl = ago <= 0.05 ? 'now' : '-' + ago.toFixed(1) + 's';
            }
            ctx.fillText(lbl, gx, rowsBottom + AXIS_H / 2);
            ctx.globalAlpha = 1;
        }

        const plotX1 = cssW - 8;
        const hits: Hit[] = [];
        rows.forEach((r, ri) => {
            const y = TOP + ri * (ROW_H + ROW_GAP);
            // Row label
            ctx.fillStyle = r.color;
            ctx.fillRect(2, y, 3, ROW_H);
            ctx.fillStyle = colTxt;
            ctx.textAlign = 'left';
            ctx.font = '600 11px sans-serif';
            ctx.fillText(r.type.toUpperCase(), 11, y + 11);
            ctx.globalAlpha = 0.6;
            ctx.font = '10px ui-monospace,monospace';
            ctx.fillText('#' + r.id, 11, y + 24);
            ctx.globalAlpha = 1;

            for (const s of r.seqs) {
                const a = media ? s.dtsStart : s.recvStart;
                const b = media ? s.dtsEnd : s.recvEnd;
                if (b < winA || a > winB) {
                    continue;
                }
                const xa = Math.max(LABEL_W, xOf(a));
                const xb = Math.min(plotX1, xOf(b));
                const w = Math.max(2, xb - xa);
                // Reception health: how long the sequence took to arrive vs its media duration.
                const ratio = (s.recvEnd - s.recvStart) / Math.max(1, s.dtsEnd - s.dtsStart);
                const health = ratio < 1.2 ? HEALTH_OK : ratio < 2 ? HEALTH_WARN : HEALTH_ERR;
                // Fill by reception health in both axes (consistent with the legend); the track color
                // stays as a thin left edge so each row keeps its identity.
                ctx.globalAlpha = 0.85;
                ctx.fillStyle = health;
                ctx.fillRect(xa, y, w, ROW_H);
                ctx.globalAlpha = 1;
                ctx.fillStyle = r.color;
                ctx.fillRect(xa, y, Math.min(3, w), ROW_H);
                ctx.strokeStyle = colGrid;
                ctx.strokeRect(xa + 0.5, y + 0.5, w - 1, ROW_H - 1);
                if (w > 22) {
                    // Frame count is the most useful at-a-glance debug signal (spot irregular GOPs);
                    // the sequence number is in the hover tooltip.
                    ctx.fillStyle = '#fff';
                    ctx.textAlign = 'center';
                    ctx.font = '600 11px ui-monospace,monospace';
                    ctx.fillText(String(s.frames), xa + w / 2, y + ROW_H / 2);
                }
                hits.push({ x0: xa, x1: xa + w, y0: y, y1: y + ROW_H, s, r });
            }
        });
        this._hits = hits;

        // Playhead (media axis only)
        if (media && this.getMediaTime) {
            const ct = this.getMediaTime();
            if (ct != null && ct >= winA && ct <= winB) {
                const lx = xOf(ct);
                ctx.strokeStyle = HEALTH_ERR;
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.moveTo(lx, TOP);
                ctx.lineTo(lx, rowsBottom);
                ctx.stroke();
                ctx.lineWidth = 1;
            }
        }

        // Overview minimap: full buffer extent + current window. Subtle by default, brightens while
        // navigating (dragging the plot, or scrubbing this band directly for fast jumps).
        const ovY0 = axisBottom + OV_GAP;
        const ovX0 = LABEL_W;
        const ovW = Math.max(1, plotX1 - ovX0);
        this._ovRect = { x0: ovX0, x1: plotX1, y0: ovY0 - 3, y1: ovY0 + OV_H + 3 };
        const navActive = this._dragging || this._ovDragging || Util.time() < this._navUntil;
        const totalSpan = Math.max(1, dataMax - dataMin);
        const ovXOf = (v: number) => ovX0 + ((v - dataMin) / totalSpan) * ovW;
        // Full-extent track
        ctx.globalAlpha = navActive ? 0.55 : 0.3;
        ctx.fillStyle = colGrid;
        this._roundRect(ctx, ovX0, ovY0, ovW, OV_H, OV_H / 2);
        ctx.fill();
        // Current window
        const wx0 = ovXOf(Math.max(dataMin, winA));
        const wx1 = ovXOf(Math.min(dataMax, winB));
        ctx.globalAlpha = navActive ? 1 : 0.65;
        ctx.fillStyle = ACCENT;
        this._roundRect(ctx, wx0, ovY0, Math.max(6, wx1 - wx0), OV_H, OV_H / 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        // Start / end labels, only while navigating (keeps the resting state quiet)
        if (navActive) {
            ctx.font = '9px ui-monospace,monospace';
            ctx.fillStyle = colTxt;
            ctx.globalAlpha = 0.8;
            ctx.textBaseline = 'middle';
            ctx.textAlign = 'left';
            ctx.fillText(
                media ? (dataMin / 1000).toFixed(1) + 's' : '-' + (totalSpan / 1000).toFixed(1) + 's',
                ovX0 + 6,
                ovY0 + OV_H / 2
            );
            ctx.textAlign = 'right';
            ctx.fillText(media ? (dataMax / 1000).toFixed(1) + 's' : 'now', plotX1 - 6, ovY0 + OV_H / 2);
            ctx.globalAlpha = 1;
        }
    }

    private _roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
        r = Math.min(r, w / 2, h / 2);
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
    }

    private _refreshNav() {
        this._navUntil = Util.time() + NAV_LINGER;
    }

    /** Map an overview-band x to the view edge, centering the window on the pointer (absolute scrub). */
    private _ovScrub(x: number) {
        const ov = this._ovRect;
        if (!ov || ov.x1 <= ov.x0) {
            return;
        }
        const frac = Math.min(1, Math.max(0, (x - ov.x0) / (ov.x1 - ov.x0)));
        const v = this._dataMin + frac * (this._dataHi - this._dataMin) + (this._windowDuration * 1000) / 2;
        this._snap = false;
        if (v >= this._dataHi) {
            this._viewEnd = this._dataHi;
            this.following = true;
        } else {
            this._viewEnd = Math.max(Math.min(this._dataLo, this._dataHi), v);
            this.following = false;
        }
    }

    /**
     * Convert a value between the media (DTS) and reception axes using the recorded per-sequence
     * (dts, recv) pairs, so the same instant stays visible when the axis is switched.
     */
    private _mapValue(value: number, from: UITimelineAxis, to: UITimelineAxis): number {
        if (from === to) {
            return value;
        }
        const pairs: Array<[number, number]> = [];
        for (const row of this._rows.values()) {
            for (const s of row.seqs) {
                pairs.push([from === 'media' ? s.dtsStart : s.recvStart, to === 'media' ? s.dtsStart : s.recvStart]);
                pairs.push([from === 'media' ? s.dtsEnd : s.recvEnd, to === 'media' ? s.dtsEnd : s.recvEnd]);
            }
        }
        if (!pairs.length) {
            return value;
        }
        pairs.sort((a, b) => a[0] - b[0]);
        if (value <= pairs[0][0]) {
            return pairs[0][1];
        }
        const last = pairs[pairs.length - 1];
        if (value >= last[0]) {
            return last[1];
        }
        let lo = 0;
        let hi = pairs.length - 1;
        while (hi - lo > 1) {
            const mid = (lo + hi) >> 1;
            if (pairs[mid][0] <= value) {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        const [f0, t0] = pairs[lo];
        const [f1, t1] = pairs[hi];
        return f1 > f0 ? t0 + ((value - f0) / (f1 - f0)) * (t1 - t0) : t0;
    }

    private _down(e: MouseEvent) {
        const rect = this._canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        // Press on the overview minimap → absolute scrub (fast jump anywhere in the buffer).
        if (this._ovRect && y >= this._ovRect.y0 && y <= this._ovRect.y1) {
            this._ovDragging = true;
            this._refreshNav();
            this._ovScrub(x);
            this._tip.style.display = 'none';
            e.preventDefault();
            return;
        }
        if (x < LABEL_W) {
            return; // label gutter
        }
        this._dragging = true;
        this._lastX = x;
        this._refreshNav();
        this.following = false; // grabbing the timeline pauses live-follow
        this._tip.style.display = 'none';
        this._canvas.style.cursor = 'grabbing';
        e.preventDefault();
    }

    private _up() {
        if (this._dragging || this._ovDragging) {
            this._refreshNav();
        }
        this._dragging = false;
        this._ovDragging = false;
        this._canvas.style.cursor = 'grab';
    }

    private _move(e: MouseEvent) {
        const rect = this._canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        if (this._ovDragging) {
            this._refreshNav();
            this._ovScrub(x);
            return;
        }
        if (this._dragging) {
            // Grab-and-pull: drag right → back into the past, drag left → forward (toward live).
            // Acceleration: the faster the pointer moves, the more ground each pixel covers, so long
            // buffers can be traversed quickly while slow drags stay precise.
            const dx = x - this._lastX;
            const perPx = (this._windowDuration * 1000) / Math.max(1, this._plotW);
            const accel = 1 + Math.min(ACCEL_MAX, Math.abs(dx) / ACCEL_REF);
            this._viewEnd -= dx * perPx * accel;
            this._lastX = x;
            this._snap = false;
            this._refreshNav();
            if (this._viewEnd >= this._dataHi) {
                // Reached the live edge → resume following.
                this._viewEnd = this._dataHi;
                this.following = true;
            } else {
                this._viewEnd = Math.max(Math.min(this._dataLo, this._dataHi), this._viewEnd);
                this.following = false;
            }
            return;
        }

        // Hovering the overview band keeps it visible and hints it is draggable.
        if (this._ovRect && y >= this._ovRect.y0 && y <= this._ovRect.y1) {
            this._refreshNav();
            this._canvas.style.cursor = 'ew-resize';
            this._tip.style.display = 'none';
            return;
        }
        this._canvas.style.cursor = 'grab';

        const hit = this._hits.find(h => x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1);
        if (!hit) {
            this._tip.style.display = 'none';
            return;
        }
        const s = hit.s;
        const r = hit.r;
        const medSpan = s.dtsEnd - s.dtsStart;
        const recvSpan = s.recvEnd - s.recvStart;
        this._tip.innerHTML =
            `<b>${r.type} #${r.id}</b> &middot; seq ${s.n}${s.key ? ' &middot; key' : ''}<br>` +
            `frames ${s.frames} &middot; size ${(s.bytes / 1024).toFixed(1)} KiB<br>` +
            `DTS ${(s.dtsStart / 1000).toFixed(3)}&rarr;${(s.dtsEnd / 1000).toFixed(3)}s (${medSpan}ms)<br>` +
            `recv +${(s.recvStart - this._t0).toFixed(0)}&rarr;+${(s.recvEnd - this._t0).toFixed(0)}ms (${recvSpan.toFixed(0)}ms)`;
        this._tip.style.display = 'block';
        // Flip the tooltip away from the edges so it is never clipped (notably on the bottom row).
        const tw = this._tip.offsetWidth;
        const th = this._tip.offsetHeight;
        let tx = x + 12;
        if (tx + tw > this._container.clientWidth) {
            tx = Math.max(2, x - tw - 12);
        }
        let ty = y + 12;
        if (ty + th > this._canvas.clientHeight) {
            ty = Math.max(2, y - th - 12);
        }
        this._tip.style.left = tx + 'px';
        this._tip.style.top = ty + 'px';
    }
}
