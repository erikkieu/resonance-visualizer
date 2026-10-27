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
 *
 *   npm run verify -- standchen --aurora [--out dir]
 *
 * checks Scene 2's two-layer wave aurora: at AURORA_TIMES the active packets
 * per layer, the melody pitch height, the low note, wave activity (mean over
 * 1 s), mean luminance and fps; screenshots only at AURORA_SHOTS, plus a
 * 5-frame sequence over 1 s at AURORA_SEQ. Checks that (a) over a melodic
 * span the melody layer spawns about one packet per melody note and the low
 * layer far fewer, slower ones, (b) packets travel monotonically frame to
 * frame, (c) activity is low when quiet, peaks at 4:50 and is lower at 5:11.
 * It also prints the night progression (night / dawn, PROFILE.NIGHT) at each
 * time, shoots 0:10 and 1:20 too (dusk), and checks that the night deepens
 * up to 4:50, is deepest there, and that dawn only rises after it.
 *
 *   npm run verify -- standchen --smooth [--out dir]
 *
 * measures Scene 2's aurora noise: for 5 s windows (quiet, building,
 * climax), with the stars hidden so only the aurora moves, in both the
 * previous look and the clean one (AURORA.NOISE, key N), it reads back every
 * frame of the sky above the mountains (downsampled) and computes (a)
 * flicker = mean |frame-to-frame luminance change| (includes the waves' real
 * travel), temporal noise = mean |Y(t) - (Y(t-1) + Y(t+1)) / 2| (~0 for smooth
 * motion, large for boiling or strobing) and (b) grain = mean
 * |Laplacian| of the luminance, plus mean luminance, chroma and the p98
 * highlight (each look twice, A B B A, averaged). Checks both drop >= 40 % while luminance, chroma and highlights
 * stay within 10 %; then shoots 2:40, 4:50 and 5:50 in the clean look.
 *
 *   npm run verify -- standchen --look [--out dir]
 *
 * checks Scene 2's look across the piece: at LOOK_TIMES, from a screenshot,
 * the dominant hue (OKLCH, chroma-weighted) and mean HSV saturation of the
 * aurora (the brightest 30 % of the sky pixels), the share of warm pixels
 * (OKLCH hue 20-80°) in the sky, mean luminance and fps; screenshots at
 * LOOK_SHOTS. For reference restyle 2: a green aurora (OKLCH hue 125-170°)
 * and no warm clouds (warm share under 1 % outside dusk and dawn). Run it
 * before a change for a baseline.
 *
 *   npm run verify -- standchen --match [--at 260] [--out dir]
 *
 * compares Scene 2 with its reference photo (reference restyle 2): renders a
 * loud-ish moment (MATCH_TIME, 4:20), and prints for each region of
 * MATCH_REGIONS (fractions of the frame from the top) its mean colour (hex)
 * and mean luma (Rec. 709 weights on the sRGB values), plus the aurora's
 * bright-core colour (the brightest 2 % of the sky) and the number of visible
 * stars (sharp local maxima in the sky), each next to the reference and the
 * difference. The reference values come from public/textures/aurora-reference-2.jpg
 * measured the same way when the file exists (and a side-by-side image is
 * saved), else from PROFILE.LOOK.REFERENCE. A region passes within 15 % luma
 * and ΔE (OKLab) 0.05. (The vivid version deliberately leaves these targets;
 * press V in the scene, or set LOOK.PALETTE.VIVID false, for the muted look.)
 *
 *   npm run verify -- standchen --vivid [--out dir]
 *
 * checks Scene 2's vivid version: at VIVID_TIMES (quiet, building, climax,
 * fade) it prints, for the aurora pixels of the sky (brighter than 1.6x the
 * sky's median, or OKLCH chroma over 0.09), their mean HSV saturation, the peak (p99.5 luma) and the
 * share of clipped pixels, the share of green / cyan / blue / purple hues,
 * the active ribbons, and the reflection ratio: linear luminance of the water
 * against the sky it mirrors (pixel by pixel, where that sky is brighter than
 * its median), in the upper water (0.03-0.09 below the water line: right
 * under it the water mirrors the mountains) and near the bottom. At the climax it also measures the muted
 * palette (V) for comparison. Checks: climax saturation clearly above the
 * muted look, green, blue and purple each >= 10 % of the aurora, >= 4
 * ribbons, reflection 0.5-0.7 near the horizon, the quiet moment calmer but
 * still colourful. Screenshots at VIVID_SHOTS.
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
const AURORA = args.includes('--aurora');
const AURORA_TIMES = [10, 80, 160, 205, 260, 290, 311, 350]; // 0:10 1:20 2:40 3:25 4:20 4:50 5:11 5:50
const AURORA_SHOTS = [10, 80, 160, 260, 290, 350];
const AURORA_SEQ = 75; // s: 5 frames over 1 s of the 1:04 swell's melody
const AURORA_QUIET = [10, 205, 350]; // intro, the 3:20-3:35 release, the fade
const AURORA_TRACE = [64, 84];
const LOOK = args.includes('--look');
const LOOK_TIMES = [10, 80, 160, 260, 290, 350]; // quiet, 1:20, mid, building, climax, fade
const LOOK_SHOTS = [10, 160, 290, 350];
const MATCH = args.includes('--match');
const MATCH_TIME = Number(flag('--at', 260)); // s: 4:20, building toward the climax
const MATCH_REGIONS = {
  TOP_SKY: [0, 1, 0, 0.15], // [x0, x1, y0, y1], fractions of the frame (y from the top)
  AURORA_MID: [0, 1, 0.2, 0.55],
  DARK_LEFT: [0, 0.15, 0.35, 0.6],
  HORIZON_GLOW: [0, 1, 0.55, 0.65],
  MOUNTAINS: [0, 1, 0.68, 0.82],
  FAR_WATER: [0, 1, 0.84, 0.92],
  NEAR_WATER: [0, 1, 0.92, 1],
};
const VIVID = args.includes('--vivid');
const VIVID_TIMES = [10, 80, 160, 260, 290, 350]; // quiet, 1:20, 2:40, building, climax, fade
const VIVID_SHOTS = [10, 260, 290];
const WATER_LINE = 0.18; // HORIZON in src/shaders/aurora/common.glsl (screen height of the water line)
const SMOOTH = args.includes('--smooth');
const SMOOTH_WINDOWS = [[10, 'quiet'], [255, 'building'], [287, 'climax']].filter(([t]) => !flag('--windows') || flag('--windows').split(',').map(Number).includes(t)); // s, 5 s each (--windows 287 = only those)
const SMOOTH_SHOTS = [160, 290, 350]; // s: 20 s of the 1:04 swell's melody: packets spawned against notes heard
const only = args.filter((a, i) => !a.startsWith('--') && !['--out', '--seq', '--windows', '--at'].includes(args[i - 1]));
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

  if (AURORA) {
    const result = await auroraPass(page, dir, seekAndPlay, state, analysis);
    const fps = await page.evaluate(() => window.__resonance.fps);
    fs.writeFileSync(path.join(dir, 'aurora-report.json'), JSON.stringify({ piece: piece.id, gpu, fps, errors, ...result }, null, 2));
    console.log(`  fps ${fps.toFixed(1)} · console errors ${errors.length}${errors.length ? ':\n    ' + errors.slice(0, 5).join('\n    ') : ''}`);
    console.log(`  -> ${dir}`);
    await page.close();
    return;
  }

  if (LOOK) {
    const result = await lookPass(page, dir, seekAndPlay);
    const fps = await page.evaluate(() => window.__resonance.fps);
    fs.writeFileSync(path.join(dir, 'look-report.json'), JSON.stringify({ piece: piece.id, gpu, fps, errors, ...result }, null, 2));
    console.log(`  fps ${fps.toFixed(1)} · console errors ${errors.length}${errors.length ? ':\n    ' + errors.slice(0, 5).join('\n    ') : ''}`);
    console.log(`  -> ${dir}`);
    await page.close();
    return;
  }

  if (VIVID) {
    const result = await vividPass(page, dir, seekAndPlay);
    const fps = await page.evaluate(() => window.__resonance.fps);
    fs.writeFileSync(path.join(dir, 'vivid-report.json'), JSON.stringify({ piece: piece.id, gpu, fps, errors, ...result }, null, 2));
    console.log(`  fps ${fps.toFixed(1)} · console errors ${errors.length}${errors.length ? ':\n    ' + errors.slice(0, 5).join('\n    ') : ''}`);
    console.log(`  -> ${dir}`);
    await page.close();
    return;
  }

  if (MATCH) {
    const result = await matchPass(page, dir, seekAndPlay);
    const fps = await page.evaluate(() => window.__resonance.fps);
    fs.writeFileSync(path.join(dir, 'match-report.json'), JSON.stringify({ piece: piece.id, gpu, fps, errors, ...result }, null, 2));
    console.log(`  fps ${fps.toFixed(1)} · console errors ${errors.length}${errors.length ? ':\n    ' + errors.slice(0, 5).join('\n    ') : ''}`);
    console.log(`  -> ${dir}`);
    await page.close();
    return;
  }

  if (SMOOTH) {
    const result = await smoothPass(page, dir, seekAndPlay);
    const fps = await page.evaluate(() => window.__resonance.fps);
    fs.writeFileSync(path.join(dir, 'smooth-report.json'), JSON.stringify({ piece: piece.id, gpu, fps, errors, ...result }, null, 2));
    console.log(`  fps ${fps.toFixed(1)} · console errors ${errors.length}${errors.length ? ':\n    ' + errors.slice(0, 5).join('\n    ') : ''}`);
    console.log(`  -> ${dir}`);
    await page.close();
    return;
  }

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

/** Scene 2's two-layer wave aurora: numbers at AURORA_TIMES, a melodic span, a travel check, screenshots, checks. */
async function auroraPass(page, dir, seekAndPlay, state, analysis) {
  const aurora = () => page.evaluate(() => window.__resonance.manager.current?.scene?.auroraState);
  // per-frame samples over `ms` in the page (rAF), so timing is the real frame timing
  const sampleFrames = (ms) =>
    page.evaluate(
      (ms) =>
        new Promise((done) => {
          const out = [];
          const t0 = performance.now();
          const tick = () => {
            const a = window.__resonance.manager.current.scene.auroraState;
            out.push({ t: window.__resonance.perf.t, low: a.low, melody: a.melody, amp: a.amp });
            if (performance.now() - t0 < ms) requestAnimationFrame(tick);
            else done(out);
          };
          requestAnimationFrame(tick);
        }),
      ms,
    );
  // play on (no seek) until the playhead reaches t: seeks clear the packets and restart the climax envelope
  const playTo = (t) => page.waitForFunction((t) => window.__resonance.perf.t >= t, t, { timeout: 120000, polling: 50 });
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const rows = [];
  console.log('    time   amp   packets low/mel  melody h  low note  activity  lum    night dawn  fps');
  let prev = -Infinity;
  for (const t of AURORA_TIMES) {
    // close samples play straight through: a seek restarts the climax envelope, so 5:11 must follow 4:50
    if (t - prev < 30) await playTo(t);
    else await seekAndPlay(t);
    prev = t;
    const frames = await sampleFrames(1000);
    const mean = (f) => frames.reduce((s, x) => s + f(x), 0) / frames.length;
    const activity = mean((x) => x.low.activity + x.melody.activity);
    const st = await state();
    const a = await aurora();
    const file = AURORA_SHOTS.includes(t) ? path.join(dir, `aurora-${fmt(t).replace(':', 'm')}.png`) : null;
    const f = await frameStats(page, file);
    const row = { t, amp: a.amp, low: mean((x) => x.low.active), melody: mean((x) => x.melody.active), melodyHeight: a.melodyHeight, lowNote: a.lowNote, activity, lum: f.lum, night: a.night, dawn: a.dawn, nightSource: a.nightSource, fps: st.fps, stage: st.stage, file };
    rows.push(row);
    console.log(
      `  ${fmt(t).padStart(7)}  ${a.amp.toFixed(2)}   ${row.low.toFixed(1).padStart(4)} / ${row.melody.toFixed(1).padEnd(5)}     ${a.melodyHeight.toFixed(2)}      ${(a.lowNote >= 0 ? names[a.lowNote] : '-').padEnd(3)}      ${activity.toFixed(2).padStart(5)}    ${f.lum.toFixed(3)}  ${a.night.toFixed(2)}  ${a.dawn.toFixed(2)}  ${st.fps.toFixed(0)}  ${st.stage}${file ? '  [shot]' : ''}`,
    );
  }

  // (a) a melodic span: packets spawned against the notes of each voice
  await seekAndPlay(AURORA_TRACE[0]);
  const before = await aurora();
  await playTo(AURORA_TRACE[1]);
  const after = await aurora();
  const count = (n) => n.times.filter((t) => t >= AURORA_TRACE[0] && t < AURORA_TRACE[1]).length;
  const notes = { melody: count(analysis.voices.melody.notes), low: count(analysis.voices.low.notes) };
  const span = {
    melodyNotes: notes.melody,
    lowNotes: notes.low,
    melodyHeard: after.melody.heard - before.melody.heard,
    lowHeard: after.low.heard - before.low.heard,
    melodySpawned: after.melody.spawned - before.melody.spawned,
    lowSpawned: after.low.spawned - before.low.spawned,
    melodySpeed: after.melody.speed,
    lowSpeed: after.low.speed,
  };
  console.log(`  melodic span ${fmt(AURORA_TRACE[0])}-${fmt(AURORA_TRACE[1])}: melody ${span.melodyNotes} notes (${span.melodyHeard} heard) -> ${span.melodySpawned} packets · low ${span.lowNotes} notes (${span.lowHeard} heard) -> ${span.lowSpawned} packets · speed melody ${span.melodySpeed.toFixed(3)} / low ${span.lowSpeed.toFixed(3)} screens/s`);

  // (b) travel: every packet's position moves monotonically in its layer's direction, frame to frame
  await seekAndPlay(AURORA_SEQ - 2);
  const frames = await sampleFrames(1200);
  const travel = { checked: 0, wrong: 0, distance: { low: [], melody: [] } };
  for (const [name, dirn] of [['low', 1], ['melody', -1]]) {
    const seen = new Map();
    for (const fr of frames) {
      for (const p of fr[name].packets) {
        const last = seen.get(p.id);
        if (last !== undefined) {
          travel.checked++;
          if ((p.x - last.x) * dirn < -1e-6) travel.wrong++;
          last.d += Math.abs(p.x - last.x);
          last.x = p.x;
        } else seen.set(p.id, { x: p.x, d: 0 });
      }
    }
    travel.distance[name] = [...seen.values()].map((v) => v.d);
  }
  const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  console.log(`  travel over ${frames.length} frames: ${travel.checked} packet steps, ${travel.wrong} backwards · mean distance in 1.2 s: low ${avg(travel.distance.low).toFixed(3)}, melody ${avg(travel.distance.melody).toFixed(3)} screen widths`);

  // a short frame sequence (5 frames over ~1 s) to see the movement
  await playTo(AURORA_SEQ);
  const seq = [];
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    const file = path.join(dir, `aurora-seq-${i}.png`);
    await page.screenshot({ path: file });
    seq.push({ t: await page.evaluate(() => window.__resonance.perf.t), file });
    await sleep(Math.max(0, 250 - (Date.now() - t0)));
  }
  console.log(`  sequence: ${seq.map((s) => fmt(s.t)).join(', ')}`);

  const at = (t) => rows.find((r) => r.t === t);
  const quiet = Math.max(...AURORA_QUIET.map((t) => at(t).activity));
  const peak = at(290).activity;
  const checks = {
    melodyPerNote: span.melodySpawned >= 0.75 * span.melodyNotes && span.melodySpawned <= span.melodyNotes,
    lowFewer: span.lowSpawned <= 0.6 * span.melodySpawned,
    lowSlower: span.lowSpeed < 0.6 * span.melodySpeed,
    travels: travel.checked > 20 && travel.wrong === 0,
    quietLow: quiet < 0.4 * peak,
    peaksAtClimax: rows.every((r) => r.activity <= peak + 1e-3) && rows.every((r) => r.amp <= at(290).amp + 1e-3),
    lowerAfter: at(311).activity < peak && at(311).amp < 0.8 * at(290).amp,
    neverBlank: rows.every((r) => r.amp > 0.04),
    // the night: deepens up to the climax, deepest there, dawn only after it
    nightDeepens: rows.filter((r) => r.t <= 290).every((r, i, a) => i === 0 || r.night > a[i - 1].night) && rows.every((r) => r.night <= at(290).night + 1e-3),
    dawnAfter: rows.every((r) => (r.t <= 290 ? r.dawn < 0.02 : true)) && at(350).dawn > 0.3 && at(350).night < at(290).night - 0.2,
    nightTimeline: rows.every((r) => r.nightSource === 'score'),
  };
  const ok = (v) => (v ? 'PASS' : 'FAIL');
  console.log(`  (a) melody ${span.melodySpawned}/${span.melodyNotes} notes -> ${ok(checks.melodyPerNote)} one per note · low ${span.lowSpawned} -> ${ok(checks.lowFewer)} far fewer · ${ok(checks.lowSlower)} slower`);
  console.log(`  (b) ${ok(checks.travels)} packets travel monotonically`);
  console.log(`  (c) quiet (0:10, 3:25, 5:50) max activity ${quiet.toFixed(2)} vs 4:50 ${peak.toFixed(2)} -> ${ok(checks.quietLow)} low · ${ok(checks.peaksAtClimax)} peaks at 4:50 · 5:11 ${at(311).activity.toFixed(2)} (amp ${((at(311).amp / at(290).amp) * 100).toFixed(0)} %) -> ${ok(checks.lowerAfter)} lower · ${ok(checks.neverBlank)} never blank`);
  console.log(`  night: ${rows.map((r) => `${fmt(r.t)} ${r.night.toFixed(2)}/${r.dawn.toFixed(2)}`).join(' · ')} -> ${ok(checks.nightDeepens)} deepens to 4:50 · ${ok(checks.dawnAfter)} dawn after · ${ok(checks.nightTimeline)} from the timeline`);
  return { rows, span, travel: { checked: travel.checked, wrong: travel.wrong }, seq, checks };
}

