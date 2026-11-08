// The Chrome or Chromium binary for the headless checks: $CHROME if set, else
// one on PATH, else the newest Playwright download. Exits with a clear message
// when there is none.

import fs from 'node:fs';
import path from 'node:path';

const ON_PATH = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome'];
const PLAYWRIGHT = [
    'chrome-linux64/chrome', 'chrome-linux/chrome',
    'chrome-headless-shell-linux64/chrome-headless-shell',
    'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
];

const executable = (f) => { try { fs.accessSync(f, fs.constants.X_OK); return fs.statSync(f).isFile(); } catch { return false; } };

export function findChrome() {
    if (process.env.CHROME) return process.env.CHROME;
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
        for (const name of ON_PATH) if (dir && executable(path.join(dir, name))) return path.join(dir, name);
    }
    const cache = path.join(process.env.HOME ?? '', '.cache', 'ms-playwright');
    // Full Chromium builds before headless shells, newest first.
    const builds = (fs.existsSync(cache) ? fs.readdirSync(cache) : [])
        .filter(d => d.startsWith('chromium'))
        .sort((a, b) => (a.includes('headless') - b.includes('headless')) || b.localeCompare(a, undefined, { numeric: true }));
    for (const b of builds) for (const rel of PLAYWRIGHT) if (executable(path.join(cache, b, rel))) return path.join(cache, b, rel);
    console.error('No Chrome or Chromium found. Set CHROME=/path/to/chrome, or install one (e.g. `npx playwright install chromium`).');
    process.exit(2);
}
