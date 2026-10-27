#!/usr/bin/env node
/**
 * analyze.mjs: offline analysis of every piece in /public/Music.
 *
 *   npm run analyze                 all pieces
 *   npm run analyze -- standchen    only pieces whose id or file name matches
 *
 * For each file it writes /public/analysis/<id>.json (see FORMAT below) and
 * prints a human-readable summary to check against what you hear. Needs
 * ffmpeg on the PATH (decoding only; all analysis is plain JS).
 *
 * Hand edits: the `manual` block of an existing JSON is kept when the file is
 * regenerated. It can hold
 *   boundaries: [s, ...]             section starts to use instead of the automatic ones
 *   sections:   [{ at, role, label, mood, hue }]   overrides for the section containing `at`
 *   cues:       [{ t, type, value }]               extra cue points (type 'hue', 'burst', 'flash', ...)
 * Boundaries take effect on the next `npm run analyze`; section overrides and
 * cues are applied both here (in the summary) and at runtime (scoreMap.js).
 *
 * FORMAT (times in seconds; curves are sampled at `frameRate`, frame i at i / frameRate):
 *   loudness.db        short-term (0.4 s) A-weighted loudness, dBFS
 *   loudness.slowDb    the same smoothed over ~3 s (structure)
 *   loudness.percentiles  p2 ... p99 and max of loudness.db (audible frames only)
 *   level              loudness.db mapped p5 -> 0, p99 -> 1 for THIS piece (loudness.range)
 *   bands.bass/mid/treble  20-150 / 150-2000 / 2000-8000 Hz energy, 0..1 per piece
 *   centroid           spectral centroid, Hz
 *   melody.hz / height / confidence   predominant pitch (0 = none), log pitch
 *                      height 0..1 over melody.range, and how clear it is
 *   chroma             12-bin pitch-class frames (C..B, max = 1) at chromaRate
 *   onsets.times / strength   spectral-flux onsets, strength 0..1
 *   voices.low         the low register (bass notes, low chord tones; src/voices.js):
 *                      hz / height / confidence curves, `note` (dominant low pitch
 *                      class of the smoothed low-register chroma, per chroma frame,
 *                      -1 = none) and notes { times, strength, height, pc }
 *   voices.melody      the singing top line: hz / height / confidence curves over its
 *                      own register, range [lo, hi] Hz, notes { times, strength, height, pc }
 *   tempo { bpm, confidence }, beats [s]
 *   keys.windows       Krumhansl key estimate per 15 s window (5 s hop)
 *   keys.regions       the same merged into regions
 *   sections           [{ start, end, role, label, letter, mood, level, peak, key }]
 *   climaxes.sustained / climaxes.rise   top moments by sustained loudness and by loudness rise
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PIECES, pieceForFile, MUSIC_DIR, ANALYSIS_DIR } from '../src/pieces.js';
import { VOICES } from '../src/voices.js';

// ====================================================================== config
const CONFIG = {
  SR: 22050, // decode rate (Nyquist 11 kHz is plenty for structure, onsets and pitch)
  N: 2048, // short FFT (93 ms): loudness, bands, flux
  N_LONG: 4096, // long FFT (186 ms): chroma and melody
  HOP: 512, // analysis hop (23 ms); onsets keep this precision
  DECIMATE: 2, // curves are written every 2nd hop (46 ms)
  SILENCE_DB: -70, // frames below this are left out of the loudness percentiles
  LOUDNESS_WINDOW: 0.4, // s, short-term loudness
  SLOW_WINDOW: 3, // s, structural loudness
  BANDS: { bass: [20, 150], mid: [150, 2000], treble: [2000, 8000] },
  ONSET: { FMIN: 30, FMAX: 8000, MEDIAN: 0.5, DELTA: 0.07, PEAK: 0.05, MIN_GAP: 0.05 },
  TEMPO: { MIN_BPM: 40, MAX_BPM: 180, PRIOR_BPM: 90, PRIOR_OCTAVES: 1, TIGHTNESS: 60 },
  CHROMA: { FMIN: 55, FMAX: 4000, DECIMATE: 4, SMOOTH: 0.2 },
  KEY: { WINDOW: 15, HOP: 5, SWITCH_PENALTY: 0.12, MIN_REGION: 10 },
  MELODY: {
    FMIN: 130.8, // C3
    FMAX: 1568, // G6
    STEPS_PER_SEMITONE: 3,
    HARMONICS: 6,
    DECAY: 0.8, // weight of each further harmonic
    JUMP_COST: 0.5, // Viterbi cost per octave of jump
    TOP_VOICE: 0.15, // bias toward the highest voice (classical melodies sit on top)
    CONFIDENCE: [2.0, 4.5], // salience peak / mean that maps to confidence 0 / 1
  },
  SECTIONS: {
    BLOCK: 0.5, // s per feature block
    KERNEL: 10, // s, half width of the checkerboard kernel
    LOUDNESS_SPAN: 8, // s each side for the loudness-change novelty
    MIN_LEN: 12, // s, shortest section
    TARGET_LEN: 35, // s, typical section length (sets how many boundaries are kept)
    MIN_PEAK: 0.15, // novelty peaks below this share of the maximum are ignored
    SAME_LETTER: 0.8, // feature distance (z units) under which two sections share a letter
    MAX_LEN: 60, // s, longer sections are split at their strongest inner change
    FADE_LEVEL: 0.5, // the final fade starts after the last moment the slow level is above this
    FADE_MIN_LEN: 6, // s, a shorter dying-away is part of the last section
  },
  CLIMAX: { SUSTAIN: 4, MIN_SEPARATION: 20, RISE_SPAN: 3, RISE_SEPARATION: 15, COUNT: 5 },
};
// ============================================================================

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MUSIC = path.join(ROOT, 'public', MUSIC_DIR);
const OUT = path.join(ROOT, 'public', ANALYSIS_DIR);
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const round = (v, d) => {
  const k = 10 ** d;
  return Math.round(v * k) / k;
};
const mean = (a, lo = 0, hi = a.length) => {
  let s = 0;
  for (let i = lo; i < hi; i++) s += a[i];
  return hi > lo ? s / (hi - lo) : 0;
};
function percentile(values, p) {
  if (!values.length) return 0;
  const s = Float64Array.from(values).sort();
  const x = (p / 100) * (s.length - 1);
  const i = Math.floor(x);
  return s[i] + (s[Math.min(i + 1, s.length - 1)] - s[i]) * (x - i);
}
/** Centred moving average over `w` samples. */
function movingAverage(a, w) {
  const n = a.length;
  const out = new Float64Array(n);
  const half = Math.max(0, Math.floor(w / 2));
  let s = 0;
  let lo = 0;
  let hi = -1;
  for (let i = 0; i < n; i++) {
    const want0 = Math.max(0, i - half);
    const want1 = Math.min(n - 1, i + half);
    while (hi < want1) s += a[++hi];
    while (lo < want0) s -= a[lo++];
    out[i] = s / (hi - lo + 1);
  }
  return out;
}
function movingMedian(a, w) {
  const n = a.length;
  const out = new Float64Array(n);
  const half = Math.floor(w / 2);
  // stride of 4 then hold: medians change slowly and this keeps it fast
  for (let i = 0; i < n; i += 4) {
    const s = Array.prototype.slice.call(a, Math.max(0, i - half), Math.min(n, i + half + 1)).sort((x, y) => x - y);
    const m = s[s.length >> 1];
    for (let j = i; j < Math.min(n, i + 4); j++) out[j] = m;
  }
  return out;
}
/** Local maxima at least `sep` samples apart, highest first. */
function peaks(a, sep, minValue = -Infinity) {
  const idx = [];
  for (let i = 1; i < a.length - 1; i++) if (a[i] >= a[i - 1] && a[i] > a[i + 1] && a[i] >= minValue) idx.push(i);
  idx.sort((x, y) => a[y] - a[x]);
  const kept = [];
  for (const i of idx) if (kept.every((k) => Math.abs(k - i) >= sep)) kept.push(i);
  return kept;
}

