#!/usr/bin/env node
/**
 * verify.mjs: look at every scene performing its piece, in headless Chromium.
 *
 *   npm run verify -- standchen [--out dir] [--quick] [--seq 34,70]
 *
 * For the piece (default: all with audio and analysis) it starts the dev
 * server, plays the scene's piece and
 *   - seeks to a representative moment of every section (the peak for a
 *     climax, the middle otherwise), lets it play LEAD_IN seconds so the
 *     scene's smoothing settles, and takes a screenshot
 *   - captures a frame sequence across the biggest climax (or the --seq
 *     start,end window in seconds), logging when the scene's speed / climax
 *     start rising against the loudest moment
 *   - checks the console for errors, the frame rate, and the score clock's
 *     drift against the media clock after each seek
 * and writes <out>/<id>/report.json next to the screenshots.
 *
 *   npm run verify -- drottningholm --journey [--out dir]
 *
 * checks Scene 1's long-term journey (dawn -> night) instead: it samples
 * JOURNEY_TIMES across the piece and prints, for each, the scene's journey
 * value, the frame's mean luminance (linear Y), mean Oklab lightness, the
 * dominant hue (chroma-weighted OKLCH histogram) and fps; screenshots only
 * JOURNEY_SHOTS; then checks that the background (the darkest quarter of the
 * frame) stays dark everywhere, that the swirls' hue moves from light blue /
 * yellow toward blue / purple, that yellow splashes remain, and reports the
 * bumps at the two climaxes.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PIECES, ANALYSIS_DIR } from '../src/pieces.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const OUT = path.resolve(flag('--out', path.join(ROOT, '.verify')));
const QUICK = args.includes('--quick');
const JOURNEY = args.includes('--journey');
const JOURNEY_TIMES = [10, 45, 90, 137, 210, 270, 320, 347, 390, 425]; // 0:10 0:45 1:30 2:17 3:30 4:30 5:20 5:47 6:30 7:05
const JOURNEY_SHOTS = [10, 137, 270, 347, 425];
const JOURNEY_CLIMAXES = [137, 347]; // should stand out against their neighbours
const only = args.filter((a, i) => !a.startsWith('--') && !['--out', '--seq'].includes(args[i - 1]));
const SEQ = flag('--seq', '')
  .split(',')
  .filter(Boolean)
  .map(Number);
const LEAD_IN = QUICK ? 2.5 : 4; // s of playback before each screenshot
const SEQUENCE = { BEFORE: 8, AFTER: 3, STEP: 1 }; // s around the biggest climax
const VIEW = { width: 1280, height: 720 };

const fmt = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const server = await createServer({ root: ROOT, logLevel: 'error', server: { port: 5199, strictPort: false } });
  await server.listen();
  const url = server.resolvedUrls.local[0];
  const launch = { args: ['--autoplay-policy=no-user-gesture-required', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] };
  // Playwright's own Chromium if installed (npx playwright install chromium), else the system Chrome
  const browser = await chromium.launch(launch).catch(() => chromium.launch({ ...launch, channel: 'chrome' }));
  try {
    const pieces = PIECES.filter((p) => !only.length || only.includes(p.id));
    for (const piece of pieces) {
      if (!fs.existsSync(path.join(ROOT, 'public', ANALYSIS_DIR, `${piece.id}.json`))) {
        console.log(`skip ${piece.id}: no analysis (npm run analyze)`);
        continue;
      }
      await verifyPiece(browser, url, piece);
    }
  } finally {
    await browser.close();
    await server.close();
  }
}

async function verifyPiece(browser, url, piece) {
  const dir = path.join(OUT, piece.id);
  fs.mkdirSync(dir, { recursive: true });
  const analysis = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', ANALYSIS_DIR, `${piece.id}.json`), 'utf8'));
  const page = await browser.newPage({ viewport: VIEW });
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(`${url}?debug`);
  await page.waitForFunction(() => window.__resonance?.manager);
  const gpu = await page.evaluate(() => {
    const gl = window.__resonance.renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  });
  // scene, then the piece (P), UI hidden for clean frames
  await page.keyboard.press(String(piece.scene + 1));
  await page.waitForFunction((i) => window.__resonance.manager.index === i && !window.__resonance.manager.busy, piece.scene, { timeout: 60000 });
  await page.keyboard.press('p');
  await page.waitForFunction(() => window.__resonance.perf.source === 'score', null, { timeout: 30000 });
  await page.keyboard.press('h');
  console.log(`\n== ${piece.title}  (scene ${piece.scene + 1}, GPU: ${gpu})`);

  const seekAndPlay = async (t, lead = LEAD_IN) => {
    const from = Math.max(0, t - lead);
    await page.evaluate((s) => {
      const el = window.__resonance.audio.element;
      el.currentTime = s;
      return el.play();
    }, from);
    await page.waitForFunction((s) => Math.abs(window.__resonance.perf.t - s) < 0.5 && !window.__resonance.audio.element.seeking, from);
    // play up to t, watching drift
    let maxDrift = 0;
    for (;;) {
      const s = await page.evaluate(() => ({ t: window.__resonance.perf.t, drift: window.__resonance.perf.follower.drift, media: window.__resonance.audio.element.currentTime }));
      maxDrift = Math.max(maxDrift, Math.abs(s.drift));
      if (s.t >= t - 0.02) break;
      await sleep(Math.min(250, Math.max(10, (t - s.t) * 1000 - 20)));
    }
    return maxDrift;
  };
  const state = () =>
    page.evaluate(() => {
      const r = window.__resonance;
      const p = r.perf;
      const sc = r.manager.current?.scene;
      return {
        t: p.t,
        level: p.level,
        drive: p.drive,
        rise: p.rise,
        climax: p.climax,
        mood: p.mood,
        stage: p.stage,
        section: p.section ? `${p.section.index} ${p.section.role}` : '',
        height: p.height,
        key: p.key.name,
        fps: r.fps,
        scene: sc?.debug ?? {},
        sceneSpeed: sc?.speedMult ?? sc?.speed ?? 0,
        sceneClimax: sc?.climax ?? p.climax,
        sceneGlow: sc?.glow ?? sc?.exposure ?? 0,
        exposure: sc?.exposure ?? 1,
      };
    });

  if (JOURNEY) {
    const journey = await journeyPass(page, dir, seekAndPlay, state);
    const fps = await page.evaluate(() => window.__resonance.fps);
    fs.writeFileSync(path.join(dir, 'journey-report.json'), JSON.stringify({ piece: piece.id, gpu, fps, errors, ...journey }, null, 2));
    console.log(`  fps ${fps.toFixed(1)} · console errors ${errors.length}${errors.length ? ':\n    ' + errors.slice(0, 5).join('\n    ') : ''}`);
    console.log(`  -> ${dir}`);
    await page.close();
    return;
  }

  // --- one moment per section
  const rows = [];
  for (const s of analysis.sections) {
    const t = s.role === 'climax' || s.role === 'swell' ? s.peakAt : s.role === 'fade' ? s.start + (s.end - s.start) * 0.6 : (s.start + s.end) / 2;
    const drift = await seekAndPlay(t);
    const st = await state();
    const file = path.join(dir, `section-${String(s.index).padStart(2, '0')}-${s.role}-${fmt(t).replace(':', 'm')}.png`);
    await page.screenshot({ path: file });
    rows.push({ section: s.index, role: s.role, label: s.label, t: Math.round(t * 10) / 10, file, drift, ...st });
    console.log(
      `  ${String(s.index).padStart(2)} ${s.role.padEnd(8)} ${fmt(t).padStart(6)}  level ${st.level.toFixed(2)} drive ${st.drive.toFixed(2)} climax ${st.climax.toFixed(2)}  stage ${st.stage.padEnd(9)} speed ${st.sceneSpeed.toFixed(2)} glow ${st.sceneGlow.toFixed(2)}  drift ${(drift * 1000).toFixed(0)} ms  fps ${st.fps.toFixed(0)}`,
    );
  }

  // --- the biggest climax: does the scene build before the loudest point?
  const top = analysis.climaxes.sustained[0];
  const seq = [];
  if (top) {
    const t0 = SEQ.length === 2 ? SEQ[0] : Math.max(0, top.t - SEQUENCE.BEFORE);
    const t1 = SEQ.length === 2 ? SEQ[1] : top.t + SEQUENCE.AFTER;
    const step = Math.max(SEQUENCE.STEP, (t1 - t0) / 16);
    await seekAndPlay(t0, 3);
    for (let t = t0; t <= t1 + 1e-6; t += step) {
      await seekAndPlay(t, 0); // already playing: this just waits for the moment
      const st = await state();
      const file = path.join(dir, `climax-${fmt(t).replace(':', 'm')}.png`);
      await page.screenshot({ path: file, scale: 'css', clip: { x: 0, y: 0, width: VIEW.width, height: VIEW.height } });
      seq.push({ t: Math.round(t * 10) / 10, file, level: st.level, drive: st.drive, climax: st.climax, sceneClimax: st.sceneClimax, speed: st.sceneSpeed, glow: st.sceneGlow, exposure: st.exposure });
    }
    // the loudest sustained moment (2 samples) against when the scene's speed reaches 90 % of its peak
    let loudest = seq[0];
    for (let i = 1; i < seq.length; i++) if ((seq[i].level + (seq[i - 1]?.level ?? 0)) / 2 > (loudest.level + (seq[seq.indexOf(loudest) - 1]?.level ?? 0)) / 2) loudest = seq[i];
    const peakSpeed = Math.max(...seq.map((r) => r.speed));
    const fast = seq.find((r) => r.speed >= 0.9 * peakSpeed);
    const firstUp = seq.find((r) => r.sceneClimax > 0.25) ?? null;
    console.log(`  sequence ${fmt(t0)}-${fmt(t1)} · biggest climax ${fmt(top.t)} (build from ${fmt(top.buildStart)}): loudest sampled ${fmt(loudest.t)} · scene speed at 90 % from ${fmt(fast.t)} · climax envelope > 0.25 from ${firstUp ? fmt(firstUp.t) : 'never'}`);
    for (const r of seq) console.log(`     ${fmt(r.t)}  level ${r.level.toFixed(2)}  drive ${r.drive.toFixed(2)}  climax ${r.climax.toFixed(2)} → scene ${r.sceneClimax.toFixed(2)}  speed ${r.speed.toFixed(2)}  glow ${r.glow.toFixed(2)}  exposure ${r.exposure.toFixed(2)}`);
  }

  // --- debug overlay with the timeline, for the record
  await page.keyboard.press('h');
  await page.keyboard.press('d');
  await sleep(400);
  await page.screenshot({ path: path.join(dir, 'debug-timeline.png') });
  await page.keyboard.press('d');

  const fps = await page.evaluate(() => window.__resonance.fps);
  const report = { piece: piece.id, gpu, fps, errors, sections: rows, climaxSequence: seq };
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`  fps ${fps.toFixed(1)} · console errors ${errors.length}${errors.length ? ':\n    ' + errors.slice(0, 5).join('\n    ') : ''}`);
  console.log(`  -> ${dir}`);
  await page.close();
}

/** Mean luminance, lightness and dominant hue of the current frame (decoded in the page from a screenshot). */
async function frameStats(page, file) {
  const png = await page.screenshot(file ? { path: file } : {});
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = 160;
    c.height = 90;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0, c.width, c.height);
    const px = g.getImageData(0, 0, c.width, c.height).data;
    const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    const bins = new Float32Array(36);
    const ys = new Float32Array(px.length / 4);
    let Y = 0;
    let L = 0;
    let C = 0;
    const n = px.length / 4;
    for (let i = 0; i < px.length; i += 4) {
      const r = lin(px[i] / 255);
      const gr = lin(px[i + 1] / 255);
      const b = lin(px[i + 2] / 255);
      const y = 0.2126 * r + 0.7152 * gr + 0.0722 * b;
      ys[i / 4] = y;
      Y += y;
      const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * gr + 0.0514459929 * b);
      const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * gr + 0.1073969566 * b);
      const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * gr + 0.6299787005 * b);
      const ok = [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
      const ch = Math.hypot(ok[1], ok[2]);
      L += ok[0];
      C += ch;
      if (ch > 0.03) bins[Math.floor((((Math.atan2(ok[2], ok[1]) * 180) / Math.PI + 360) % 360) / 10)] += ch;
    }
    let top = 0;
    for (let i = 1; i < 36; i++) if (bins[i] > bins[top]) top = i;
    // background = darkest quarter, swirls = brightest quarter; yellow = share of the colour in 70-110°
    ys.sort();
    const q = Math.floor(n / 4);
    const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
    const total = bins.reduce((s, v) => s + v, 0);
    const names = [[30, 'red'], [80, 'orange'], [105, 'yellow'], [160, 'green'], [215, 'cyan'], [265, 'blue'], [300, 'indigo'], [335, 'violet'], [360, 'red']];
    const hue = top * 10 + 5;
    return {
      lum: Y / n,
      dark: avg(ys.subarray(0, q)),
      bright: avg(ys.subarray(n - q)),
      L: L / n,
      chroma: C / n,
      hue,
      hueName: bins[top] > 0 ? names.find(([h]) => hue < h)[1] : 'grey',
      yellow: total > 0 ? (bins[7] + bins[8] + bins[9] + bins[10]) / total : 0,
    };
  }, png.toString('base64'));
}