/** Aurora hue / saturation, warm share of the sky and mean luminance of a screenshot (see --look). */
async function lookStats(page, file) {
  const png = await page.screenshot({ path: file ?? undefined });
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const W = 320;
    const H = 180;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0, W, H);
    const px = g.getImageData(0, 0, W, H).data;
    const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    const sky = [];
    let Ysum = 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = 4 * (y * W + x);
        const R = px[i] / 255;
        const G = px[i + 1] / 255;
        const B = px[i + 2] / 255;
        const r = lin(R);
        const gr = lin(G);
        const b = lin(B);
        const Y = 0.2126 * r + 0.7152 * gr + 0.0722 * b;
        Ysum += Y;
        if (y >= H * 0.58) continue; // the sky: the top 58 % of the frame
        const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * gr + 0.0514459929 * b);
        const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * gr + 0.1073969566 * b);
        const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * gr + 0.6299787005 * b);
        const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
        const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
        const Bk = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
        const mx = Math.max(R, G, B);
        sky.push({ Y, L, C: Math.hypot(A, Bk), h: ((Math.atan2(Bk, A) * 180) / Math.PI + 360) % 360, sat: mx > 0 ? (mx - Math.min(R, G, B)) / mx : 0 });
      }
    // the aurora: the brightest 30 % of the sky
    const byY = sky.map((p) => p.Y).sort((a, b) => a - b);
    const cut = byY[Math.floor(byY.length * 0.7)];
    const aur = sky.filter((p) => p.Y >= cut);
    const bins = new Float32Array(36);
    let sat = 0;
    for (const p of aur) {
      sat += p.sat;
      if (p.C > 0.02) bins[Math.floor(p.h / 10)] += p.C;
    }
    let top = 0;
    for (let i = 1; i < 36; i++) if (bins[i] > bins[top]) top = i;
    const warm = sky.filter((p) => p.h >= 20 && p.h <= 80 && p.C > 0.035 && p.L > 0.3).length / sky.length;
    return { hue: top * 10 + 5, sat: sat / aur.length, chroma: aur.reduce((s, p) => s + p.C, 0) / aur.length, warm, lum: Ysum / (W * H) };
  }, png.toString('base64'));
}

