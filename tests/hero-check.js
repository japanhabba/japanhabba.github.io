#!/usr/bin/env node
/*
 * Hero tagline check: loads index.html in Firefox and Chromium and checks the curved tagline
 * and the spark that lights it.
 *
 *   1. The tagline fills the half circle: the first letter is near the left end of the ring
 *      and the last letter near the right end.
 * Positions (1, 3) are measured from the pixels on screen, not from the browser's text APIs,
 * because Firefox has reported text-on-a-path positions unreliably.
 *   2. During one 6 s sweep each of the 8 words gets `.lit` once, in reading order, for
 *      roughly the same time (about 0.7 s each).
 *   3. Each word is lit while the spark passes the middle of the word as drawn on screen.
 *
 * Time is driven by Playwright's fake clock, so the timing check does not depend on how fast the
 * browser can paint.
 *
 * Run (from the repository root):
 *
 *     node tests/hero-check.js                  # both browsers
 *     node tests/hero-check.js firefox          # or just one: firefox | chromium
 *
 * Needs the `playwright` package (npm i -D playwright, or a global install) and browsers:
 *   - Chromium: `npx playwright install chromium`.
 *   - Firefox: either Playwright's own build (`npx playwright install firefox`), or any normal
 *     Firefox (driven over WebDriver BiDi, Playwright's `moz-firefox` channel). Point to it
 *     with FIREFOX_PATH=/path/to/firefox if it is not where tests/install-firefox.sh puts it
 *     (~/.local/jh-ff/env/bin/firefox) or in the usual system location.
 *   In the Claude Code cloud environment Playwright's download host is blocked, so
 *   tests/install-firefox.sh installs Firefox from conda-forge instead.
 *
 * Exits 0 when every check passes in every browser, 1 otherwise.
 */
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { chromium, firefox } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const SWEEP = 6000, REST = 1800;           // must match the hero script in index.html
const RING = { cx: 297.5, cy: 449, r: 279.5 }; // the tagline's half circle (#jh-arc-path), SVG units
const END_TOL = 0.05 * 2 * RING.r;         // first/last letter within ~28 units of the ring's ends
const LIT_MIN = 450, LIT_MAX = 1000;       // ms each word may stay lit
const LIT_SPREAD = 300;                    // ms between the shortest and longest lit word
const CENTRE_TOL = 15;                     // SVG units (about 1.5 letters) between the middle of the stretch
                                           // of ring where a word is lit and the middle of the word as drawn
const WORDS = ['CULTURE', 'ANIME', 'CONCERT', 'WORKSHOPS', 'FOOD', 'HIGHER EDUCATION', 'ARCADE', 'SHOPPING'];

// Only these outside hosts are loaded (the fonts the tagline is drawn in); the rest are blocked
// so the page settles quickly and the check does not depend on YouTube and friends.
const ALLOWED_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'rsms.me'];

const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.webp': 'image/webp',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.json': 'application/json', '.woff2': 'font/woff2', '.mp4': 'video/mp4' };

