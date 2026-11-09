// Headless Chrome over the DevTools protocol, for the probe and the benchmark:
// start Chrome, open a page, evaluate in it, and watch the network and memory
// of the page and every worker it starts (DuckDB-wasm reads from its own
// worker).

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { findChrome } from './find-chrome.mjs';

// Data requests only: not the page, DuckDB-wasm itself, or its extensions.
const isData = (url) => /^https?:/.test(url) && !/jsdelivr|unpkg|extensions\.duckdb|127\.0\.0\.1/.test(url);

/**
 * Start Chrome on a blank page. Returns:
 *   open(url)        navigate and wait for the page's load event
 *   evaluate(expr)   run an expression in the page, awaiting a promise
 *   requests         Map of data requests: { phase, t0, t1, method, url,
 *                    range, ifMatch, status, failed, bytes }
 *   setPhase(name)   label the requests that start from now on
 *   memory()         peak resident memory of the page's renderer process,
 *                    in bytes: the page and its workers, WebAssembly memory
 *                    included (VmHWM in /proc on Linux; null elsewhere).
 *                    CDP's Runtime.getHeapUsage leaves WebAssembly memory out.
 *   version          Chrome's product string
 *   close()
 */
/**
 * The largest peak resident set (VmHWM) of the renderer processes started by
 * a Chrome process, in bytes, or null where /proc is not available.
 */
async function rendererPeak(root) {
    let pids;
    try { pids = (await fs.readdir('/proc')).filter(d => /^\d+$/.test(d)); } catch { return null; }
    const parent = new Map();
    await Promise.all(pids.map(async (pid) => {
        try {
            const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
            parent.set(pid, stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
        } catch { /* exited */ }
    }));
    const isDescendant = (pid) => {
        for (let p = pid, n = 0; p && p !== '0' && n < 64; p = parent.get(p), n++) if (p === String(root)) return true;
        return false;
    };
    let peak = null;
    for (const pid of parent.keys()) {
        if (!isDescendant(pid)) continue;
        try {
            if (!(await fs.readFile(`/proc/${pid}/cmdline`, 'utf8')).includes('--type=renderer')) continue;
            const kb = Number((await fs.readFile(`/proc/${pid}/status`, 'utf8')).match(/VmHWM:\s+(\d+)/)?.[1]);
            if (kb) peak = Math.max(peak ?? 0, kb * 1024);
        } catch { /* exited */ }
    }
    return peak;
}

export async function launchChrome() {
    const profile = await fs.mkdtemp(path.join(process.env.TMPDIR ?? '/tmp', 'geo-query-wasm-chrome-'));
    const chrome = spawn(findChrome(), ['--headless=new', '--no-sandbox', '--remote-debugging-port=0',
        `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    const wsUrl = await new Promise((resolve, reject) => {
        chrome.stderr.on('data', d => { const m = String(d).match(/ws:\/\/\S+/); if (m) resolve(m[0]); });
        chrome.on('exit', c => reject(new Error(`chrome exited ${c}`)));
    });
    const port = new URL(wsUrl).port;
    let target;
    while (!target) target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise(r => ws.addEventListener('open', r));

    let id = 0, phase = 'setup';
    const pending = new Map();
    const requests = new Map();
    const workers = new Set();
    const listeners = new Set();
    const cdp = (method, params = {}, sessionId) => new Promise(r => {
        const i = ++id;
        pending.set(i, r);
        ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    ws.addEventListener('message', (e) => {
        const m = JSON.parse(e.data);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
        const p = m.params;
        for (const f of listeners) f(m);
        if (m.method === 'Target.attachedToTarget') {
            // DuckDB fetches from its own worker, so watch every worker too.
            if (p.targetInfo.type === 'worker') workers.add(p.sessionId);
            cdp('Network.enable', {}, p.sessionId);
            cdp('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, p.sessionId);
        }
        if (m.method === 'Target.detachedFromTarget') workers.delete(p.sessionId);
        if (m.method === 'Network.requestWillBeSent' && isData(p.request.url)) {
            const h = p.request.headers;
            requests.set(p.requestId, { phase, t0: Date.now(), method: p.request.method, url: p.request.url,
                range: h.Range ?? h.range, ifMatch: h['If-Match'] ?? h['if-match'], headers: h, bytes: 0 });
        }
        const r = requests.get(p?.requestId);
        if (!r) return;
        if (m.method === 'Network.requestWillBeSentExtraInfo') r.range = p.headers.Range ?? p.headers.range ?? r.range;
        if (m.method === 'Network.responseReceived') r.status = p.response.status;
        if (m.method === 'Network.loadingFailed') { r.failed = p.errorText; r.t1 = Date.now(); }
        if (m.method === 'Network.loadingFinished') { r.bytes = p.encodedDataLength; r.t1 = Date.now(); }
    });
    await cdp('Network.enable');
    await cdp('Page.enable');
    await cdp('Runtime.enable');
    await cdp('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    const version = (await cdp('Browser.getVersion')).result.product;

    const evaluate = async (expression) => {
        const { result } = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
        return result.result.value;
    };
    return {
        version,
        requests,
        cdp,
        evaluate,
        onMessage: (f) => listeners.add(f),
        setPhase: (name) => { phase = name; },
        async open(url) {
            const loaded = new Promise(r => listeners.add(function f(m) {
                if (m.method === 'Page.loadEventFired') { listeners.delete(f); r(); }
            }));
            await cdp('Page.navigate', { url });
            await loaded;
        },
        async memory() {
            return rendererPeak(chrome.pid);
        },
        async close() {
            ws.close();
            chrome.kill();
            await new Promise(r => chrome.once('exit', r));
            await fs.rm(profile, { recursive: true, force: true, maxRetries: 5 });
        },
    };
}

/** Requests in a phase: count, bytes, and the most in flight at once. */
export function summarize(requests, phase) {
    const rs = [...requests.values()].filter(r => r.phase === phase);
    const events = rs.flatMap(r => [[r.t0, 1], [r.t1 ?? r.t0, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let now = 0, most = 0;
    for (const [, d] of events) { now += d; most = Math.max(most, now); }
    return { requests: rs.length, mb: +(rs.reduce((s, r) => s + r.bytes, 0) / 1e6).toFixed(2), inFlight: most, list: rs };
}