async function lookPass(page, dir, seekAndPlay) {
  const playTo = (t) => page.waitForFunction((t) => window.__resonance.perf.t >= t, t, { timeout: 120000, polling: 50 });
  const rows = [];
  console.log('    time   aurora hue  sat    chroma  warm sky  lum     fps');
  let prev = -Infinity;
  for (const t of LOOK_TIMES) {
    if (t - prev < 30) await playTo(t);
    else await seekAndPlay(t);
    prev = t;
    const file = LOOK_SHOTS.includes(t) ? path.join(dir, `look-${fmt(t).replace(':', 'm')}.png`) : null;
    const f = await lookStats(page, file);
    const fps = await page.evaluate(() => window.__resonance.fps);
    rows.push({ t, ...f, fps, file });
    console.log(`  ${fmt(t).padStart(7)}  ${String(f.hue).padStart(4)}°      ${f.sat.toFixed(3)}  ${f.chroma.toFixed(3)}   ${(f.warm * 100).toFixed(1).padStart(5)} %   ${f.lum.toFixed(4)}  ${fps.toFixed(0)}${file ? '  [shot]' : ''}`);
  }
  const green = rows.filter((r) => r.hue >= 125 && r.hue <= 170).length;
  const meanSat = rows.reduce((s, r) => s + r.sat, 0) / rows.length;
  const night = rows.filter((r) => r.t >= 60 && r.t <= 320);
  const warmOk = night.filter((r) => r.warm < 0.01).length;
  console.log(`  aurora hue green (125-170°) in ${green}/${rows.length} · mean saturation ${meanSat.toFixed(3)} · no warm clouds (< 1 %, 1:00-5:20) in ${warmOk}/${night.length}`);
  return { rows, meanSat, green, warmOk };
}