function serve() {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' }).end(data);
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function firefoxLaunchOptions() {
  if (process.env.FIREFOX_PATH) return { channel: 'moz-firefox', executablePath: process.env.FIREFOX_PATH };
  try { if (fs.existsSync(firefox.executablePath())) return {}; } catch (e) { /* not installed */ }
  const local = path.join(os.homedir(), '.local/jh-ff/env/bin/firefox');
  if (fs.existsSync(local)) return { channel: 'moz-firefox', executablePath: local };
  return { channel: 'moz-firefox' }; // a system Firefox, wherever Playwright finds it
}

const BROWSERS = {
  chromium: () => chromium.launch(),
  firefox: () => firefox.launch(firefoxLaunchOptions()),
};

// Runs in the page before its own scripts: on every animation frame, note each time a tagline
// word gains or loses `.lit`, and where the spark is at that moment.
function recordLit() {
  window.__lit = [];
  let state = null;
  function frame(t) {
    const words = document.querySelectorAll('.jh-arc-text:not(.jh-arc-flare) .w');
    if (words.length) {
      const now = [...words].map(w => w.classList.contains('lit'));
      const spark = document.querySelector('.jh-spark');
      const x = +spark.getAttribute('cx'), y = +spark.getAttribute('cy');
      now.forEach((on, k) => { if (on !== (state ? state[k] : false)) window.__lit.push({ k, on, t, x, y }); });
      state = now;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// Where the browser actually draws part of the tagline: screenshot it alone in a flat colour and
// return its leftmost and rightmost ink and the centre of its ink, in SVG units. `only` is a CSS
// selector, inside the tagline, for the part to show.
const BASE = '.jh-arc-text:not(.jh-arc-flare)';
async function ink(page, only) {
  await page.evaluate(css => {
    let st = document.getElementById('hero-check-style');
    if (!st) { st = document.createElement('style'); st.id = 'hero-check-style'; document.head.appendChild(st); }
    st.textContent = css;
  }, `
    body * { visibility: hidden !important; }
    html, body { background: #000 !important; }
    ${BASE}, ${BASE} * { visibility: visible !important; filter: none !important; transition: none !important; fill: transparent !important; }
    ${BASE} ${only} { fill: #f00 !important; }`);
  const svg = page.locator('.jh-hero-arc');
  await svg.scrollIntoViewIfNeeded();
  const png = await page.screenshot({ clip: await svg.boundingBox() });
  // Decode the PNG in the browser (no image library needed here) and scan for red pixels.
  const found = await page.evaluate(async b64 => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let left = null, right = null, sx = 0, sy = 0, n = 0;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4;
      if (d[i] > 140 && d[i + 1] < 90 && d[i + 2] < 90) {
        if (!left || x < left.x) left = { x, y };
        if (!right || x > right.x) right = { x, y };
        sx += x; sy += y; n++;
      }
    }
    return n ? { left, right, centre: { x: sx / n, y: sy / n }, w: c.width, h: c.height } : null;
  }, png.toString('base64'));
  if (!found) throw new Error(`nothing drawn for "${only}"`);
  // Screen pixels -> SVG units (the SVG keeps its aspect ratio, centred: preserveAspectRatio meet).
  const vb = await svg.evaluate(s => { const v = s.viewBox.baseVal; return { x: v.x, y: v.y, w: v.width, h: v.height }; });
  const scale = Math.min(found.w / vb.w, found.h / vb.h);
  const ox = (found.w - vb.w * scale) / 2, oy = (found.h - vb.h * scale) / 2;
  const toSvg = p => ({ x: vb.x + (p.x + 0.5 - ox) / scale, y: vb.y + (p.y + 0.5 - oy) / scale });
  return { left: toSvg(found.left), right: toSvg(found.right), centre: toSvg(found.centre) };
}

// Angle round the ring's centre, as the hero script uses it: left end = PI, bottom = PI/2, right end = 0.
const angle = p => { const a = Math.atan2(p.y - RING.cy, p.x - RING.cx); return a < -Math.PI / 2 ? a + 2 * Math.PI : a; };

async function check(name) {
  const results = [];
  const ok = (pass, msg) => results.push({ pass, msg });
  const server = await serve();
  const url = `http://127.0.0.1:${server.address().port}/index.html`;
  const browser = await BROWSERS[name]();
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'no-preference' });
    await context.route('**/*', route => {
      const host = new URL(route.request().url()).hostname;
      return host === '127.0.0.1' || ALLOWED_HOSTS.includes(host) ? route.continue() : route.abort();
    });
    // Fake clock: animation frames come in exact 16 ms steps however slowly the browser can paint
    // (headless Firefox without a GPU manages only a few frames a second on this page, which
    // would make the measured times jump by whole slow frames). Layout and fonts are still real.
    await context.clock.install();
    await context.addInitScript(recordLit);
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    await page.clock.runFor(100); // let the hero script lay out the tagline and start its loop
    const version = browser.version();
    const font = await page.evaluate(() => document.fonts.check('600 12.5px Poppins') ? 'Poppins' : 'fallback font (Poppins did not load)');
    console.log(`\n${name} ${version} (tagline in ${font})`);

    // 2. Timing. Run long enough to be sure of one whole sweep after the first one starts.
    await page.clock.runFor(SWEEP + REST + SWEEP + 500);
    const events = await page.evaluate(() => window.__lit);
    const firstOn = events.find(e => e.k === 0 && e.on);
    if (!firstOn) {
      ok(false, 'the first word never lit up');
    } else {
      // The sweep that begins when the first word lights; ignore anything from a later sweep.
      const sweep = events.filter(e => e.t >= firstOn.t - 50 && e.t < firstOn.t + SWEEP + REST / 2);
      const spans = WORDS.map((_, k) => {
        const on = sweep.find(e => e.k === k && e.on);
        const off = on && sweep.find(e => e.k === k && !e.on && e.t > on.t);
        return on && off ? { on: on.t, off: off.t, ms: off.t - on.t, times: sweep.filter(e => e.k === k && e.on).length,
          from: angle(on), to: angle(off) } : null;
      });
      spans.forEach((s, k) => {
        if (!s) ok(false, `${WORDS[k]}: did not light up and go out during the sweep`);
        else ok(s.ms >= LIT_MIN && s.ms <= LIT_MAX && s.times === 1,
          `${WORDS[k].padEnd(16)} lit ${(s.ms / 1000).toFixed(2)} s from ${((s.on - firstOn.t) / 1000).toFixed(2)} s` +
          (s.times > 1 ? ` (lit ${s.times} times)` : ''));
      });
      const got = spans.filter(Boolean);
      if (got.length === WORDS.length) {
        const inOrder = got.every((s, k) => k === 0 || s.on > got[k - 1].on);
        ok(inOrder, 'words light in reading order');
        const ms = got.map(s => s.ms), spread = Math.max(...ms) - Math.min(...ms);
        ok(spread <= LIT_SPREAD, `roughly equal: longest - shortest = ${(spread / 1000).toFixed(2)} s (max ${LIT_SPREAD / 1000} s)`);
      }
      // 3. Each word is lit while the spark passes the middle of that word as drawn on screen.
      //    (Catches the script's idea of where a word is drifting from where the browser draws it.)
      for (const [k, s] of spans.entries()) {
        if (!s) continue;
        const mid = angle((await ink(page, `.w:nth-child(${2 * k + 1})`)).centre);
        const before = (s.from - mid) * RING.r, after = (mid - s.to) * RING.r; // along the arc, SVG units
        const off = (after - before) / 2; // > 0: lit too early, < 0: lit too late
        ok(before > 0 && after > 0 && Math.abs(off) <= CENTRE_TOL,
          `${WORDS[k].padEnd(16)} lit from ${before.toFixed(0)} before its middle to ${after.toFixed(0)} after: ` +
          `${Math.abs(off).toFixed(0)} ${off >= 0 ? 'early' : 'late'} (max ${CENTRE_TOL})`);
      }
    }

    // 1. Extent, from what is actually drawn.
    const { left, right } = await ink(page, '*');
    const fmt = p => `(${p.x.toFixed(1)}, ${p.y.toFixed(1)})`;
    const L = { x: RING.cx - RING.r, y: RING.cy }, R = { x: RING.cx + RING.r, y: RING.cy };
    const dl = Math.hypot(left.x - L.x, left.y - L.y), dr = Math.hypot(right.x - R.x, right.y - R.y);
    ok(dl <= END_TOL, `first letter at ${fmt(left)}, ${dl.toFixed(1)} from the ring's left end ${fmt(L)} (max ${END_TOL.toFixed(0)})`);
    ok(dr <= END_TOL, `last letter at ${fmt(right)}, ${dr.toFixed(1)} from the ring's right end ${fmt(R)} (max ${END_TOL.toFixed(0)})`);
  } catch (e) {
    ok(false, 'error: ' + e.message.split('\n')[0]);
  } finally {
    await browser.close();
    server.close();
  }
  results.forEach(r => console.log(`  ${r.pass ? 'ok  ' : 'FAIL'} ${r.msg}`));
  return results.every(r => r.pass);
}

(async () => {
  const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(BROWSERS);
  const bad = names.filter(n => !BROWSERS[n]);
  if (bad.length) { console.error(`unknown browser: ${bad.join(', ')} (use ${Object.keys(BROWSERS).join(' | ')})`); process.exit(2); }
  let pass = true;
  for (const n of names) {
    try { pass = (await check(n)) && pass; }
    catch (e) { console.log(`\n${n}\n  FAIL could not start: ${e.message.split('\n')[0]}`); pass = false; }
  }
  console.log(pass ? '\nAll hero checks passed.' : '\nSome hero checks FAILED.');
  process.exit(pass ? 0 : 1);
})();