/** Scene 1's journey: numbers at JOURNEY_TIMES, screenshots at JOURNEY_SHOTS, trend checks. */
async function journeyPass(page, dir, seekAndPlay, state) {
  const rows = [];
  console.log('    time   journey  lum    ground  swirls  chroma  hue          yellow  fps');
  for (const t of JOURNEY_TIMES) {
    await seekAndPlay(t);
    const st = await state();
    const journey = await page.evaluate(() => window.__resonance.manager.current?.scene?.journey ?? NaN);
    const file = JOURNEY_SHOTS.includes(t) ? path.join(dir, `journey-${fmt(t).replace(':', 'm')}.png`) : null;
    const f = await frameStats(page, file);
    rows.push({ t, journey, ...f, fps: st.fps, file });
    console.log(`  ${fmt(t).padStart(7)}  ${journey.toFixed(3)}   ${f.lum.toFixed(3)}  ${f.dark.toFixed(3)}   ${f.bright.toFixed(3)}   ${f.chroma.toFixed(3)}   ${String(f.hue).padStart(3)}° ${f.hueName.padEnd(7)}  ${(f.yellow * 100).toFixed(1).padStart(4)}%  ${st.fps.toFixed(0)}${file ? '  [shot]' : ''}`);
  }
  // checks: dark background throughout, swirl hue moves toward blue / purple, yellow remains, climax bumps
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const ts = rows.map((r) => r.t);
  const ls = rows.map((r) => r.lum);
  const mt = mean(ts);
  const ml = mean(ls);
  const slope = ts.reduce((s, t, i) => s + (t - mt) * (ls[i] - ml), 0) / ts.reduce((s, t) => s + (t - mt) ** 2, 0);
  const hueStart = mean(rows.slice(0, 3).map((r) => r.hue));
  const hueEnd = mean(rows.slice(-3).map((r) => r.hue));
  const checks = {
    darkGround: rows.every((r) => r.dark < 0.04), // the bare navy ground itself measures ~0.015
    hueShift: hueEnd - hueStart > 20,
    yellowStays: rows.slice(-4).some((r) => r.yellow > 0.005),
    bumps: JOURNEY_CLIMAXES.map((c) => {
      const i = ts.indexOf(c);
      const r = rows[i];
      // against the straight line between its neighbours
      const expected = (rows[i - 1].lum + rows[i + 1].lum) / 2;
      return { t: c, lum: r.lum, neighbours: expected, bump: r.lum - expected };
    }),
  };
  console.log(`  ground (darkest 25 %) max ${Math.max(...rows.map((r) => r.dark)).toFixed(3)}  -> ${checks.darkGround ? 'PASS background dark throughout' : 'FAIL background gets light'}`);
  console.log(`  swirl hue ${hueStart.toFixed(0)}° (start) -> ${hueEnd.toFixed(0)}° (end)  -> ${checks.hueShift ? 'PASS moves toward blue / purple' : 'FAIL hue does not move'}`);
  console.log(`  yellow in the last 4 samples ${rows.slice(-4).map((r) => (r.yellow * 100).toFixed(1) + '%').join(' ')}  -> ${checks.yellowStays ? 'PASS yellow splashes remain' : 'FAIL no yellow late'}`);
  console.log(`  mean luminance slope ${(slope * 60).toFixed(4)} / min (info)`);
  for (const b of checks.bumps) console.log(`  climax ${fmt(b.t)}: lum ${b.lum.toFixed(3)} vs neighbours ${b.neighbours.toFixed(3)} -> bump ${b.bump >= 0 ? '+' : ''}${b.bump.toFixed(3)}`);
  // the debug overlay (journey row, palette swatches, journey curve) and the Shift+digit scrub
  await page.keyboard.press('h');
  await page.keyboard.press('d');
  await page.keyboard.press('Shift+Digit5');
  await sleep(1500);
  const scrub = await page.evaluate(() => window.__resonance.perf.t / window.__resonance.perf.map.duration);
  checks.scrub = Math.abs(scrub - 0.5) < 0.02;
  console.log(`  Shift+5 scrubbed to ${(scrub * 100).toFixed(1)} % of the piece -> ${checks.scrub ? 'PASS' : 'FAIL'}`);
  await page.screenshot({ path: path.join(dir, 'journey-debug.png') });
  await page.keyboard.press('d');
  return { rows, checks, slope };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