/**
 * Region means, bright core and star count of an image (in the page: `src` is a
 * URL or data URL), measured at 1280 x 720. With `pair`, also returns a
 * side-by-side PNG (data URL) of `pair` (left) and this image (right).
 */
function regionStats(page, src, regions, pair) {
  return page.evaluate(
    async ({ src, regions, pair }) => {
      const load = async (u) => {
        const img = new Image();
        img.src = u;
        await img.decode();
        return img;
      };
      const img = await load(src);
      const W = 1280;
      const H = 720;
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0, W, H);
      const px = g.getImageData(0, 0, W, H).data;
      const luma = (i) => (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;
      const hex = (r, gg, b) => '#' + [r, gg, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
      const out = {};
      for (const [name, [x0, x1, y0, y1]] of Object.entries(regions)) {
        let r = 0, gg = 0, b = 0, n = 0;
        for (let y = Math.floor(y0 * H); y < Math.floor(y1 * H); y++)
          for (let x = Math.floor(x0 * W); x < Math.floor(x1 * W); x++) {
            const i = 4 * (y * W + x);
            r += px[i];
            gg += px[i + 1];
            b += px[i + 2];
            n++;
          }
        out[name] = { hex: hex(r / n, gg / n, b / n), luma: (0.2126 * r + 0.7152 * gg + 0.0722 * b) / n / 255 };
      }
      // the bright cores: the brightest 2 % of the sky (top 65 %)
      const SKY = Math.floor(H * 0.65);
      const sky = [];
      for (let i = 0; i < W * SKY; i++) sky.push(luma(4 * i));
      const cut = [...sky].sort((a, b) => a - b)[Math.floor(sky.length * 0.98)];
      let r = 0, gg = 0, b = 0, n = 0;
      for (let i = 0; i < W * SKY; i++)
        if (sky[i] >= cut) {
          r += px[4 * i];
          gg += px[4 * i + 1];
          b += px[4 * i + 2];
          n++;
        }
      out.CORE = { hex: hex(r / n, gg / n, b / n), luma: (0.2126 * r + 0.7152 * gg + 0.0722 * b) / n / 255 };
      // stars: a sharp local maximum (5x5) clearly above the ring 3 px around it
      let stars = 0;
      for (let y = 3; y < SKY - 3; y++)
        for (let x = 3; x < W - 3; x++) {
          const v = sky[y * W + x];
          let ring = 0;
          for (const [dx, dy] of [[3, 0], [-3, 0], [0, 3], [0, -3], [2, 2], [-2, 2], [2, -2], [-2, -2]]) ring += sky[(y + dy) * W + x + dx];
          if (v - ring / 8 < 0.05) continue;
          let max = true;
          for (let dy = -2; dy <= 2 && max; dy++) for (let dx = -2; dx <= 2; dx++) if ((dx || dy) && sky[(y + dy) * W + x + dx] > v) { max = false; break; }
          if (max) stars++;
        }
      out.STARS = stars;
      if (pair) {
        const sb = document.createElement('canvas');
        sb.width = 2 * W;
        sb.height = H;
        const sg = sb.getContext('2d');
        sg.drawImage(await load(pair), 0, 0, W, H);
        sg.drawImage(img, W, 0, W, H);
        out.pair = sb.toDataURL('image/png');
      }
      return out;
    },
    { src, regions, pair },
  );
}

/** OKLab of an sRGB hex. */
function oklab(hex) {
  const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

/** HSV hue (°) and saturation of an sRGB hex. */
function hsv(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const mx = Math.max(r, g, b);
  const d = mx - Math.min(r, g, b);
  const h = d === 0 ? 0 : mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: Math.round(((h * 60) + 360) % 360), s: mx ? d / mx : 0 };
}

/** Aurora colour stats and the reflection ratio of a screenshot (see --vivid). */
async function vividStats(page, file, reach) {
  const png = await page.screenshot({ path: file ?? undefined });
  return page.evaluate(
    async ({ b64, reach, line }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const W = 640;
      const H = 360;
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0, W, H);
      const px = g.getImageData(0, 0, W, H).data;
      const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      const Yat = (x, y) => {
        const i = 4 * (y * W + x);
        return 0.2126 * lin(px[i] / 255) + 0.7152 * lin(px[i + 1] / 255) + 0.0722 * lin(px[i + 2] / 255);
      };
      // the sky above the mountains
      const SKY = Math.floor(H * 0.64);
      const sky = [];
      for (let y = 0; y < SKY; y++) for (let x = 0; x < W; x++) sky.push(Yat(x, y));
      const median = [...sky].sort((a, b) => a - b)[Math.floor(sky.length / 2)];
      const chroma = (r, gg, b) => {
        const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * gg + 0.0514459929 * b);
        const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * gg + 0.1073969566 * b);
        const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * gg + 0.6299787005 * b);
        return Math.hypot(1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s);
      };
      let n = 0, sat = 0, clipped = 0;
      const bands = { green: 0, cyan: 0, blue: 0, purple: 0 };
      const lumas = [];
      for (let y = 0; y < SKY; y++)
        for (let x = 0; x < W; x++) {
          const Y = sky[y * W + x];
          const i = 4 * (y * W + x);
          const r = px[i] / 255, gg = px[i + 1] / 255, b = px[i + 2] / 255;
          // aurora: brighter than the sky around, or clearly coloured (dim violet counts too)
          if (Y < 1.6 * median && chroma(lin(r), lin(gg), lin(b)) < 0.09) continue;
          const mx = Math.max(r, gg, b);
          const d = mx - Math.min(r, gg, b);
          const h = d === 0 ? 0 : ((mx === r ? ((gg - b) / d) % 6 : mx === gg ? (b - r) / d + 2 : (r - gg) / d + 4) * 60 + 360) % 360;
          n++;
          sat += mx ? d / mx : 0;
          if (mx >= 253 / 255) clipped++;
          lumas.push(0.2126 * r + 0.7152 * gg + 0.0722 * b);
          if (h >= 75 && h < 165) bands.green++;
          else if (h >= 165 && h < 195) bands.cyan++;
          else if (h >= 195 && h < 250) bands.blue++;
          else if (h >= 250 && h < 345) bands.purple++;
        }
      lumas.sort((a, b) => a - b);
      // reflection: each water pixel against the sky it mirrors (where that sky is bright)
      const ratio = (d0, d1) => {
        let w = 0, s = 0;
        for (let yy = Math.ceil((1 - line + d0) * H); yy < Math.min(H, (1 - line + d1) * H); yy++) {
          const depth = yy / H - (1 - line); // below the water line (screen heights)
          const ys = Math.round((1 - line - depth * reach) * H);
          if (ys < 0) continue;
          for (let x = 0; x < W; x++) {
            const Ys = Yat(x, ys);
            if (Ys < Math.max(0.02, median)) continue;
            w += Yat(x, yy);
            s += Ys;
          }
        }
        return s > 0 ? w / s : 0;
      };
      for (const k of Object.keys(bands)) bands[k] = n ? bands[k] / n : 0;
      return { share: n / sky.length, sat: n ? sat / n : 0, peak: lumas[Math.floor(lumas.length * 0.995)] ?? 0, clipped: n ? clipped / n : 0, bands, near: ratio(0.03, 0.09), far: ratio(0.12, 0.175) };
    },
    { b64: png.toString('base64'), reach, line: WATER_LINE },
  );
}

