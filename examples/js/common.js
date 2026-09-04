/**
 * Copyright 2025 Ceeblue B.V.
 * This file is part of https://github.com/CeeblueTV/wrts-client which is released under GNU Affero General Public License.
 * See file LICENSE or go to https://spdx.org/licenses/AGPL-3.0-or-later.html for full license details.
 */

// Pieces shared by the example pages (player.html, dash-player.html). Everything here is
// player-agnostic: it drives the chrome around the video (theme, tabs, metrics export,
// error banner, layout) and never touches a Player or a MediaPlayer.
//
// The Vue and wrts-client URLs must stay byte-identical to the ones the pages import, so
// the browser hands out the same module instance (a second copy would mean a second Vue
// runtime, and a `log` whose level the page never configured).
import { nextTick } from 'https://cdn.jsdelivr.net/npm/vue@3/dist/vue.esm-browser.prod.js';
import { utils } from '../../dist/wrts-client.bundle.js';

const { Util, log } = utils;

export const PlayState = {
    PLAYING: 'PLAYING',
    STARTING: 'STARTING',
    STOPPED: 'STOPPED'
};

const THEME_KEY = 'wrts-theme';
const THEME_CYCLE = ['light', 'dark'];

/**
 * Theme selector: `theme` state, the header button's icon/tooltip, and a live follow of
 * the OS setting. The initial paint is done by js/theme.js, before this ever runs.
 */
export const themeMixin = {
    data() {
        return {
            theme: localStorage.getItem(THEME_KEY) || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
        };
    },
    mounted() {
        this._themeQuery = matchMedia('(prefers-color-scheme: dark)');
        this._themeListener = () => this.applyTheme(true);
        this._themeQuery.addEventListener('change', this._themeListener);
    },
    beforeUnmount() {
        if (this._themeQuery) {
            this._themeQuery.removeEventListener('change', this._themeListener);
        }
    },
    methods: {
        cycleTheme() {
            this.theme = THEME_CYCLE[(THEME_CYCLE.indexOf(this.theme) + 1) % THEME_CYCLE.length];
            localStorage.setItem(THEME_KEY, this.theme);
            this.applyTheme();
        },
        applyTheme(systemChange = false) {
            const dark = systemChange ? matchMedia('(prefers-color-scheme: dark)').matches : this.theme === 'dark';
            document.documentElement.dataset.theme = dark ? 'dark' : 'light';
        },
        themeIcon() {
            return { light: 'fa-sun', dark: 'fa-moon' }[this.theme];
        },
        themeTooltip() {
            return `Theme: ${this.theme} (click to cycle)`;
        }
    }
};

// Beyond that the oldest rows are dropped, the panel is a tail not an archive.
const MAX_MESSAGES = 200;

/**
 * Bottom panel: tab selection plus the data-message list. Expects a `messagesPanel` ref
 * on the scrollable box and an `activeBottomTab === 'messages'` pane.
 */
export const messagesMixin = {
    data() {
        return {
            activeBottomTab: 'graph',
            messages: [],
            unreadMessages: 0
        };
    },
    methods: {
        selectBottomTab(tab) {
            this.activeBottomTab = tab;
            if (tab === 'messages') {
                this.unreadMessages = 0;
                this.scrollMessagesToBottom();
            }
        },
        resetMessages() {
            this.messages = [];
            this.unreadMessages = 0;
            this.activeBottomTab = 'graph';
        },
        formatReceptionTime(date = new Date()) {
            return date.toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            });
        },
        scrollMessagesToBottom() {
            nextTick(() => {
                const panel = this.$refs.messagesPanel;
                if (panel) {
                    panel.scrollTop = panel.scrollHeight;
                }
            });
        },
        pushMessage(track, data) {
            this.messages.push({
                track,
                receivedAt: this.formatReceptionTime(),
                // One row per message: newlines would break the fixed-height monospace layout
                text: Util.stringify(data).replace(/[\r\n]+/g, ' ')
            });
            if (this.messages.length > MAX_MESSAGES) {
                this.messages.splice(0, this.messages.length - MAX_MESSAGES);
            }
            if (this.activeBottomTab !== 'messages') {
                this.unreadMessages += 1;
            }
            this.scrollMessagesToBottom();
        }
    }
};