// ------------------------------------------------------------------ decoding

function decode(file) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(CONFIG.SR), '-f', 'f32le', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let err = '';
    ff.stdout.on('data', (c) => chunks.push(c));
    ff.stderr.on('data', (c) => (err += c));
    ff.on('error', (e) => reject(new Error(`could not run ffmpeg (${e.message}); install it and make sure it is on the PATH`)));
    ff.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg failed on ${file}: ${err}`));
      const buf = Buffer.concat(chunks);
      resolve(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength >> 2));
    });
  });
}

// ----------------------------------------------------------------------- FFT

/** Magnitude spectrum of a Hann-windowed frame centred on sample `centre`; amplitude-calibrated. */
function makeSpectrum(n) {
  const bits = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = -Math.sin((2 * Math.PI * i) / n);
  }
  const win = Float64Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const mag = new Float32Array(n / 2 + 1);
  return (x, centre) => {
    const start = centre - n / 2;
    for (let i = 0; i < n; i++) {
      const j = start + i;
      re[rev[i]] = j >= 0 && j < x.length ? x[j] * win[i] : 0;
      im[rev[i]] = 0;
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0; j < half; j++) {
          const k = j * step;
          const a = i + j;
          const b = a + half;
          const tr = cos[k] * re[b] - sin[k] * im[b];
          const ti = cos[k] * im[b] + sin[k] * re[b];
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
    const scale = 4 / n; // a full-scale sine reads ~1
    for (let k = 0; k <= n / 2; k++) mag[k] = Math.hypot(re[k], im[k]) * scale;
    return mag;
  };
}

function aWeight(f) {
  const f2 = f * f;
  const ra = (12194 ** 2 * f2 * f2) / ((f2 + 20.6 ** 2) * Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12194 ** 2));
  return ra * 10 ** (2 / 20);
}

// ---------------------------------------------------------- frame features

function frameFeatures(x) {
  const { SR, N, N_LONG, HOP, BANDS, ONSET, CHROMA } = CONFIG;
  const frames = Math.ceil(x.length / HOP);
  const spec = makeSpectrum(N);
  const specLong = makeSpectrum(N_LONG);
  const hz = SR / N;
  const hzLong = SR / N_LONG;
  const bins = N / 2 + 1;
  const binsLong = N_LONG / 2 + 1;
  const toBin = (f) => Math.max(1, Math.min(bins - 1, Math.round(f / hz)));

  const aw = Float64Array.from({ length: bins }, (_, k) => aWeight(Math.max(k, 1) * hz) ** 2);
  const bandBins = Object.fromEntries(Object.entries(BANDS).map(([k, [lo, hi]]) => [k, [toBin(lo), toBin(hi)]]));
  const [f0, f1] = [toBin(ONSET.FMIN), toBin(ONSET.FMAX)];
  const [c0, c1] = [toBin(50), toBin(10000)];
  const [l0, l1] = VOICES.LOW.FLUX_HZ.map(toBin);
  const [h0, h1] = VOICES.MELODY.FLUX_HZ.map(toBin);

  // chroma folding on the long spectrum
  const chromaMap = [];
  for (let k = Math.ceil(CHROMA.FMIN / hzLong); k <= Math.floor(CHROMA.FMAX / hzLong); k++) {
    const midi = 69 + 12 * Math.log2((k * hzLong) / 440);
    const nearest = Math.round(midi);
    const w = Math.cos(Math.PI * (midi - nearest)) ** 2;
    if (w > 0.05) chromaMap.push([k, ((nearest % 12) + 12) % 12, w]);
  }

  const power = new Float64Array(frames);
  const weighted = new Float64Array(frames);
  const band = Object.fromEntries(Object.keys(BANDS).map((k) => [k, new Float64Array(frames)]));
  const centroid = new Float64Array(frames);
  const flux = new Float64Array(frames);
  const fluxLow = new Float64Array(frames); // the low register (voices.low attacks)
  const fluxHigh = new Float64Array(frames); // the melody register (voices.melody attacks)
  const chroma = Array.from({ length: frames }, () => new Float32Array(12));
  const longMags = new Array(frames); // compressed long spectra for the melody (kept only up to ~5 kHz)
  const longKeep = Math.min(binsLong, Math.ceil(5200 / hzLong));
  let prevLog = new Float32Array(bins);
  let curLog = new Float32Array(bins);

  for (let i = 0; i < frames; i++) {
    const centre = i * HOP;
    // time-domain power of the frame (calibrated loudness), A-weighting from the spectrum ratio
    let sq = 0;
    for (let j = Math.max(0, centre - N / 2); j < Math.min(x.length, centre + N / 2); j++) sq += x[j] * x[j];
    power[i] = sq / N;
    const m = spec(x, centre);
    let pw = 0;
    let pa = 0;
    let num = 0;
    let den = 0;
    for (let k = 1; k < bins; k++) {
      const p = m[k] * m[k];
      pw += p;
      pa += p * aw[k];
      if (k >= c0 && k <= c1) {
        num += k * hz * m[k];
        den += m[k];
      }
      curLog[k] = Math.log1p(1000 * m[k]);
    }
    weighted[i] = pw > 0 ? power[i] * (pa / pw) : 0;
    centroid[i] = den > 1e-9 ? num / den : 0;
    for (const [name, [lo, hi]] of Object.entries(bandBins)) {
      let s = 0;
      for (let k = lo; k < hi; k++) s += m[k] * m[k];
      band[name][i] = s;
    }
    // SuperFlux-style: compare against the max of the neighbouring previous bins (ignores vibrato)
    const bandFlux = (lo, hi) => {
      let fl = 0;
      for (let k = lo; k < hi; k++) {
        const d = curLog[k] - Math.max(prevLog[k - 1], prevLog[k], prevLog[k + 1]);
        if (d > 0) fl += d;
      }
      return i === 0 ? 0 : fl / (hi - lo);
    };
    flux[i] = bandFlux(f0, f1);
    fluxLow[i] = bandFlux(l0, l1);
    fluxHigh[i] = bandFlux(h0, h1);
    [prevLog, curLog] = [curLog, prevLog];

    const ml = specLong(x, centre);
    const c = chroma[i];
    for (const [k, pc, w] of chromaMap) c[pc] += w * Math.log1p(100 * ml[k]);
    const comp = new Float32Array(longKeep);
    for (let k = 0; k < longKeep; k++) comp[k] = Math.log1p(100 * ml[k]);
    longMags[i] = comp;
  }
  return { frames, power, weighted, band, centroid, flux, fluxLow, fluxHigh, chroma, longMags, hzLong };
}

// ------------------------------------------------------------------ loudness

function loudnessCurves(f) {
  const fps = CONFIG.SR / CONFIG.HOP;
  const toDb = (p) => 10 * Math.log10(p + 1e-12);
  const shortP = movingAverage(f.weighted, Math.round(CONFIG.LOUDNESS_WINDOW * fps));
  const db = Float64Array.from(shortP, toDb);
  const slowDb = Float64Array.from(movingAverage(shortP, Math.round(CONFIG.SLOW_WINDOW * fps)), toDb);
  const audible = [...db].filter((v) => v > CONFIG.SILENCE_DB);
  const pct = {};
  for (const p of [2, 5, 10, 25, 50, 75, 90, 95, 98, 99]) pct[`p${p}`] = round(percentile(audible, p), 1);
  pct.max = round(Math.max(...audible), 1);
  // p5 -> 0, p99 -> 1: only the very loudest moments reach the top
  const lo = pct.p5;
  const hi = pct.p99;
  const level = Float64Array.from(db, (v) => clamp01((v - lo) / (hi - lo)));
  const slowLevel = Float64Array.from(slowDb, (v) => clamp01((v - lo) / (hi - lo)));
  return { db, slowDb, level, slowLevel, percentiles: pct, range: [lo, hi] };
}

function normaliseBands(f) {
  const out = {};
  for (const [name, e] of Object.entries(f.band)) {
    const db = Float64Array.from(movingAverage(e, 3), (v) => 10 * Math.log10(v + 1e-12));
    const lo = percentile(db, 10);
    const hi = percentile(db, 99);
    out[name] = Float64Array.from(db, (v) => clamp01((v - lo) / (hi - lo)));
  }
  return out;
}

// -------------------------------------------------------------------- onsets

function detectOnsets(flux, levelDb, O = CONFIG.ONSET) {
  const fps = CONFIG.SR / CONFIG.HOP;
  const env = flux;
  const med = movingMedian(env, Math.round(O.MEDIAN * fps * 2));
  const scale = percentile(env, 95);
  const top = percentile(env, 99.5);
  const w = Math.max(1, Math.round(O.PEAK * fps));
  const times = [];
  const strength = [];
  let last = -Infinity;
  for (let i = w; i < env.length - w; i++) {
    const thr = med[i] + O.DELTA * scale;
    if (env[i] < thr || levelDb[i] < CONFIG.SILENCE_DB + 10) continue;
    let isMax = true;
    for (let j = i - w; j <= i + w; j++) if (env[j] > env[i]) isMax = false;
    if (!isMax) continue;
    const t = i / fps;
    if (t - last < O.MIN_GAP) continue;
    last = t;
    times.push(round(t, 3));
    strength.push(round(clamp01((env[i] - med[i]) / Math.max(1e-9, top - percentile(env, 50))), 3));
  }
  return { times, strength };
}

// --------------------------------------------------------------- tempo/beats

/** `hint` (bpm, from pieces.js) narrows the tempo prior around the known beat level. */
function tempoAndBeats(flux, hint) {
  const fps = CONFIG.SR / CONFIG.HOP;
  const T = hint ? { ...CONFIG.TEMPO, PRIOR_BPM: hint, PRIOR_OCTAVES: 0.3 } : CONFIG.TEMPO;
  const n = flux.length;
  const localMean = movingAverage(flux, Math.round(fps));
  const env = Float64Array.from(flux, (v, i) => Math.max(0, v - localMean[i]));
  const sd = Math.sqrt(mean(Float64Array.from(env, (v) => v * v))) || 1;
  for (let i = 0; i < n; i++) env[i] /= sd;

  const minLag = Math.floor((60 / T.MAX_BPM) * fps);
  const maxLag = Math.ceil((60 / T.MIN_BPM) * fps);
  let zero = 0;
  for (let i = 0; i < n; i++) zero += env[i] * env[i];
  let best = minLag;
  let bestScore = -Infinity;
  const acf = new Float64Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = lag; i < n; i++) s += env[i] * env[i - lag];
    acf[lag] = s / zero;
    const bpm = (60 * fps) / lag;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / T.PRIOR_BPM) / T.PRIOR_OCTAVES) ** 2);
    if (acf[lag] * prior > bestScore) {
      bestScore = acf[lag] * prior;
      best = lag;
    }
  }
  // refine the lag with a parabola
  const a = acf[best - 1] ?? acf[best];
  const b = acf[best];
  const c = acf[best + 1] ?? acf[best];
  const off = a - 2 * b + c !== 0 ? (0.5 * (a - c)) / (a - 2 * b + c) : 0;
  const period = best + Math.max(-0.5, Math.min(0.5, off));
  const bpm = (60 * fps) / period;
  const confidence = clamp01(b / 0.35); // a strongly periodic envelope reaches ~0.35+

  // Ellis (2007) dynamic programming beat tracker
  const sigma = period / 32;
  const gw = Math.ceil(sigma * 3);
  const local = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = -gw; j <= gw; j++) if (i + j >= 0 && i + j < n) s += env[i + j] * Math.exp(-0.5 * (j / sigma) ** 2);
    local[i] = s;
  }
  const score = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  const lo = Math.round(period / 2);
  const hi = Math.round(period * 2);
  for (let i = 0; i < n; i++) {
    let bestPrev = 0;
    let arg = -1;
    for (let j = i - hi; j <= i - lo; j++) {
      if (j < 0) continue;
      const v = score[j] - T.TIGHTNESS * Math.log((i - j) / period) ** 2;
      if (arg < 0 || v > bestPrev) {
        bestPrev = v;
        arg = j;
      }
    }
    score[i] = local[i] + (arg >= 0 ? Math.max(0, bestPrev) : 0);
    back[i] = arg >= 0 && bestPrev > 0 ? arg : -1;
  }
  let end = n - 1;
  const tailStart = Math.max(0, n - Math.round(period * 2));
  for (let i = tailStart; i < n; i++) if (score[i] > score[end]) end = i;
  const beats = [];
  for (let i = end; i >= 0; i = back[i]) {
    beats.push(round(i / fps, 3));
    if (back[i] < 0) break;
  }
  beats.reverse();
  return { tempo: { bpm: round(bpm, 1), confidence: round(confidence, 2) }, beats };
}

// --------------------------------------------------------------------- chroma

function chromaFrames(f, power) {
  const C = CONFIG.CHROMA;
  const fps = CONFIG.SR / CONFIG.HOP;
  const smoothN = Math.max(1, Math.round(C.SMOOTH * fps));
  const out = [];
  for (let i = 0; i < f.frames; i += C.DECIMATE) {
    const acc = new Float64Array(12);
    for (let j = Math.max(0, i - smoothN); j <= Math.min(f.frames - 1, i + smoothN); j++) for (let k = 0; k < 12; k++) acc[k] += f.chroma[j][k];
    const max = Math.max(...acc);
    const quiet = 10 * Math.log10(power[i] + 1e-12) < CONFIG.SILENCE_DB;
    out.push(Array.from(acc, (v) => (max > 0 && !quiet ? round(v / max, 2) : 0)));
  }
  return out;
}

// ------------------------------------------------------------------------ key

const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
function correlate(a, b) {
  const ma = mean(a);
  const mb = mean(b);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < 12; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}
const keyName = (k) => `${NOTE_NAMES[k % 12]} ${k < 12 ? 'major' : 'minor'}`;

function estimateKeys(f, power, duration) {
  const K = CONFIG.KEY;
  const fps = CONFIG.SR / CONFIG.HOP;
  const windows = [];
  for (let t = 0; t < duration; t += K.HOP) {
    const t0 = Math.max(0, t - K.WINDOW / 2);
    const t1 = Math.min(duration, t + K.WINDOW / 2);
    const acc = new Float64Array(12);
    let total = 0;
    for (let i = Math.floor(t0 * fps); i < Math.min(f.frames, Math.ceil(t1 * fps)); i++) {
      const w = Math.sqrt(power[i]); // loud frames count more, silence not at all
      total += w;
      for (let k = 0; k < 12; k++) acc[k] += f.chroma[i][k] * w;
    }
    const scores = new Float64Array(24);
    for (let k = 0; k < 24; k++) {
      const prof = k < 12 ? KK_MAJOR : KK_MINOR;
      const rot = Array.from({ length: 12 }, (_, i) => prof[(i - (k % 12) + 12) % 12]);
      scores[k] = total > 0 ? correlate(acc, rot) : 0;
    }
    windows.push({ t: round(t, 1), t0, t1, scores, chroma: acc });
  }
  // Viterbi: staying in a key is free, switching costs SWITCH_PENALTY
  const n = windows.length;
  const dp = windows.map(() => new Float64Array(24));
  const bp = windows.map(() => new Int8Array(24));
  for (let k = 0; k < 24; k++) dp[0][k] = windows[0].scores[k];
  for (let i = 1; i < n; i++) {
    let bestK = 0;
    for (let k = 1; k < 24; k++) if (dp[i - 1][k] > dp[i - 1][bestK]) bestK = k;
    for (let k = 0; k < 24; k++) {
      const stay = dp[i - 1][k];
      const move = dp[i - 1][bestK] - K.SWITCH_PENALTY;
      dp[i][k] = windows[i].scores[k] + Math.max(stay, move);
      bp[i][k] = stay >= move ? k : bestK;
    }
  }
  const path = new Array(n);
  path[n - 1] = dp[n - 1].indexOf(Math.max(...dp[n - 1]));
  for (let i = n - 1; i > 0; i--) path[i - 1] = bp[i][path[i]];

  const out = windows.map((w, i) => ({
    t: w.t,
    key: keyName(path[i]),
    tonic: path[i] % 12,
    mode: path[i] < 12 ? 'major' : 'minor',
    confidence: round(w.scores[path[i]], 2),
  }));
  // regions: merge, then absorb regions shorter than MIN_REGION into their neighbour
  let regions = [];
  for (let i = 0; i < n; i++) {
    const start = i === 0 ? 0 : (windows[i - 1].t + windows[i].t) / 2;
    const end = i === n - 1 ? duration : (windows[i].t + windows[i + 1].t) / 2;
    const last = regions[regions.length - 1];
    if (last && last.k === path[i]) last.end = end;
    else regions.push({ k: path[i], start, end });
  }
  let changed = true;
  while (changed && regions.length > 1) {
    changed = false;
    const i = regions.findIndex((r) => r.end - r.start < K.MIN_REGION);
    if (i >= 0) {
      const into = i === 0 ? 1 : i === regions.length - 1 ? i - 1 : regions[i - 1].end - regions[i - 1].start >= regions[i + 1].end - regions[i + 1].start ? i - 1 : i + 1;
      regions[into].start = Math.min(regions[into].start, regions[i].start);
      regions[into].end = Math.max(regions[into].end, regions[i].end);
      regions.splice(i, 1);
      // merge equal neighbours
      regions = regions.reduce((acc, r) => {
        const l = acc[acc.length - 1];
        if (l && l.k === r.k) l.end = r.end;
        else acc.push(r);
        return acc;
      }, []);
      changed = true;
    }
  }
  return {
    windows: out,
    regions: regions.map((r) => ({ start: round(r.start, 1), end: round(r.end, 1), key: keyName(r.k), tonic: r.k % 12, mode: r.k < 12 ? 'major' : 'minor' })),
  };
}

// --------------------------------------------------------------------- melody

function melody(f, levelDb, opts = {}) {
  const M = { ...CONFIG.MELODY, ...opts };
  const hzLong = f.hzLong;
  const steps = Math.floor(12 * M.STEPS_PER_SEMITONE * Math.log2(M.FMAX / M.FMIN)) + 1;
  const cand = Float64Array.from({ length: steps }, (_, i) => M.FMIN * 2 ** (i / (12 * M.STEPS_PER_SEMITONE)));
  // bin range per candidate and harmonic (+-0.5 semitone)
  const ranges = [];
  for (let c = 0; c < steps; c++) {
    const r = [];
    for (let h = 1; h <= M.HARMONICS; h++) {
      const fh = cand[c] * h;
      const lo = Math.floor((fh * 2 ** (-0.5 / 12)) / hzLong);
      const hi = Math.ceil((fh * 2 ** (0.5 / 12)) / hzLong);
      if (hi < f.longMags[0].length) r.push([lo, hi, M.DECAY ** (h - 1)]);
    }
    ranges.push(r);
  }
  const n = f.frames;
  const sal = new Float32Array(n * steps);
  const conf = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const m = f.longMags[i];
    let total = 0;
    let best = 0;
    for (let c = 0; c < steps; c++) {
      let s = 0;
      for (const [lo, hi, w] of ranges[c]) {
        let mx = 0;
        for (let k = lo; k <= hi; k++) if (m[k] > mx) mx = m[k];
        s += w * mx;
      }
      // the fundamental itself must be present, or the harmonic sum favours sub-octaves
      const [flo, fhi] = ranges[c][0];
      let fund = 0;
      for (let k = flo; k <= fhi; k++) if (m[k] > fund) fund = m[k];
      s *= Math.sqrt(fund / (s / ranges[c].length + 1e-9));
      sal[i * steps + c] = s;
      total += s;
      if (s > best) best = s;
    }
    const ratio = total > 0 ? best / (total / steps) : 0;
    conf[i] = levelDb[i] < CONFIG.SILENCE_DB + 15 ? 0 : clamp01((ratio - M.CONFIDENCE[0]) / (M.CONFIDENCE[1] - M.CONFIDENCE[0]));
  }
  // Viterbi over candidates: log salience + top-voice bias - jump cost
  const jump = M.JUMP_COST / (12 * M.STEPS_PER_SEMITONE);
  const prev = new Float64Array(steps);
  const cur = new Float64Array(steps);
  const back = new Int16Array(n * steps);
  for (let i = 0; i < n; i++) {
    let max = 0;
    for (let c = 0; c < steps; c++) max = Math.max(max, sal[i * steps + c]);
    for (let c = 0; c < steps; c++) cur[c] = Math.log((sal[i * steps + c] + 1e-6) / (max + 1e-6)) + M.TOP_VOICE * (c / steps);
    if (i > 0) {
      // best predecessor max_j prev[j] - jump * |c - j|, in O(steps) with a forward and a backward pass
      const bestVal = new Float64Array(steps);
      const bestArg = new Int16Array(steps);
      for (let c = 0; c < steps; c++) {
        bestVal[c] = prev[c];
        bestArg[c] = c;
        if (c > 0 && bestVal[c - 1] - jump > bestVal[c]) {
          bestVal[c] = bestVal[c - 1] - jump;
          bestArg[c] = bestArg[c - 1];
        }
      }
      for (let c = steps - 2; c >= 0; c--) {
        if (bestVal[c + 1] - jump > bestVal[c]) {
          bestVal[c] = bestVal[c + 1] - jump;
          bestArg[c] = bestArg[c + 1];
        }
      }
      for (let c = 0; c < steps; c++) {
        cur[c] += bestVal[c];
        back[i * steps + c] = bestArg[c];
      }
    }
    prev.set(cur);
  }
  const path = new Int16Array(n);
  let arg = 0;
  for (let c = 1; c < steps; c++) if (prev[c] > prev[arg]) arg = c;
  for (let i = n - 1; i >= 0; i--) {
    path[i] = arg;
    if (i > 0) arg = back[i * steps + arg];
  }
  const hzOut = Float64Array.from(path, (c, i) => (conf[i] > 0.05 ? cand[c] : 0));
  const confident = [];
  for (let i = 0; i < n; i++) if (conf[i] > 0.3 && hzOut[i] > 0) confident.push(Math.log2(hzOut[i]));
  const lo = 2 ** percentile(confident, 3);
  const hi = 2 ** percentile(confident, 97);
  const height = Float64Array.from(hzOut, (h) => (h > 0 ? clamp01(Math.log2(h / lo) / Math.log2(hi / lo)) : 0));
  return { hz: hzOut, height, confidence: conf, range: [round(lo, 1), round(hi, 1)] };
}

// --------------------------------------------------------------------- voices

const NOTE_OF = (hz) => (((Math.round(12 * Math.log2(hz / 440)) + 9) % 12) + 12) % 12;

/** Merge two sorted onset lists, keeping the stronger of any two closer than `gap` s. */
function mergeOnsets(a, b, gap) {
  const all = [...a, ...b].sort((x, y) => x.t - y.t);
  const out = [];
  for (const o of all) {
    const last = out[out.length - 1];
    if (last && o.t - last.t < gap) {
      if (o.strength > last.strength) last.strength = o.strength;
    } else out.push({ ...o });
  }
  return out;
}

/**
 * The low voice (VOICES.LOW): pitch of the strongest low note (harmonic sum
 * over the register, the fundamental required), a smoothed low-register
 * chroma and its dominant pitch class, and onsets = low-register flux peaks
 * plus chord changes (the low chroma turning) without a fresh bass attack.
 */
function lowVoice(f, loud) {
  const V = VOICES.LOW;
  const fps = CONFIG.SR / CONFIG.HOP;
  const hzLong = f.hzLong;
  const [lo, hi] = V.REGISTER_HZ;
  const keep = f.longMags[0].length;
  const m0 = Math.ceil(12 * Math.log2(lo / 440));
  const m1 = Math.floor(12 * Math.log2(hi / 440));
  const cands = [];
  for (let m = m0; m <= m1; m++) {
    const hz = 440 * 2 ** (m / 12);
    const ranges = [];
    for (let h = 1; h <= V.HARMONICS; h++) {
      const a = Math.floor((hz * h * 2 ** (-0.5 / 12)) / hzLong);
      const b = Math.ceil((hz * h * 2 ** (0.5 / 12)) / hzLong);
      if (b < keep) ranges.push([a, b, 0.8 ** (h - 1)]);
    }
    cands.push({ hz, pc: NOTE_OF(hz), ranges });
  }
  const n = f.frames;
  const hzOut = new Float64Array(n);
  const conf = new Float64Array(n);
  const chroma = Array.from({ length: n }, () => new Float64Array(12));
  const kLo = Math.ceil(lo / hzLong);
  const kHi = Math.floor(hi / hzLong);
  for (let i = 0; i < n; i++) {
    const m = f.longMags[i];
    let best = -1;
    let bestS = 0;
    let total = 0;
    for (let c = 0; c < cands.length; c++) {
      let s = 0;
      for (const [a, b, w] of cands[c].ranges) {
        let mx = 0;
        for (let k = a; k <= b; k++) if (m[k] > mx) mx = m[k];
        s += w * mx;
      }
      const [fa, fb] = cands[c].ranges[0];
      let fund = 0;
      for (let k = fa; k <= fb; k++) if (m[k] > fund) fund = m[k];
      s *= Math.sqrt(fund / (s / cands[c].ranges.length + 1e-9));
      total += s;
      if (s > bestS) {
        bestS = s;
        best = c;
      }
    }
    const ratio = total > 0 ? bestS / (total / cands.length) : 0;
    conf[i] = loud.level[i] < V.MIN_LEVEL ? 0 : clamp01((ratio - V.CONFIDENCE[0]) / (V.CONFIDENCE[1] - V.CONFIDENCE[0]));
    hzOut[i] = conf[i] > 0.05 && best >= 0 ? cands[best].hz : 0;
    for (let k = kLo; k <= kHi; k++) {
      const midi = 69 + 12 * Math.log2((k * hzLong) / 440);
      const near = Math.round(midi);
      const w = Math.cos(Math.PI * (midi - near)) ** 2;
      if (w > 0.05) chroma[i][((near % 12) + 12) % 12] += w * m[k];
    }
  }
  // smoothed chroma (normalised to max 1) and its dominant class
  const sw = Math.max(1, Math.round(V.CHROMA_SMOOTH * fps));
  const smooth = Array.from({ length: n }, () => new Float64Array(12));
  for (let k = 0; k < 12; k++) {
    const col = movingAverage(Float64Array.from(chroma, (c) => c[k]), sw);
    for (let i = 0; i < n; i++) smooth[i][k] = col[i];
  }
  const note = new Int8Array(n);
  for (let i = 0; i < n; i++) {
    const c = smooth[i];
    let mx = 0;
    let arg = -1;
    for (let k = 0; k < 12; k++) if (c[k] > mx) [mx, arg] = [c[k], k];
    if (mx > 0) for (let k = 0; k < 12; k++) c[k] /= mx;
    note[i] = loud.level[i] < V.MIN_LEVEL ? -1 : arg;
  }
  const height = movingMedian(
    Float64Array.from(hzOut, (h) => (h > 0 ? clamp01(Math.log2(h / lo) / Math.log2(hi / lo)) : 0)),
    5,
  );

  // onsets: flux peaks in the low register ...
  const flux = detectOnsets(f.fluxLow, loud.db, V.ONSET);
  const attacks = flux.times.map((t, j) => ({ t, strength: flux.strength[j] }));
  // ... and chord changes: the low chroma 0.3 s before against 0.3 s after
  const span = Math.round(0.3 * fps);
  const dist = new Float64Array(n);
  for (let i = span; i < n - span; i++) {
    const a = new Float64Array(12);
    const b = new Float64Array(12);
    for (let j = 0; j < span; j++)
      for (let k = 0; k < 12; k++) {
        a[k] += chroma[i - 1 - j][k];
        b[k] += chroma[i + j][k];
      }
    let ab = 0;
    let aa = 0;
    let bb = 0;
    for (let k = 0; k < 12; k++) [ab, aa, bb] = [ab + a[k] * b[k], aa + a[k] * a[k], bb + b[k] * b[k]];
    dist[i] = aa > 0 && bb > 0 ? 1 - ab / Math.sqrt(aa * bb) : 0;
  }
  const changes = [];
  const w = Math.round(0.15 * fps);
  for (let i = w; i < n - w; i++) {
    if (dist[i] < V.CHORD_CHANGE || loud.level[i] < V.MIN_LEVEL) continue;
    let isMax = true;
    for (let j = i - w; j <= i + w; j++) if (dist[j] > dist[i]) isMax = false;
    if (isMax) changes.push({ t: round(i / fps, 3), strength: round(clamp01(dist[i] * 1.5), 3) });
  }
  const notes = mergeOnsets(attacks, changes, V.ONSET.MIN_GAP).filter((o) => loud.level[Math.round(o.t * fps)] >= V.MIN_LEVEL);
  const at = (arr, t) => arr[Math.min(arr.length - 1, Math.max(0, Math.round(t * fps)))];
  return {
    range: [lo, hi],
    hz: hzOut,
    height,
    confidence: conf,
    note,
    chroma: smooth,
    notes: {
      times: notes.map((o) => o.t),
      strength: notes.map((o) => round(o.strength, 3)),
      height: notes.map((o) => round(at(height, o.t + 0.06), 3)),
      pc: notes.map((o) => at(note, o.t + 0.1)),
    },
    stats: { attacks: attacks.length, changes: changes.length },
  };
}

/**
 * The melody voice (VOICES.MELODY): the predominant pitch over its own
 * register, and notes = a pitch step of at least STEP semitones that holds
 * HOLD s, or an upper-register attack while voiced.
 */
function melodyVoice(f, loud) {
  const V = VOICES.MELODY;
  const fps = CONFIG.SR / CONFIG.HOP;
  const mel = melody(f, loud.db, { FMIN: V.REGISTER_HZ[0], FMAX: V.REGISTER_HZ[1] });
  const n = f.frames;
  const attack = new Uint8Array(n);
  const at = detectOnsets(f.fluxHigh, loud.db, V.ATTACK);
  for (const t of at.times) attack[Math.round(t * fps)] = 1;
  const top = percentile(f.fluxHigh, 99.5);
  const mid = percentile(f.fluxHigh, 50);
  const hold = Math.max(1, Math.round(V.HOLD * fps));
  const voiced = (i) => mel.confidence[i] >= V.MIN_CONF && mel.hz[i] > 0;
  const semi = (i) => 12 * Math.log2(mel.hz[i] / 440);
  const times = [];
  let cur = NaN;
  let pending = -1;
  let last = -Infinity;
  const push = (i) => {
    const t = i / fps;
    if (t - last < V.MIN_GAP) return;
    last = t;
    times.push(i);
  };
  for (let i = 0; i < n; i++) {
    if (!voiced(i)) {
      pending = -1;
      if (loud.level[i] < 0.05) cur = NaN;
      continue;
    }
    const s = semi(i);
    if (!(Math.abs(s - cur) < V.STEP)) {
      // a new pitch: it must hold before it counts (backdated to where it started)
      if (pending < 0 || Math.abs(s - semi(pending)) >= 0.5) pending = i;
      else if (i - pending + 1 >= hold) {
        cur = semi(pending);
        push(pending);
        pending = -1;
      }
    } else {
      pending = -1;
      // the same pitch struck again: only a clear attack (repeated accompaniment chords stay out)
      if (attack[i] && (f.fluxHigh[i] - mid) / Math.max(1e-9, top - mid) >= V.REATTACK) push(i);
    }
  }
  const notes = times.map((i) => {
    let fl = 0;
    for (let j = Math.max(0, i - 1); j <= Math.min(n - 1, i + 2); j++) fl = Math.max(fl, f.fluxHigh[j]);
    const strength = clamp01(0.3 * loud.level[i] + 0.7 * clamp01((fl - mid) / Math.max(1e-9, top - mid)));
    const j = Math.min(n - 1, i + 2);
    return { t: round(i / fps, 3), strength: round(strength, 3), height: round(mel.height[j], 3), pc: mel.hz[j] > 0 ? NOTE_OF(mel.hz[j]) : -1 };
  });
  return {
    ...mel,
    notes: {
      times: notes.map((o) => o.t),
      strength: notes.map((o) => o.strength),
      height: notes.map((o) => o.height),
      pc: notes.map((o) => o.pc),
    },
    stats: { attacks: at.times.length },
  };
}

// ------------------------------------------------------------------- sections

function segment(f, loud, bands, duration, manual) {
  const S = CONFIG.SECTIONS;
  const fps = CONFIG.SR / CONFIG.HOP;
  const per = Math.max(1, Math.round(S.BLOCK * fps));
  const nb = Math.floor(f.frames / per);
  // block features: loudness, chroma, timbre
  const feats = [];
  for (let b = 0; b < nb; b++) {
    const i0 = b * per;
    const i1 = i0 + per;
    const ch = new Float64Array(12);
    for (let i = i0; i < i1; i++) for (let k = 0; k < 12; k++) ch[k] += f.chroma[i][k];
    const cs = ch.reduce((s, v) => s + v, 0) || 1;
    const cent = mean(f.centroid, i0, i1);
    feats.push([mean(loud.slowLevel, i0, i1) * 2.5, ...Array.from(ch, (v) => (v / cs) * 3), mean(bands.bass, i0, i1), mean(bands.mid, i0, i1), mean(bands.treble, i0, i1), Math.log2(Math.max(cent, 50) / 50) / 4]);
  }
  const dims = feats[0].length;
  // z-score each dimension (keeping the weights above as relative emphasis)
  for (let d = 0; d < dims; d++) {
    const col = feats.map((v) => v[d]);
    const m = mean(col);
    const sd = Math.sqrt(mean(col.map((v) => (v - m) ** 2))) || 1;
    const w = d === 0 ? 2.5 : d <= 12 ? 0.6 : 1;
    for (const v of feats) v[d] = ((v[d] - m) / sd) * w;
  }
  const dist = (a, b) => {
    let s = 0;
    for (let d = 0; d < dims; d++) s += (a[d] - b[d]) ** 2;
    return Math.sqrt(s);
  };

  let boundaries;
  if (manual?.boundaries?.length) {
    boundaries = [...manual.boundaries].filter((t) => t > 0 && t < duration).sort((a, b) => a - b);
  } else {
    // Foote novelty: checkerboard kernel over the self-similarity (negative distance)
    const W = Math.round(S.KERNEL / S.BLOCK);
    const novelty = new Float64Array(nb);
    for (let i = W; i < nb - W; i++) {
      let s = 0;
      for (let a = -W; a < W; a++) {
        for (let b = -W; b < W; b++) {
          const sign = (a < 0) === (b < 0) ? 1 : -1;
          const g = Math.exp(-0.5 * ((a + 0.5) ** 2 + (b + 0.5) ** 2) / (W / 2) ** 2);
          s -= sign * g * dist(feats[i + a], feats[i + b]);
        }
      }
      novelty[i] = Math.max(0, s);
    }
    // loudness-change novelty: terraced dynamics are boundaries even when the harmony continues
    const L = Math.round(S.LOUDNESS_SPAN / S.BLOCK);
    const ln = new Float64Array(nb);
    for (let i = L; i < nb - L; i++) {
      let before = 0;
      let after = 0;
      for (let j = 1; j <= L; j++) {
        before += feats[i - j][0];
        after += feats[i + j - 1][0];
      }
      ln[i] = Math.abs(after - before) / L;
    }
    const nmax = Math.max(...novelty) || 1;
    const lmax = Math.max(...ln) || 1;
    const combined = Float64Array.from(novelty, (v, i) => 0.6 * (v / nmax) + 0.4 * (ln[i] / lmax));
    const smooth = movingAverage(combined, 3);
    const minSep = Math.round(S.MIN_LEN / S.BLOCK);
    const want = Math.max(3, Math.round(duration / S.TARGET_LEN)) - 1;
    const cmax = Math.max(...smooth);
    const cand = peaks(smooth, minSep, S.MIN_PEAK * cmax).filter((b) => b * S.BLOCK > S.MIN_LEN * 0.6 && b * S.BLOCK < duration - S.MIN_LEN * 0.6);
    let chosen = cand.slice(0, want);
    // no section longer than MAX_LEN: split it at its strongest inner change
    for (let guard = 0; guard < 50; guard++) {
      const edges = [0, ...chosen.sort((a, b) => a - b), nb];
      let split = -1;
      for (let k = 0; k < edges.length - 1 && split < 0; k++) {
        if ((edges[k + 1] - edges[k]) * S.BLOCK <= S.MAX_LEN) continue;
        let best = -1;
        for (let b = edges[k] + minSep; b < edges[k + 1] - minSep; b++) if (best < 0 || smooth[b] > smooth[best]) best = b;
        if (best >= 0) split = best;
      }
      if (split < 0) break;
      chosen.push(split);
    }
    boundaries = chosen.map((b) => b * S.BLOCK).sort((a, b) => a - b);
    // the final fade is its own section: it starts after the last moment the music is still well up
    let i = loud.slowLevel.length - 1;
    while (i > 0 && loud.slowLevel[i] < S.FADE_LEVEL) i--;
    const fadeStart = i / fps;
    if (duration - fadeStart >= S.FADE_MIN_LEN) {
      boundaries = [...boundaries.filter((b) => b < fadeStart - S.MIN_LEN / 2), fadeStart];
    }
  }

  // describe and label each section
  const starts = [0, ...boundaries];
  const ends = [...boundaries, duration];
  const lvl = loud.slowLevel;
  const sustain = movingAverage(loud.level, Math.round(2 * fps));
  let globalPeak = 0;
  for (let i = 0; i < sustain.length; i++) globalPeak = Math.max(globalPeak, sustain[i]);
  const sections = starts.map((start, s) => {
    const end = ends[s];
    const i0 = Math.floor(start * fps);
    const i1 = Math.min(f.frames, Math.ceil(end * fps));
    const edge = Math.max(1, Math.min(Math.round(3 * fps), Math.floor((i1 - i0) / 4)));
    let peak = 0;
    let peakAt = i0;
    for (let i = i0; i < i1; i++) if (sustain[i] > peak) [peak, peakAt] = [sustain[i], i];
    // block features for letter clustering
    const b0 = Math.floor(start / S.BLOCK);
    const b1 = Math.max(b0 + 1, Math.min(nb, Math.floor(end / S.BLOCK)));
    const centroidFeat = new Array(dims).fill(0);
    for (let b = b0; b < b1; b++) for (let d = 0; d < dims; d++) centroidFeat[d] += feats[b][d] / (b1 - b0);
    return {
      start,
      end,
      level: mean(lvl, i0, i1),
      startLevel: mean(lvl, i0, i0 + edge),
      endLevel: mean(lvl, i1 - edge, i1),
      peak,
      peakAt: peakAt / fps,
      feat: centroidFeat,
    };
  });
  // the section holding the loudest sustained moment is the climax; near-equals too
  const top = sections.reduce((a, b) => (b.peak > a.peak ? b : a));
  for (const [i, s] of sections.entries()) {
    const rise = s.peak - s.startLevel;
    const fall = s.peak - s.endLevel;
    const last = i === sections.length - 1;
    let role;
    const finale = last && (s.peakAt - s.start) / (s.end - s.start) > 0.5 && s.peak >= 0.7; // ends on its peak
    if (finale) role = 'climax';
    else if (last && (s.endLevel < s.startLevel - 0.1 || s.level < 0.35)) role = 'fade';
    else if (s === top || (s.peak >= globalPeak - 0.05 && s.level >= 0.7)) role = 'climax';
    else if (s.level < 0.25 && s.peak < 0.45) role = 'hush';
    else if (Math.min(rise, fall) >= 0.2 && s.peak >= 0.5 && Math.abs((s.peakAt - s.start) / (s.end - s.start) - 0.5) <= 0.2) role = 'swell';
    else if (s.endLevel - s.startLevel >= 0.2 && rise >= 0.2) role = 'build';
    else if (s.startLevel - s.endLevel >= 0.2 && fall >= 0.2) role = 'release';
    else if (rise >= 0.15 && fall >= 0.15 && s.peak >= 0.5) role = 'swell';
    else if (s.level < 0.4) role = 'hush';
    else role = 'swell';
    s.role = role;
    s.mood = clamp01(0.08 + 0.92 * (0.6 * s.level + 0.4 * s.peak));
  }
  // letters: sections with similar average features share a letter (A, B, A' ...)
  const letters = [];
  for (const s of sections) {
    let match = -1;
    let bestD = Infinity;
    letters.forEach((l, j) => {
      const d = dist(s.feat, l.feat) / Math.sqrt(dims);
      if (d < bestD) [bestD, match] = [d, j];
    });
    if (match >= 0 && bestD < S.SAME_LETTER) s.letter = letters[match].name;
    else {
      const name = String.fromCharCode(65 + letters.length);
      letters.push({ name, feat: s.feat });
      s.letter = name;
    }
  }
  return sections.map((s, i) => ({
    index: i,
    start: round(s.start, 2),
    end: round(s.end, 2),
    role: s.role,
    label: `${s.letter} · ${s.role}`,
    letter: s.letter,
    mood: round(s.mood, 2),
    level: round(s.level, 2),
    startLevel: round(s.startLevel, 2),
    endLevel: round(s.endLevel, 2),
    peak: round(s.peak, 2),
    peakAt: round(s.peakAt, 1),
  }));
}

// -------------------------------------------------------------------- climaxes

function climaxes(loud, duration) {
  const C = CONFIG.CLIMAX;
  const fps = CONFIG.SR / CONFIG.HOP;
  const sus = movingAverage(loud.level, Math.round(C.SUSTAIN * fps));
  const sustained = peaks(sus, Math.round(C.MIN_SEPARATION * fps), 0.3)
    .slice(0, C.COUNT)
    .map((i) => {
      // where the build toward it started: the last time the slow level was well below
      let j = i;
      while (j > 0 && loud.slowLevel[j] > sus[i] - 0.35) j--;
      return { t: round(i / fps, 1), level: round(sus[i], 2), buildStart: round(j / fps, 1), db: round(loud.slowDb[i], 1) };
    })
    .sort((a, b) => b.level - a.level);

  const span = Math.round(C.RISE_SPAN * fps);
  const smooth = movingAverage(loud.db, Math.round(fps));
  const rate = new Float64Array(smooth.length);
  for (let i = span; i < smooth.length - span; i++) rate[i] = (smooth[i + span] - smooth[i - span]) / (2 * C.RISE_SPAN);
  const rise = peaks(rate, Math.round(C.RISE_SEPARATION * fps), 0.5)
    .slice(0, C.COUNT)
    .map((i) => {
      // the moment the rise arrives: the loudest point in the next few seconds
      let arrive = i;
      for (let j = i; j < Math.min(smooth.length, i + Math.round(5 * fps)); j++) if (smooth[j] > smooth[arrive]) arrive = j;
      return { t: round(i / fps, 1), arrive: round(arrive / fps, 1), rate: round(rate[i], 1), from: round(smooth[Math.max(0, i - span)], 1), to: round(smooth[arrive], 1) };
    });
  return { sustained, rise: rise.filter((r) => r.arrive <= duration) };
}

// -------------------------------------------------------------- manual blocks

const MANUAL_TEMPLATE = {
  _help:
    'Hand edits, kept when the analysis is regenerated. boundaries: section start times (s) replacing the automatic ones (rerun npm run analyze). sections: [{ at, role, label, mood, hue }] override the section containing time `at`; role is one of hush, build, swell, climax, release, fade; hue is 0..1. cues: [{ t, type, value }] extra cue points, e.g. { "t": 281.5, "type": "burst" } or { "t": 120, "type": "hue", "value": 0.6 }.',
  boundaries: [],
  sections: [],
  cues: [],
};

/** Section overrides from the manual block (same logic as scoreMap.js). */
export function applyManual(sections, manual) {
  if (!manual?.sections?.length) return sections;
  return sections.map((s) => {
    const o = manual.sections.find((m) => m.at >= s.start && m.at < s.end);
    return o ? { ...s, ...Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'at')), manual: true } : s;
  });
}

// --------------------------------------------------------------------- output

const fmtTime = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;

function summary(a) {
  const lines = [];
  const p = a.loudness.percentiles;
  lines.push('');
  lines.push(`== ${a.title} (${a.composer})  [${a.id}]`);
  lines.push(`   file      ${a.file}`);
  lines.push(`   duration  ${fmtTime(a.duration)}   tempo ~${a.tempo.bpm} bpm (confidence ${a.tempo.confidence})   ${a.beats.length} beats, ${a.onsets.times.length} onsets (${(a.onsets.times.length / a.duration).toFixed(1)}/s)`);
  lines.push(`   loudness  p5 ${p.p5} · p50 ${p.p50} · p95 ${p.p95} · max ${p.max} dBFS   dynamic range (p95 - p5) ${(p.p95 - p.p5).toFixed(1)} dB`);
  lines.push(`   melody    ${a.melody.range[0]}-${a.melody.range[1]} Hz (p3-p97 of confident frames)`);
  if (a.voices) {
    const v = a.voices;
    lines.push(`   voices    low ${v.low.range[0]}-${v.low.range[1]} Hz: ${v.low.notes.times.length} notes (${(v.low.notes.times.length / a.duration).toFixed(1)}/s)  ·  melody ${v.melody.range[0]}-${v.melody.range[1]} Hz: ${v.melody.notes.times.length} notes (${(v.melody.notes.times.length / a.duration).toFixed(1)}/s)`);
  }
  lines.push(`   keys      ${a.keys.regions.map((r) => `${fmtTime(r.start)} ${r.key}`).join('  ·  ')}`);
  lines.push('   sections');
  lines.push('     #  start    end      len   role     label         mood  level  start→end  peak @');
  const keyAt = (t) => a.keys.regions.find((r) => t >= r.start && t < r.end)?.key ?? '';
  for (const s of applyManual(a.sections, a.manual)) {
    lines.push(
      `    ${String(s.index).padStart(2)}  ${fmtTime(s.start).padStart(6)}  ${fmtTime(s.end).padStart(6)}  ${(s.end - s.start).toFixed(0).padStart(4)}s  ${s.role.padEnd(8)} ${s.label.padEnd(13)} ${s.mood.toFixed(2)}  ${s.level.toFixed(2)}   ${s.startLevel.toFixed(2)}→${s.endLevel.toFixed(2)}  ${s.peak.toFixed(2)} @ ${fmtTime(s.peakAt)}  ${keyAt((s.start + s.end) / 2)}${s.manual ? '  (manual)' : ''}`,
    );
  }
  lines.push('   climaxes by sustained loudness (4 s)');
  for (const c of a.climaxes.sustained) lines.push(`     ${fmtTime(c.t).padStart(6)}  level ${c.level.toFixed(2)}  ${c.db} dB   build from ${fmtTime(c.buildStart)}`);
  lines.push('   climaxes by loudness rise');
  for (const c of a.climaxes.rise) lines.push(`     ${fmtTime(c.t).padStart(6)}  +${c.rate} dB/s   ${c.from} → ${c.to} dB, arrives ${fmtTime(c.arrive)}`);
  if (a.manual?.cues?.length) lines.push(`   manual cues  ${a.manual.cues.map((c) => `${fmtTime(c.t)} ${c.type}${c.value !== undefined ? ' ' + c.value : ''}`).join('  ·  ')}`);
  return lines.join('\n');
}

const curve = (arr, d, step = CONFIG.DECIMATE) => {
  const out = [];
  for (let i = 0; i < arr.length; i += step) out.push(round(arr[i], d));
  return out;
};

async function analyse(file, piece) {
  const started = Date.now();
  const x = await decode(path.join(MUSIC, file));
  const duration = x.length / CONFIG.SR;
  const fps = CONFIG.SR / CONFIG.HOP;
  const outFile = path.join(OUT, `${piece.id}.json`);
  let manual = structuredClone(MANUAL_TEMPLATE);
  try {
    const old = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    if (old.manual) manual = { ...manual, ...old.manual, _help: MANUAL_TEMPLATE._help };
  } catch {
    /* first run */
  }

  const f = frameFeatures(x);
  const loud = loudnessCurves(f);
  const bands = normaliseBands(f);
  const onsets = detectOnsets(f.flux, loud.db);
  const { tempo, beats } = tempoAndBeats(f.flux, piece.bpm);
  const chroma = chromaFrames(f, f.power);
  const keys = estimateKeys(f, f.power, duration);
  const mel = melody(f, loud.db);
  const low = lowVoice(f, loud);
  const lead = melodyVoice(f, loud);
  const sections = segment(f, loud, bands, duration, manual);
  const climax = climaxes(loud, duration);

  const result = {
    version: 1,
    id: piece.id,
    title: piece.title,
    composer: piece.composer,
    file,
    duration: round(duration, 3),
    generated: new Date().toISOString(),
    frameRate: round(fps / CONFIG.DECIMATE, 4),
    chromaRate: round(fps / CONFIG.CHROMA.DECIMATE, 4),
    tempo,
    loudness: { db: curve(loud.db, 1), slowDb: curve(loud.slowDb, 1), percentiles: loud.percentiles, range: loud.range },
    level: curve(loud.level, 3),
    bands: { bass: curve(bands.bass, 2), mid: curve(bands.mid, 2), treble: curve(bands.treble, 2) },
    centroid: curve(f.centroid, 0),
    melody: { hz: curve(mel.hz, 1), height: curve(mel.height, 3), confidence: curve(mel.confidence, 2), range: mel.range },
    chroma,
    onsets,
    voices: {
      low: {
        range: low.range,
        hz: curve(low.hz, 1),
        height: curve(low.height, 3),
        confidence: curve(low.confidence, 2),
        note: curve(low.note, 0, CONFIG.CHROMA.DECIMATE),
        notes: low.notes,
      },
      melody: { range: lead.range, hz: curve(lead.hz, 1), height: curve(lead.height, 3), confidence: curve(lead.confidence, 2), notes: lead.notes },
    },
    beats,
    keys,
    sections,
    climaxes: climax,
    manual,
  };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(result));
  console.log(summary(result));
  console.log(`   -> ${path.relative(ROOT, outFile)} (${(fs.statSync(outFile).size / 1024).toFixed(0)} kB, ${((Date.now() - started) / 1000).toFixed(1)} s)`);
}

async function main() {
  const filter = process.argv.slice(2).join(' ').toLowerCase();
  let files = [];
  try {
    files = fs.readdirSync(MUSIC).filter((f) => /\.(mp3|wav|flac|ogg|oga|m4a|aac|webm)$/i.test(f));
  } catch {
    console.error(`No audio folder at ${MUSIC}. Put the pieces there (see src/pieces.js).`);
    process.exit(1);
  }
  const jobs = [];
  for (const file of files) {
    const piece = pieceForFile(file) ?? {
      id: file
        .normalize('NFC')
        .replace(/\.[^.]+$/, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, ''),
      title: file.replace(/\.[^.]+$/, ''),
      composer: '',
    };
    if (filter && !piece.id.includes(filter) && !file.normalize('NFC').toLowerCase().includes(filter)) continue;
    jobs.push([file, piece]);
  }
  jobs.sort((a, b) => (PIECES.indexOf(a[1]) + 1 || 99) - (PIECES.indexOf(b[1]) + 1 || 99));
  if (!jobs.length) console.error('Nothing to analyse.');
  for (const [file, piece] of jobs) await analyse(file, piece);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