async function vividPass(page, dir, seekAndPlay) {
  const { PROFILE } = await import('../src/scenes/profiles/standchen.js');
  const reach = PROFILE.LOOK.WATER.REACH;
  const playTo = (t) => page.waitForFunction((t) => window.__resonance.perf.t >= t, t, { timeout: 120000, polling: 50 });
  const ribbons = () => page.evaluate(() => window.__resonance.manager.current.scene.auroraState.ribbons);
  const rows = [];
  console.log('    time   ribbons  aurora  sat    peak   clip   green  cyan   blue   purple  reflection near / far  fps');
  const line = (label, f, rb, fps, shot) =>
    console.log(`  ${label.padStart(7)}  ${String(rb).padStart(4)}     ${(f.share * 100).toFixed(0).padStart(3)} %  ${f.sat.toFixed(2)}   ${f.peak.toFixed(2)}   ${(f.clipped * 100).toFixed(1).padStart(4)}%  ${['green', 'cyan', 'blue', 'purple'].map((k) => `${(f.bands[k] * 100).toFixed(0).padStart(3)} % `).join(' ')}  ${f.near.toFixed(2)} / ${f.far.toFixed(2)}        ${fps.toFixed(0)}${shot ? '  [shot]' : ''}`);
  let prev = -Infinity;
  for (const t of VIVID_TIMES) {
    if (t - prev < 30) await playTo(t);
    else await seekAndPlay(t);
    prev = t;
    const file = VIVID_SHOTS.includes(t) ? path.join(dir, `vivid-${fmt(t).replace(':', 'm')}.png`) : null;
    const f = await vividStats(page, file, reach);
    const rb = await ribbons();
    const fps = await page.evaluate(() => window.__resonance.fps);
    rows.push({ t, ribbons: rb, fps, file, ...f });
    line(fmt(t), f, rb, fps, file);
  }
  // the muted palette at the climax, for comparison
  await seekAndPlay(290);
  await page.keyboard.press('v');
  await sleep(300);
  const muted = await vividStats(page, path.join(dir, 'muted-4m50.0.png'), reach);
  await page.keyboard.press('v');
  line('muted', muted, await ribbons(), await page.evaluate(() => window.__resonance.fps), true);
  const at = (t) => rows.find((r) => r.t === t);
  const climax = at(290);
  const quiet = at(10);
  const ok = (b) => (b ? 'PASS' : 'FAIL');
  const checks = {
    saturation: climax.sat > muted.sat + 0.15,
    colours: ['green', 'blue', 'purple'].every((k) => climax.bands[k] >= 0.1),
    ribbons: climax.ribbons >= 4 && quiet.ribbons <= 3,
    reflection: climax.near >= 0.5 && climax.near <= 0.7,
    quiet: quiet.sat < climax.sat && quiet.sat >= 0.45,
  };
  console.log(`  ${ok(checks.saturation)} climax saturation ${climax.sat.toFixed(2)} vs muted ${muted.sat.toFixed(2)} · ${ok(checks.colours)} green / blue / purple >= 10 % (${['green', 'blue', 'purple'].map((k) => (climax.bands[k] * 100).toFixed(0)).join(' / ')} %) · ${ok(checks.ribbons)} ribbons ${quiet.ribbons} quiet -> ${climax.ribbons} climax · ${ok(checks.reflection)} reflection ${climax.near.toFixed(2)} near the horizon (0.5-0.7) · ${ok(checks.quiet)} quiet calmer, still colourful (${quiet.sat.toFixed(2)})`);
  return { rows, muted, checks };
}