/**
 * Side-by-side layout toggle: docks the graph/messages panel to the right of the video
 * instead of below it. Only flags <html>, the CSS gates the split on wide screens.
 * A page that persists its state in the URL just has to expose an `updateURL()`.
 */
export const sidePanelMixin = {
    data() {
        return { sidePanel: false };
    },
    mounted() {
        // The watcher below only fires on a change, apply whatever the page defaulted to.
        document.documentElement.classList.toggle('layout-side', this.sidePanel);
    },
    watch: {
        sidePanel(value) {
            document.documentElement.classList.toggle('layout-side', value);
        }
    },
    methods: {
        toggleSidePanel() {
            this.sidePanel = !this.sidePanel;
            if (this.updateURL) {
                this.updateURL();
            }
        }
    }
};

/**
 * Timeline toolbar: mirrors the UITimeline widget's state for the axis / window / follow
 * controls. The widget owns the canvas and every sample, these fields only drive the
 * buttons. The page creates the widget itself and exposes it as `this.uiTimeline`.
 */
export const timelineMixin = {
    data() {
        return {
            tlAxis: 'reception', // 'media' (DTS) | 'reception' (wall-clock)
            tlFollowing: true, // pinned to live | frozen for inspection
            tlWindow: 10, // visible window in seconds
            tlWindows: [5, 10, 30, 60]
        };
    },
    beforeUnmount() {
        if (this.uiTimeline) {
            this.uiTimeline.destroy();
        }
    },
    methods: {
        // Wires the widget the page just built: the playhead source and the follow-state
        // feedback (grabbing the overview auto-freezes it, the button must follow).
        bindTimeline(uiTimeline, getMediaTime) {
            this.uiTimeline = uiTimeline;
            uiTimeline.axis = this.tlAxis;
            uiTimeline.windowDuration = this.tlWindow;
            uiTimeline.getMediaTime = getMediaTime;
            uiTimeline.onFollowingChange = following => {
                this.tlFollowing = following;
            };
        },
        resetTimeline() {
            this.uiTimeline.reset();
            this.tlFollowing = true;
        },
        toggleTimelineFollow() {
            this.tlFollowing = !this.tlFollowing;
            this.uiTimeline.following = this.tlFollowing;
        },
        setTimelineAxis(axis) {
            this.tlAxis = axis;
            this.uiTimeline.axis = axis;
        },
        setTimelineWindow(seconds) {
            this.tlWindow = seconds;
            this.uiTimeline.windowDuration = seconds;
        },
        downloadTimeline() {
            this.download('timeline.csv', this.uiTimeline.toCSV(), 'text/csv;charset=utf-8;');
        }
    }
};

/**
 * Metrics chart plumbing: the `stats` series feeding UIMetrics, their CSV export, and the
 * generic file download. Each page keeps its own sampling loop and `resetMetrics()`, this
 * only holds what both do identically.
 */
export const metricsMixin = {
    data() {
        return {
            // Display label => array of samples, one per poll. Values are strings with their
            // unit ('850kbps'), UIMetrics parses the number out and keeps the unit as a suffix.
            stats: new Map(),
            // Local and media time of each sample, the first two columns of the CSV export
            times: [],
            hasMetrics: false,
            uiStats: null
        };
    },
    methods: {
        download(name, data, type) {
            const url = URL.createObjectURL(new Blob([data], { type }));
            const link = document.createElement('a');
            link.setAttribute('href', url);
            link.setAttribute('download', name);
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
        },
        downloadStats() {
            let max = this.times.length;
            const headers = ['localTime', 'mediaTime'];
            for (const [header, values] of this.stats) {
                headers.push(header);
                max = Math.max(max, values.length);
            }
            let csv = headers.join(';');

            // Series are filled independently (a metric can start late), so a row can be short
            for (let i = 0; i < max; ++i) {
                csv += '\n';
                const { time, mediaTime } = this.times[i] ?? {};
                csv += (time || '') + ';' + (mediaTime || '') + ';';
                for (const [, values] of this.stats) {
                    csv += (values[i] == null ? '' : parseFloat(values[i])) + ';';
                }
            }

            this.download('stats.csv', csv, 'text/csv;charset=utf-8;');
        },
        // Drop the samples the chart no longer displays, or all of them when `all` is set
        // (a new stream: the previous run's scale would flatten the new one).
        trimStats(all = false) {
            const displayableCount = all ? 0 : this.uiStats.displayableCount;
            for (const [, values] of this.stats) {
                values.splice(0, Math.max(0, values.length - displayableCount));
            }
            this.times.splice(0, Math.max(0, this.times.length - displayableCount));
        }
    }
};

// Keys the .player-alert renders itself, everything else on the error object becomes a chip.
const ALERT_RESERVED_KEYS = new Set(['type', 'name', 'detail']);

/**
 * Normalizes any error shape (a Player onStop union member, a synthesized video onerror, a
 * dash.js error, an input-validation error) into what .player-alert renders:
 * `{ type, name, detail, fields: [{ label, value }] }`. Unknown own-properties become
 * key/value chips, so subsystem context (mimeType, track, url, reason, code, ...) stays
 * visible without a UI variant per error type.
 *
 * @param {object|null} error
 * @returns {object|null}
 */
export function normalizeError(error) {
    if (!error) {
        return null;
    }
    const fields = [];
    for (const key of Object.keys(error)) {
        if (ALERT_RESERVED_KEYS.has(key)) {
            continue;
        }
        const value = error[key];
        if (value == null || value === '') {
            continue;
        }
        let display;
        if (typeof value === 'object') {
            // JSON rather than String(), which would render '[object Object]'
            try {
                display = JSON.stringify(value);
            } catch {
                display = String(value);
            }
        } else {
            display = String(value);
        }
        fields.push({ label: key, value: display });
    }
    return {
        // Strip the redundant 'Error' suffix from union discriminants, so the badge
        // reads 'SOURCE' rather than 'SOURCEERROR'.
        type: (error.type || '').replace(/Error$/, '') || null,
        name: error.name || 'Unknown error',
        detail: error.detail || null,
        fields
    };
}

/**
 * Builds a fixed, collapsible on-screen panel mirroring every `log()` line (newest at the
 * end), so logs can be read and copied on a device with no working chrome://inspect.
 * Hooks `log.on` non-destructively, the default console output still runs.
 * Enabled by the `?debugoverlay` query parameter.
 */