async function matchPass(page, dir, seekAndPlay) {
  const { PROFILE } = await import('../src/scenes/profiles/standchen.js');
  const REF = PROFILE.LOOK.REFERENCE;
  const refFile = path.join(ROOT, 'public', 'textures', 'aurora-reference-2.jpg');
  const hasRef = fs.existsSync(refFile);
  await seekAndPlay(MATCH_TIME);
  const file = path.join(dir, `match-${fmt(MATCH_TIME).replace(':', 'm')}.png`);
  const png = await page.screenshot({ path: file });
  const pair = hasRef ? `data:image/jpeg;base64,${fs.readFileSync(refFile).toString('base64')}` : null;
  const got = await regionStats(page, `data:image/png;base64,${png.toString('base64')}`, MATCH_REGIONS, pair);
  let ref;
  if (hasRef) {
    ref = await regionStats(page, pair, MATCH_REGIONS, null);
    const side = path.join(dir, `match-side-by-side.png`);
    fs.writeFileSync(side, Buffer.from(got.pair.split(',')[1], 'base64'));
    delete got.pair;
    console.log(`  reference: ${path.relative(ROOT, refFile)} (measured) · side by side -> ${side}`);
  } else {
    const lumaOf = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
    ref = Object.fromEntries([...Object.keys(MATCH_REGIONS), 'CORE'].map((k) => [k, { hex: REF[k], luma: lumaOf(REF[k]) }]));
    ref.STARS = REF.STARS;
    console.log(`  reference: PROFILE.LOOK.REFERENCE (no ${path.relative(ROOT, refFile)})`);
  }
  const rows = [];
  console.log(`  at ${fmt(MATCH_TIME)}       result   luma   | reference luma  | Δluma   ΔE     hue/sat result -> ref`);
  for (const k of [...Object.keys(MATCH_REGIONS), 'CORE']) {
    const a = got[k];
    const b = ref[k];
    const dl = (a.luma - b.luma) / b.luma;
    const [l1, a1, b1] = oklab(a.hex);
    const [l2, a2, b2] = oklab(b.hex);
    const dE = Math.hypot(l1 - l2, a1 - a2, b1 - b2);
    const ok = Math.abs(dl) <= 0.15 && dE <= 0.05;
    const h1 = hsv(a.hex);
    const h2 = hsv(b.hex);
    rows.push({ region: k, hex: a.hex, luma: a.luma, refHex: b.hex, refLuma: b.luma, dLuma: dl, dE, hue: h1.h, sat: h1.s, refHue: h2.h, refSat: h2.s, ok });
    console.log(`  ${k.padEnd(13)} ${a.hex}  ${a.luma.toFixed(3)}  | ${b.hex}  ${b.luma.toFixed(3)}  | ${((dl >= 0 ? '+' : '') + (dl * 100).toFixed(0) + ' %').padStart(6)}  ${dE.toFixed(3)}  ${String(h1.h).padStart(3)}°/${h1.s.toFixed(2)} -> ${String(h2.h).padStart(3)}°/${h2.s.toFixed(2)}  ${ok ? 'ok' : 'OFF'}`);
  }
  const ds = (got.STARS - ref.STARS) / ref.STARS;
  console.log(`  STARS         ${String(got.STARS).padStart(7)}         | ${String(ref.STARS).padStart(7)}         | ${((ds >= 0 ? '+' : '') + (ds * 100).toFixed(0) + ' %').padStart(6)}  ${Math.abs(ds) <= 0.5 ? 'ok' : 'OFF'}`);
  const passed = rows.filter((r) => r.ok).length;
  console.log(`  ${passed}/${rows.length} regions within 15 % luma and ΔE 0.05 · stars ${got.STARS} vs ${ref.STARS} · shot -> ${file}`);
  return { time: MATCH_TIME, reference: hasRef ? 'image' : 'profile', rows, stars: got.STARS, refStars: ref.STARS, passed };
}

/**
 * Every frame for `ms`, read back the sky above the mountains (top 38 % of
 * the canvas, downsampled to 320 px wide) right after the scene has drawn it,
 * and return flicker, grain, luminance, chroma and the p98 highlight.
 */
function measureNoise(page, ms) {
  return page.evaluate(
    (ms) =>
      new Promise((done) => {
        const src = window.__resonance.renderer.domElement;
        const W = 320;
        const sh = Math.round(src.height * 0.38);
        const H = Math.round((W * sh) / src.width);
        const c = document.createElement('canvas');
        c.width = W;
        c.height = H;
        const g = c.getContext('2d', { willReadFrequently: true });
        const lin = new Float32Array(256).map((_, i) => (i / 255 <= 0.04045 ? i / 255 / 12.92 : ((i / 255 + 0.055) / 1.055) ** 2.4));
        let prev = null;
        let prev2 = null;
        const acc = { frames: 0, flicker: 0, boil: 0, grain: 0, lum: 0, chroma: 0, p98: 0 };
        const t0 = performance.now();
        const tick = () => {
          g.drawImage(src, 0, 0, src.width, sh, 0, 0, W, H);
          const px = g.getImageData(0, 0, W, H).data;
          const Y = new Float32Array(W * H);
          let lum = 0;
          let chroma = 0;
          for (let i = 0; i < W * H; i++) {
            const r = lin[px[4 * i]];
            const gr = lin[px[4 * i + 1]];
            const b = lin[px[4 * i + 2]];
            Y[i] = 0.2126 * r + 0.7152 * gr + 0.0722 * b;
            lum += Y[i];
            chroma += Math.max(r, gr, b) - Math.min(r, gr, b);
          }
          let lap = 0;
          for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
            const i = y * W + x;
            lap += Math.abs(4 * Y[i] - Y[i - 1] - Y[i + 1] - Y[i - W] - Y[i + W]);
          }
          if (prev) {
            let d = 0;
            for (let i = 0; i < W * H; i++) d += Math.abs(Y[i] - prev[i]);
            acc.flicker += d / (W * H);
          }
          if (prev2) {
            // temporal second difference: ~0 for smooth motion, large for boiling / strobing
            let d2 = 0;
            for (let i = 0; i < W * H; i++) d2 += Math.abs(prev[i] - 0.5 * (Y[i] + prev2[i]));
            acc.boil += d2 / (W * H);
          }
          prev2 = prev;
          const sorted = Y.slice().sort();
          acc.p98 += sorted[Math.floor(0.98 * sorted.length)];
          acc.grain += lap / ((W - 2) * (H - 2));
          acc.lum += lum / (W * H);
          acc.chroma += chroma / (W * H);
          acc.frames++;
          prev = Y;
          if (performance.now() - t0 < ms) requestAnimationFrame(tick);
          else {
            const n = acc.frames;
            done({ frames: n, flicker: acc.flicker / (n - 1), boil: acc.boil / (n - 2), grain: acc.grain / n, lum: acc.lum / n, chroma: acc.chroma / n, p98: acc.p98 / n, fps: window.__resonance.fps });
          }
        };
        requestAnimationFrame(tick);
      }),
    ms,
  );
}