export function setupDebugOverlay() {
    const PANEL_VH = 40; // expanded height
    const MAX_ROWS = 500; // cap retained rows to avoid unbounded DOM/memory growth
    // Container: header bar (always visible) + scrollable log box.
    const panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:99999;background:rgba(0,0,0,.85);font:11px/1.35 monospace;';
    const header = document.createElement('div');
    header.style.cssText =
        'display:flex;gap:8px;align-items:center;padding:3px 6px;' +
        'background:#111;color:#ccc;border-top:1px solid #333;cursor:pointer;user-select:none';
    const title = document.createElement('span');
    title.textContent = '▾ debug logs';
    title.style.flex = '1';
    const copyBtn = document.createElement('button');
    copyBtn.textContent = 'copy';
    copyBtn.style.cssText = 'font:11px monospace';
    const clearBtn = document.createElement('button');
    clearBtn.textContent = 'clear';
    clearBtn.style.cssText = 'font:11px monospace';
    const box = document.createElement('div');
    box.style.cssText =
        'overflow:auto;color:#9f9;padding:4px 6px;white-space:pre-wrap;word-break:break-word;' + 'height:' + PANEL_VH + 'vh';
    header.append(title, copyBtn, clearBtn);
    panel.append(header, box);

    let collapsed = false;
    const apply = () => {
        box.style.display = collapsed ? 'none' : 'block';
        title.textContent = (collapsed ? '▸' : '▾') + ' debug logs';
        // Reserve page space so the panel never permanently hides page content
        // (e.g. the bottom of the metrics graph). Collapsed → just the header bar.
        document.body.style.paddingBottom = collapsed ? '26px' : 'calc(' + PANEL_VH + 'vh + 26px)';
    };
    header.onclick = e => {
        if (e.target === clearBtn || e.target === copyBtn) {
            return;
        }
        collapsed = !collapsed;
        apply();
    };
    clearBtn.onclick = () => {
        box.textContent = '';
    };
    copyBtn.onclick = () => {
        // Rows are oldest-on-top (chronological), copy as-is.
        const text = Array.from(box.children)
            .map(r => r.textContent)
            .join('\n');
        const done = ok => {
            copyBtn.textContent = ok ? 'copied!' : 'copy failed';
            setTimeout(() => {
                copyBtn.textContent = 'copy';
            }, 1500);
        };
        // navigator.clipboard needs a secure context (https/localhost); fall back to
        // a temporary textarea + execCommand for plain-http LAN access from the phone.
        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(text).then(
                () => done(true),
                () => done(false)
            );
        } else {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
            document.body.appendChild(ta);
            ta.focus();
            ta.select();
            let ok = false;
            try {
                ok = document.execCommand('copy');
            } catch {}
            document.body.removeChild(ta);
            done(ok);
        }
    };

    const ready = () => {
        document.body.appendChild(panel);
        apply();
    };
    document.readyState === 'loading' ? addEventListener('DOMContentLoaded', ready) : ready();
    log.on = (level, args) => {
        const line = args.map(a => (typeof a === 'object' && a !== null ? Util.stringify(a) : String(a))).join(' ');
        const row = document.createElement('div');
        row.style.color = level === 'error' ? '#f55' : level === 'warn' ? '#fd5' : '#9f9';
        const d = new Date();
        const ts =
            String(d.getHours()).padStart(2, '0') +
            ':' +
            String(d.getMinutes()).padStart(2, '0') +
            ':' +
            String(d.getSeconds()).padStart(2, '0') +
            '.' +
            String(d.getMilliseconds()).padStart(3, '0');
        row.textContent = `${ts} [${level}] ${line}`;
        // Stick to the end only when the user is already at the bottom and isn't
        // selecting text inside the box (so manual scroll-up / text selection is preserved).
        const slack = 4; // px tolerance for "at bottom"
        const wasAtBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - slack;
        const selection = window.getSelection();
        const selecting = selection && !selection.isCollapsed && box.contains(selection.anchorNode);
        box.appendChild(row); // newest at the end
        // Trim oldest rows (top) to keep DOM/memory bounded on long sessions
        while (box.childElementCount > MAX_ROWS) {
            box.removeChild(box.firstChild);
        }
        if (wasAtBottom && !selecting) {
            box.scrollTop = box.scrollHeight;
        }
    };
}

// Raw <video> media events worth logging when diagnosing a freeze. 'timeupdate' is left out
// (too noisy), and so are 'durationchange'/'progress' which flood on Safari (one per append).
const MEDIA_EVENTS = [
    'play',
    'playing',
    'pause',
    'waiting',
    'stalled',
    'suspend',
    'emptied',
    'ended',
    'seeking',
    'seeked',
    'ratechange',
    'canplay',
    'canplaythrough',
    'loadeddata',
    'loadedmetadata'
];

/**
 * Logs the raw media events of a <video> element. Enabled by the `?events` query parameter.
 *
 * @param {HTMLVideoElement} video
 * @param {function():string} [extra] appends a caller-provided suffix to each line
 */
export function logMediaEvents(video, extra) {
    for (const name of MEDIA_EVENTS) {
        video.addEventListener(name, () =>
            log(
                '[event]',
                name,
                't=' + video.currentTime.toFixed(3),
                'paused=' + video.paused,
                'readyState=' + video.readyState,
                'rate=' + video.playbackRate,
                extra ? extra() : ''
            ).info()
        );
    }
}