async function smoothPass(page, dir, seekAndPlay) {
  const setLook = (clean, hideStars) =>
    page.evaluate(([clean, hideStars]) => {
      const sc = window.__resonance.manager.current.scene;
      sc.clean = clean;
      sc.hideStars = hideStars;
      sc.seed = 0x2f6e2b1; // the same packet positions for both looks
    }, [clean, hideStars]);
  const rows = [];
  console.log('    window              look      flicker  grain    lum     chroma  p98     fps');
  for (const [t, name] of SMOOTH_WINDOWS) {
    const row = { t, name };
    // A B B A: each look measured twice, in alternating order, and averaged (playback varies run to run)
    const runs = { previous: [], clean: [] };
    for (const look of ['previous', 'clean', 'clean', 'previous']) {
      await setLook(look === 'clean', true);
      await seekAndPlay(t, 4);
      runs[look].push(await measureNoise(page, 5000));
    }
    for (const look of ['previous', 'clean']) {
      const [a, b] = runs[look];
      const m = Object.fromEntries(Object.keys(a).map((k) => [k, (a[k] + b[k]) / 2]));
      row[look] = m;
      console.log(`  ${fmt(t).padStart(7)}-${fmt(t + 5)} ${name.padEnd(9)} ${look.padEnd(9)} ${(m.flicker * 1e4).toFixed(2).padStart(6)}  ${(m.grain * 1e4).toFixed(2).padStart(6)}  ${m.lum.toFixed(4)}  ${m.chroma.toFixed(4)}  ${m.p98.toFixed(4)}  ${m.fps.toFixed(0)}`);
    }
    const o = row.previous;
    const c = row.clean;
    row.flickerDrop = 1 - c.flicker / o.flicker;
    row.boilDrop = 1 - c.boil / o.boil;
    row.relFlickerDrop = 1 - c.flicker / c.lum / (o.flicker / o.lum); // per unit of light
    row.grainDrop = 1 - c.grain / o.grain;
    row.lumRatio = c.lum / o.lum;
    row.chromaRatio = c.chroma / o.chroma;
    row.p98Ratio = c.p98 / o.p98;
    console.log(`  ${''.padStart(25)} -> flicker ${(row.flickerDrop * 100).toFixed(0)} % less (${(row.relFlickerDrop * 100).toFixed(0)} % per unit of light) · temporal noise ${(row.boilDrop * 100).toFixed(0)} % less · grain ${(row.grainDrop * 100).toFixed(0)} % less · lum ${(row.lumRatio * 100).toFixed(0)} % · chroma ${(row.chromaRatio * 100).toFixed(0)} % · p98 ${(row.p98Ratio * 100).toFixed(0)} %`);
    rows.push(row);
  }
  await setLook(true, false);
  const shots = [];
  for (const t of flag('--windows') ? [] : SMOOTH_SHOTS) {
    await seekAndPlay(t);
    const file = path.join(dir, `smooth-${fmt(t).replace(':', 'm')}.png`);
    await page.screenshot({ path: file });
    shots.push(file);
  }
  const checks = {
    flicker: rows.every((r) => r.flickerDrop >= 0.4),
    temporalNoise: rows.every((r) => r.boilDrop >= 0.4),
    grain: rows.every((r) => r.grainDrop >= 0.4),
    brightness: rows.every((r) => r.lumRatio >= 0.9 && r.p98Ratio >= 0.9), // (not shrinking: brighter is fine)
    colour: rows.every((r) => r.chromaRatio >= 0.9),
  };
  const ok = (v) => (v ? 'PASS' : 'FAIL');
  console.log(`  ${ok(checks.flicker)} flicker -40 % · ${ok(checks.temporalNoise)} temporal noise -40 % · ${ok(checks.grain)} grain -40 % · ${ok(checks.brightness)} brightness not down > 10 % · ${ok(checks.colour)} colour range kept · shots ${SMOOTH_SHOTS.map(fmt).join(', ')}`);
  return { rows, shots, checks };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
