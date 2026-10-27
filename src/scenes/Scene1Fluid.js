import * as THREE from 'three';
import { SceneBase } from './SceneBase.js';
import { FullscreenPass, passMaterial } from '../gl/FullscreenPass.js';
import { DoubleTarget, createTarget } from '../gl/targets.js';
import { pointer } from '../input.js';
import { createTunePanel, configParams, bindConfig } from '../tune.js';
import { NOTE_NAMES } from '../audio.js';
import { SCORE_CONFIG } from '../scoreMap.js';
import { PROFILE, TUNE } from './profiles/drottningholm.js';

import noiseGLSL from '../shaders/common/noise.glsl?raw';
import baseVert from '../shaders/fluid/base.vert?raw';
import splatFrag from '../shaders/fluid/splat.frag?raw';
import advectionFrag from '../shaders/fluid/advection.frag?raw';
import divergenceFrag from '../shaders/fluid/divergence.frag?raw';
import curlFrag from '../shaders/fluid/curl.frag?raw';
import vorticityFrag from '../shaders/fluid/vorticity.frag?raw';
import pressureFrag from '../shaders/fluid/pressure.frag?raw';
import gradientFrag from '../shaders/fluid/gradientSubtract.frag?raw';
import clearFrag from '../shaders/fluid/clear.frag?raw';
import copyFrag from '../shaders/fluid/copy.frag?raw';
import displayFrag from '../shaders/fluid/display.frag?raw';

/**
 * Scene 1: Liquid paint pour.
 *
 * A GPU Navier-Stokes solver in the style of Pavel Dobryakov's WebGL Fluid
 * Simulation: velocity / dye / pressure / divergence / curl live in
 * half-float ping-pong targets, and every frame runs
 *   splats -> curl -> vorticity confinement -> divergence ->
 *   pressure (Jacobi x20) -> gradient subtraction -> advection (velocity, dye)
 *
 * Colour follows the melody: every pour takes its colour from COLOUR.RAMP at
 * the current audio.pitchHeight (low notes deep purple and navy, the middle
 * ocean and cyan, high notes light blue, mint and warm white), with a little
 * random variation, loudness-dependent intensity and saturation, and a small
 * hue shift from the dominant pitch class. The dye stores real
 * (premultiplied) colour, so paint already on the canvas keeps its colour
 * and new paint mixes into it naturally. Colour is stored in Oklab, a
 * perceptual space, so mixes stay colourful like paint (purple + cyan
 * passes through blue) instead of averaging to grey as linear RGB does.
 *
 * Gold is a separate metallic layer drawn on top of the paint, so it stays
 * brilliant instead of mixing with the blues: high notes deposit gold (more
 * when loud), a share of pours carry a gold accent at any pitch, and some
 * treble specks are gold flecks.
 *
 * Motion model: everything is driven by one slowly smoothed value, `drive`
 * (music presence x loudness). With no music the simulation clock runs at
 * ~10% and only faint ambient pours keep the paint drifting; as the music
 * gets louder, drive eases up over a few seconds and with it the clock,
 * the pour rate and force, and the swirliness. Pours never hit as one-frame
 * impulses: each is spread over a short window with a smooth envelope.
 *
 * Tuned for orchestral / Baroque music such as Roman's Drottningholmsmusiken,
 * which has no drums: drive follows loudness *and* note density (a Presto
 * swirls more than a Larghetto at the same volume), every articulated note
 * spawns a bloom (spread over the canvas, higher for higher notes), and the
 * continuo bass pours in from below.
 *
 * Note blooms are the scene's main reaction: each note's colour arrives as a
 * short streak that spins into a small spiral, in blue, purple, yellow or
 * white (never the same family as the last note) and with a brief glow, and a short jet rolls it up
 * into a little jellyfish (a vortex ring, like a blown smoke ring); while the note is held (same pitch, loudness not fallen
 * away) follow-up puffs feed it from behind, so long notes make bigger
 * jellyfish that travel further. Beats, bass and swirl are kept gentle (MOTION) so the blooms
 * stay easy to follow.
 *
 * With the Drottningholmsmusiken analysis loaded (audio.perf, scoreMap.js) the
 * scene performs the piece through profiles/drottningholm.js: the clock
 * follows the score's anticipating drive like a tide, sections set calm /
 * building / climax / resolving states, every onset in the score blooms a
 * note at its own pitch, key changes throw colour bursts, and the rising
 * finale pours from below. Any other source runs on the live analyser.
 *
 * Over all of that runs the journey (PROFILE.JOURNEY): a slow 0..1 value,
 * dawn to deep night, from hand-set keyframes at the playhead (or a slow
 * drift on elapsed music time for live input). It blends the palette stops
 * (PROFILE.PALETTES: each has its own pitch ramp, so high notes stay lighter
 * than low ones *within* the current palette), the ground, lacing, exposure
 * and vignette, the fluid's feel (FEEL), the dominant flow (FLOW: diagonal
 * early, spirals late), slow washes of the new palette (WASH), a blue-white
 * flare for climaxes deep in the night (FLARE) and a slow zoom (VIEW). Each
 * section pours with its own seeded choreography (CHOREO), and a seek
 * repaints the canvas in the new palette (REPAINT).
 */

// ===================================================================== config
const COLOUR = {
  // pitchHeight -> colour: the `ramp` of each journey palette stop (PROFILE.PALETTES),
  // sampled with smooth monotone interpolation and blended between the two nearest stops
  JITTER: 0.05, // random +/- offset along the ramp, fixed per pour
  // loudness 0..1 -> multipliers [quiet, loud]
  LOUD_AMOUNT: [0.75, 1.15], // how much paint a pour carries
  LOUD_BRIGHTNESS: [0.85, 1.12],
  LOUD_SATURATION: [0.9, 1.15],
  HUE_SHIFT_DEG: 15, // max hue shift from the dominant pitch class (0 = off)
  HUE_SMOOTHING: 0.3, // s
  DYE_DISSIPATION: 0.1, // per simulated second, the same for every channel so colours never drift
  VIBRANCE: 1.15, // chroma boost at display, makes blues and golds pop (1 = off)
  // metallic gold layer, drawn on top of the paint
  GOLD: {
    BRIGHT: '#ffd23f', // bright yellow gold
    DEEP: '#e8b51f', // rich deep gold (kept on the yellow side of orange)
    HEIGHT_START: 0.7, // pitch height where pours start to carry gold...
    FROM_HEIGHT: 0.5, // ...up to this much gold per unit of paint at the top
    ACCENT_CHANCE: 0.14, // share of pours with a gold accent at any pitch
    ACCENT_AMOUNT: [0.9, 1.4],
    FLECKS: 0.4, // share of treble specks that are gold
    DISSIPATION: 0.16, // per simulated second
  },
};
// ============================================================================

const MAX_SPLATS = 12;
const PRESSURE_ITERATIONS = 20;
const PRESSURE_DECAY = 0.8;
// velocity damping per simulated second: strong when calm so motion settles
const VELOCITY_DISSIPATION = { calm: 0.85, active: 0.4 };

// Simulation clock: speed = IDLE_SPEED + MUSIC_SPEED * drive
const IDLE_SPEED = 0.1;
const MUSIC_SPEED = 1.3;
// How quickly the motion follows the music (seconds, per smoothing stage x2)
const DRIVE_RISE = 3.0;
const DRIVE_FALL = 5.0;
// drive = presence * (loudness and note density blend)
const DRIVE_FROM_ENERGY = 0.7;
const DRIVE_FROM_DENSITY = 0.3;
// Background motion (beats, bass, swirl): kept gentle so the note blooms read clearly
const MOTION = {
  BEAT_CHANCE: 0.2, // share of beats (x drive) that add a pour
  BEAT_PUSH: [240, 380],
  BASS_RATE: 1.6, // bass pours per second at full bass and drive
  BASS_PUSH: [150, 250],
  CURL: [0.8, 1.2, 4], // swirl = base + drive * (a + mid * b)
  SPECKS_RATE: 10, // treble specks per second at full treble
  CELLS_RATE: 0.4, // scales how often cells open
};
// Note blooms: every detected note fires a short jet of paint, which the fluid
// rolls up into a vortex ring: on screen a little jellyfish (a round head with
// two curls and a trailing stem), like a blown smoke ring. While the note is
// held, gentler puffs keep following it, like smoke blown into the ring, so
// a long note makes a bigger jellyfish that travels further.
const BLOOM = {
  MIN_GAP: 0.06, // s between two blooms
  // placement: of CANDIDATES random spots, the one farthest from the last
  // RECENT blooms wins, so they fill the canvas instead of clustering
  CANDIDATES: 8,
  RECENT: 10,
  PITCH_PULL: 0.6, // 0 = height ignores pitch, 1 = height strictly follows pitch
  MARGIN: 0.06, // keep blooms this far from the edges (uv)
  ATTACK_RADIUS: [0.0002, 0.00035], // size of the pop at the attack (on-screen width ~ sqrt of this)
  ATTACK_PAINT: [0.8, 1.1],
  JET: [500, 800], // the puff at the attack (x drive)
  JET_TIME: 0.15, // s the attack puff lasts (short and sharp rolls up best)
  JET_WIDTH: 1, // puff width relative to the bloom (narrow = tight head)
  GROW: 0.0012, // radius added per second the note is held...
  MAX_RADIUS: 0.0028, // ...up to this
  // size variation: each note's swirl width is scaled by 2^(random -1..1 x
  // SIZE_SPREAD x 'size variation'), and louder notes come out a bit bigger
  SIZE_SPREAD: 1.3, // at full variation: about 0.4x to 2.5x the normal width
  SIZE_LOUD: [0.85, 1.2], // width factor for quiet .. loud notes
  FEED: 0.8, // paint per second while held
  PUFF_EVERY: 0.1, // s between the follow-up puffs of a held note
  PUFF: 160,
  // spin: the note's colour arrives as a short streak from the centre, and the
  // spot spins faster inside than outside, which winds the streak into a spiral
  SPIN: [260, 400], // spin at the attack
  SPIN_HOLD: 110, // extra spin per follow-up while the note is held
  SPIN_EVERY: 0.15, // s between those
  SPIN_POINTS: 10, // pushes around the circle (few = star / plus shapes)
  STREAK: 4, // paint splats along the streak
  STREAK_LEN: 1.4, // streak length relative to the bloom's width
  UPWARD: 0.6, // 0 = jets fly in any direction, 1 = straight up
  MAX_HOLD: 3, // s
  // afterlife: once a held note ends, its swirl keeps getting a little paint
  // and spin, tapering off, for LINGER s per second the note was held
  LINGER: 1.0,
  LINGER_MAX: 4, // s
  LINGER_PAINT: 0.5, // share of the held-note paint feed it starts with
  LINGER_SPIN: 0.6, // share of the held-note spin it starts with
  SETTLE: 0.12, // s after the attack while pitch and loudness are still settling
  PITCH_TOLERANCE: 0.08, // pitch height drift that still counts as the same note
  RELEASE: 0.55, // the note has ended once loudness falls below this share of its attack
};
// Note colours: every note's swirl takes one of four colour families, never
// the same family as the note before. Hues are OKLCH degrees; lightness L
// follows the pitch within each family's range, so the melody still reads
// as light (high) and dark (low).
const PALETTE = {
  VARIETY: 1, // share of notes that take a family colour; the rest keep their pitch colour
  FAMILIES: [
    { name: 'blue', weight: 0.35, hue: [235, 262], L: [0.4, 0.85], C: [0.12, 0.19] },
    { name: 'purple', weight: 0.3, hue: [292, 316], L: [0.35, 0.75], C: [0.12, 0.17] },
    { name: 'yellow', weight: 0.2, hue: [86, 96], L: [0.8, 0.9], C: [0.14, 0.16] },
    { name: 'white', weight: 0.15, hue: [250, 260], L: [0.9, 0.97], C: [0.01, 0.025] },
  ],
  // the allowed hue bands (blue..purple and yellow); anything else is pulled
  // to the nearest band when close, or loses its colour (white / grey) when far
  BANDS: [
    [215, 322],
    [80, 102],
  ],
  SNAP: 25, // degrees outside a band that are still pulled into it...
  FADE: 45, // ...and by this many degrees out, the colour is gone
  GREY_CHROMA: 0.035, // colours this pale count as white / grey at any hue
  YELLOW_DARK: [0.45, 0.65], // yellow darker than this reads as olive / brown: fade it to grey
};
// lightness span of all the families together: mapped onto the journey's lightness window
const FAMILY_L = [Math.min(...PALETTE.FAMILIES.map((f) => f.L[0])), Math.max(...PALETTE.FAMILIES.map((f) => f.L[1]))];
// Note glow: light (not paint) where a note appears, fading quickly, so you
// can see each note of the melody arrive
const GLOW = {
  MAX: 16, // glows alive at once (must match MAX_GLOWS in display.frag)
  FADE: 0.6, // s for the glow to fade to about a third
  SIZE: 2.2, // radius relative to the bloom's width
  STRENGTH: 0.8,
  WHITE: 0.3, // how far the glow leans from the note colour toward white
};
// Live tuning panel (T): multipliers default to 1 = the values above
const TUNE_PARAMS = [
  { group: 'blooms (one per note)' },
  { key: 'bloomSize', label: 'size ×', min: 0.1, max: 4, step: 0.05, value: 1 },
  { key: 'sizeVariation', label: 'size variation', min: 0, max: 1, step: 0.05, value: 0.6, hint: '0 = every swirl the same size, 1 = from tiny to large; louder notes are a bit bigger' },
  { key: 'bloomGrowth', label: 'held-note growth ×', min: 0, max: 4, step: 0.05, value: 1, hint: 'how much longer notes widen their bloom' },
  { key: 'bloomPaint', label: 'paint amount ×', min: 0, max: 3, step: 0.05, value: 1 },
  { key: 'jet', label: 'jet strength ×', min: 0, max: 3, step: 0.05, value: 1, hint: 'how hard each note puffs; stronger = bigger, faster jellyfish' },
  { key: 'jetWidth', label: 'jet width ×', min: 0.3, max: 3, step: 0.05, value: 1, hint: 'narrow = tight round head, wide = broad mushroom' },
  { key: 'upward', label: 'direction: any → up', min: 0, max: 1, step: 0.05, value: BLOOM.UPWARD, hint: '0 = any direction, 1 = straight up' },
  { key: 'spin', label: 'colour spin ×', min: 0, max: 3, step: 0.05, value: 1, hint: "how hard each note's colour spins into a spiral; 0 = no spin" },
  { key: 'hueVariety', label: 'colour variety', min: 0, max: 1, step: 0.05, value: PALETTE.VARIETY, hint: '0 = colour by pitch only, 1 = every note blue, purple, yellow or white, different from the last' },
  { key: 'glow', label: 'note glow ×', min: 0, max: 3, step: 0.05, value: 1, hint: 'light where each note appears; 0 = off' },
  { key: 'glowFade', label: 'glow fade (s)', min: 0.1, max: 2, step: 0.05, value: GLOW.FADE },
  { key: 'glowSize', label: 'glow size ×', min: 0.3, max: 3, step: 0.05, value: 1 },
  { key: 'puff', label: 'held-note puffs ×', min: 0, max: 3, step: 0.05, value: 1, hint: 'the smoke that follows into the ring while a note is held' },
  { key: 'pitchPull', label: 'height follows pitch', min: 0, max: 1, step: 0.05, value: BLOOM.PITCH_PULL, hint: '0 = scattered anywhere, 1 = height strictly by pitch' },
  { key: 'linger', label: 'long-note afterlife ×', min: 0, max: 3, step: 0.05, value: 1, hint: 'how much longer a long note keeps its swirl alive after it ends; 0 = off' },
  { key: 'release', label: 'held-note cutoff', min: 0.2, max: 0.95, step: 0.05, value: BLOOM.RELEASE, hint: 'lower = notes count as held longer' },
  { group: 'motion' },
  { key: 'swirl', label: 'overall swirl ×', min: 0, max: 3, step: 0.05, value: 1 },
  { key: 'damping', label: 'damping', min: 0.05, max: 1.5, step: 0.05, value: VELOCITY_DISSIPATION.active, hint: 'higher = motion settles faster' },
  { key: 'flowSpeed', label: 'flow speed ×', min: 0.2, max: 2, step: 0.05, value: 1 },
  { key: 'beatPours', label: 'beat pours ×', min: 0, max: 3, step: 0.05, value: 1 },
  { key: 'bassPours', label: 'bass pours ×', min: 0, max: 3, step: 0.05, value: 1 },
  { group: 'details' },
  { key: 'specks', label: 'treble specks ×', min: 0, max: 3, step: 0.05, value: 1 },
  { key: 'cells', label: 'cells ×', min: 0, max: 3, step: 0.05, value: 1 },
  { key: 'fade', label: 'paint fade speed ×', min: 0, max: 4, step: 0.05, value: 1, hint: 'how fast old paint (and blooms) fades away; 0 = never' },
];
const QUALITY = [
  { sim: 160, dye: 1280 },
  { sim: 140, dye: 1024 },
  { sim: 128, dye: 768 },
  { sim: 96, dye: 512 },
];

const rand = (a, b) => a + Math.random() * (b - a);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/** sRGB (0..1) -> Oklab [L, a, b] (Björn Ottosson's matrices). */
function srgbToOklab(r, g, b) {
  r = srgbToLinear(r);
  g = srgbToLinear(g);
  b = srgbToLinear(b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

/**
 * Keeps an Oklab colour inside the allowed hues (PALETTE.BANDS): close
 * misses are pulled to the nearest band edge, far ones fade to white / grey.
 * display.frag applies the same rule to every pixel (paint mixes included).
 */
function toPalette(L, A, B) {
  const C = Math.hypot(A, B);
  if (C < PALETTE.GREY_CHROMA) return [L, A, B];
  const h = ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360;
  let best = Infinity;
  let edge = h;
  const [ylo, yhi] = PALETTE.BANDS[1];
  if (h >= ylo && h <= yhi) {
    // yellow only stays yellow when it is light; dark yellow would look olive
    const keep = smoothstep(...PALETTE.YELLOW_DARK, L);
    const c = PALETTE.GREY_CHROMA + (C - PALETTE.GREY_CHROMA) * keep;
    return [L, (A / C) * c, (B / C) * c];
  }
  for (const [lo, hi] of PALETTE.BANDS) {
    if (h >= lo && h <= hi) return [L, A, B];
    for (const e of [lo, hi]) {
      const d = Math.abs(((h - e + 540) % 360) - 180);
      if (d < best) {
        best = d;
        edge = e;
      }
    }
  }
  const keep = 1 - smoothstep(PALETTE.SNAP, PALETTE.FADE, best);
  const c = PALETTE.GREY_CHROMA + (C - PALETTE.GREY_CHROMA) * keep;
  const a = (edge * Math.PI) / 180;
  return [L, Math.cos(a) * c, Math.sin(a) * c];
}

/** Oklab -> linear sRGB (the inverse of srgbToOklab, before its gamma step). */
function oklabToLinear(L, A, B) {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    Math.max(0, 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    Math.max(0, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    Math.max(0, -0.0041960863 * l - 0.7034186147 * m + 1.707692666 * s),
  ];
}

function simResolution(base, aspect) {
  const a = aspect < 1 ? 1 / aspect : aspect;
  const min = Math.round(base);
  const max = Math.round(base * a);
  return aspect >= 1 ? [max, min] : [min, max];
}

/**
 * Samples the ramp stops into a 256-entry sRGB lookup table using monotone
 * cubic (Fritsch-Carlson) interpolation per channel: smooth through every
 * stop, without the overshoot a plain spline would give between dark navy
 * and bright cyan.
 */
function buildRamp(stops) {
  const t = stops.map((s) => s[0]);
  const c = stops.map(([, hex]) => [0, 1, 2].map((i) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255));
  const n = stops.length;
  const lut = new Float32Array(256 * 3);
  for (let ch = 0; ch < 3; ch++) {
    const h = [];
    const delta = [];
    for (let i = 0; i < n - 1; i++) {
      h.push(t[i + 1] - t[i]);
      delta.push((c[i + 1][ch] - c[i][ch]) / h[i]);
    }
    const m = new Array(n);
    m[0] = delta[0];
    m[n - 1] = delta[n - 2];
    for (let i = 1; i < n - 1; i++) {
      m[i] = delta[i - 1] * delta[i] <= 0 ? 0 : (3 * (h[i - 1] + h[i])) / ((2 * h[i] + h[i - 1]) / delta[i - 1] + (h[i] + 2 * h[i - 1]) / delta[i]);
    }
    for (let j = 0; j < 256; j++) {
      const x = j / 255;
      let i = 0;
      while (i < n - 2 && x > t[i + 1]) i++;
      const u = clamp01((x - t[i]) / h[i]);
      const u2 = u * u;
      const u3 = u2 * u;
      const v = (2 * u3 - 3 * u2 + 1) * c[i][ch] + (u3 - 2 * u2 + u) * h[i] * m[i] + (-2 * u3 + 3 * u2) * c[i + 1][ch] + (u3 - u2) * h[i] * m[i + 1];
      lut[j * 3 + ch] = clamp01(v);
    }
  }
  return lut;
}

// the journey's palette stops, each with its pitch ramp as a lookup table
const STOPS = PROFILE.PALETTES.map((p) => ({ ...p, lut: buildRamp(p.ramp), groundCol: p.ground.map((hex) => new THREE.Color(hex)) }));

/**
 * Monotone cubic (Fritsch-Carlson) through [x, y] keys, sampled at x: smooth
 * through every keyframe, and never overshooting or turning back between two.
 */
function monotone(keys, x) {
  const n = keys.length;
  if (x <= keys[0][0]) return keys[0][1];
  if (x >= keys[n - 1][0]) return keys[n - 1][1];
  let i = 0;
  while (x > keys[i + 1][0]) i++;
  const slope = (j) => (keys[j + 1][1] - keys[j][1]) / (keys[j + 1][0] - keys[j][0]);
  const tangent = (j) => {
    if (j === 0) return slope(0);
    if (j === n - 1) return slope(n - 2);
    const a = slope(j - 1);
    const b = slope(j);
    return a * b <= 0 ? 0 : (2 * a * b) / (a + b);
  };
  const h = keys[i + 1][0] - keys[i][0];
  const u = (x - keys[i][0]) / h;
  const u2 = u * u;
  const u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * keys[i][1] + (u3 - 2 * u2 + u) * h * tangent(i) + (-2 * u3 + 3 * u2) * keys[i + 1][1] + (u3 - u2) * h * tangent(i + 1);
}

/** Small seeded PRNG (mulberry32): the same section always gets the same choreography. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export default class Scene1Fluid extends SceneBase {
  constructor() {
    super({ baseSpeed: IDLE_SPEED, speedGain: MUSIC_SPEED });
    this.renderScale = 1;
    this.toneMapped = false;
    this.queue = [];
    this.gusts = [];
    this.drive = 0; // smoothed music intensity, 0 = silence
    this.driveStage = 0; // first smoothing stage
    this.pointerBoost = 0;
    this.speed = IDLE_SPEED;
    this.lastBeat = -1;
    this.lastNote = -1;
    this.lastPress = -1;
    this.realTime = 0;
    this.lastBloom = -1;
    this.bloom = null; // the bloom of the note being held, if any
    this.blooms = 0; // count, for the debug overlay
    this.recentBlooms = []; // positions of the last few blooms, for spreading them out
    this.lastFamily = -1; // colour family of the last note (index into PALETTE.FAMILIES)
    this.glows = [];
    this.lingering = []; // swirls of ended long notes, kept alive for a while
    this.tune = createTunePanel({
      title: 'Liquid Paint tuning',
      storageKey: 'resonance.tune.fluid',
      params: [...TUNE_PARAMS, ...configParams(PROFILE, TUNE)],
      onChange: bindConfig(PROFILE),
    });
    // score following: section state, the music the blooms read, key bursts, the finale
    this.stage = { ...PROFILE.STAGES.calm };
    this.music = { height: 0.5, energy: 0, presence: 0 };
    this.scored = false;
    this.jumpId = -1;
    this.keyId = -1;
    this.keyTurn = 0;
    this.noteBudget = 0;
    this.keyBursts = 0;
    this.acc = { bass: 0, treble: 0, cells: 0, ambient: 0, finale: 0 };
    this.curlStrength = 2;
    this.velocityDissipation = VELOCITY_DISSIPATION.active;
    this.pointerJitter = 0;
    this.emitters = Array.from({ length: 3 }, (_, i) => ({
      phase: (i / 3) * Math.PI * 2,
      speed: rand(0.05, 0.11) * (i % 2 ? -1 : 1),
      radius: rand(0.18, 0.32),
      wobble: rand(0, 10),
      x: 0.5,
      y: 0.5,
    }));

    // colour state, refreshed every frame from the audio
    this.height = 0.5; // pitch height the next paint is coloured by
    this.loud = 0.3;
    this.hueShift = 0; // degrees
    this._hue = [1, 0, 0, 0, 1, 0, 0, 0, 1]; // hue rotation matrix (sRGB)
    this._rgb = [0, 0, 0];
    this.note = 2; // dominant pitch class behind the hue shift
    this.sheen = 0;

    // the journey: dawn (0) to deep night (1)
    this.journeyBase = PROFILE.JOURNEY.IDLE; // keyframe value (smoothed)
    this.lift = 0; // climax lift toward the light
    this.journey = this.journeyBase; // what the look uses: base minus lift
    this.flare = 0; // blue-white climax flare deep in the night, 0..1
    this.liveClock = 0; // s of music heard, paces the journey for live input
    this.heard = false;
    this.musicTime = 0;
    this.flowAngle = 0;
    this.repaints = 0;
    this.view = new THREE.Vector3(0.5, 0.5, 1);
    this.choreo = { id: -1, type: 'orbit', seq: [], centre: [0.5, 0.5] };
    Object.assign(this.acc, { flow: 0, wash: 2, flare: 0 });
    this.pal = { lo: 0, hi: 0, f: 0 };
    this.feel = {};
    this._applyJourney(this.journey);
  }

  async init(renderer) {
    await super.init(renderer);
    this.pass = new FullscreenPass();
    this.aspect = 16 / 9;

    const texelSize = () => ({ value: new THREE.Vector2(1 / 128, 1 / 128) });
    const solver = (fragmentShader, uniforms) => passMaterial({ vertexShader: baseVert, fragmentShader, uniforms: { texelSize: texelSize(), ...uniforms } });

    this.mats = {
      splat: solver(splatFrag, {
        uTarget: { value: null },
        aspectRatio: { value: 1 },
        uCount: { value: 0 },
        uPoints: { value: Array.from({ length: MAX_SPLATS }, () => new THREE.Vector3()) },
        uColors: { value: Array.from({ length: MAX_SPLATS }, () => new THREE.Vector4()) },
        uFade: { value: new Float32Array(MAX_SPLATS) },
        uMin: { value: 0 },
      }),
      advection: solver(advectionFrag, {
        uVelocity: { value: null },
        uSource: { value: null },
        dt: { value: 0 },
        dissipation: { value: new THREE.Vector4() },
      }),
      divergence: solver(divergenceFrag, { uVelocity: { value: null } }),
      curl: solver(curlFrag, { uVelocity: { value: null } }),
      vorticity: solver(vorticityFrag, {
        uVelocity: { value: null },
        uCurl: { value: null },
        curl: { value: 0 },
        dt: { value: 0 },
      }),
      pressure: solver(pressureFrag, { uPressure: { value: null }, uDivergence: { value: null } }),
      gradient: solver(gradientFrag, { uPressure: { value: null }, uVelocity: { value: null } }),
      clear: solver(clearFrag, { uTexture: { value: null }, value: { value: PRESSURE_DECAY } }),
      copy: solver(copyFrag, { uTexture: { value: null } }),
      display: passMaterial({
        fragmentShader: noiseGLSL + displayFrag,
        uniforms: {
          uDye: { value: null },
          uGold: { value: null },
          cGold: { value: new THREE.Color(COLOUR.GOLD.BRIGHT) },
          cGoldDeep: { value: new THREE.Color(COLOUR.GOLD.DEEP) },
          uSheen: { value: 0 },
          uVibrance: { value: COLOUR.VIBRANCE },
          uDyeTexel: { value: new THREE.Vector2() },
          uAspect: { value: 1 },
          uTime: { value: 0 },
          uTreble: { value: 0 },
          uBeat: { value: 0 },
          cWhite: { value: new THREE.Color(0xf4fbff) },
          // ground colours, lacing, vignette and view follow the journey (_applyJourney)
          cNavy: { value: new THREE.Color(0x0a1f4a) },
          cDeep: { value: new THREE.Color(0x030a1e) },
          uLaceLight: { value: 0 },
          uLaceAmt: { value: 1 },
          uVignette: { value: 0.35 },
          uView: { value: this.view },
          uGlow: { value: Array.from({ length: GLOW.MAX }, () => new THREE.Vector4()) },
          uGlowCol: { value: Array.from({ length: GLOW.MAX }, () => new THREE.Vector3()) },
          uGlowCount: { value: 0 },
        },
      }),
    };
    this.mats.splat.defines.MAX_SPLATS = MAX_SPLATS;
    this.mats.splat.needsUpdate = true;

    await this.pass.compile(renderer, Object.values(this.mats));
    this._allocate();
    this._initialPour();
  }

  // ------------------------------------------------------------- targets

  _allocate() {
    const q = QUALITY[this.quality] ?? QUALITY[0];
    const [sw, sh] = simResolution(q.sim, this.aspect);
    const [dw, dh] = simResolution(q.dye, this.aspect);
    const halfRG = { type: THREE.HalfFloatType, format: THREE.RGFormat, filter: THREE.LinearFilter };
    const halfR = { type: THREE.HalfFloatType, format: THREE.RedFormat, filter: THREE.NearestFilter };
    const halfRGBA = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, filter: THREE.LinearFilter };

    this.velocity = this._resizeDouble(this.velocity, sw, sh, halfRG);
    this.dye = this._resizeDouble(this.dye, dw, dh, halfRGBA);
    this.gold = this._resizeDouble(this.gold, dw, dh, halfRG);
    this.pressure = this._resizeDouble(this.pressure, sw, sh, halfR);
    if (!this.divergence || this.divergence.width !== sw || this.divergence.height !== sh) {
      this.divergence?.dispose();
      this.curl?.dispose();
      this.divergence = createTarget(sw, sh, halfR);
      this.curl = createTarget(sw, sh, halfR);
    }
    this.simTexel = new THREE.Vector2(1 / sw, 1 / sh);
    this.simHeight = Math.min(sw, sh);
    for (const m of Object.values(this.mats)) m.uniforms.texelSize?.value.copy(this.simTexel);
    this.mats.display.uniforms.uDyeTexel.value.set(1 / dw, 1 / dh);
  }

  /** Re-creates a ping-pong pair at a new size, carrying the old contents over. */
  _resizeDouble(target, w, h, opts) {
    if (target && target.width === w && target.height === h) return target;
    const next = new DoubleTarget(w, h, opts);
    if (target) {
      this.mats.copy.uniforms.uTexture.value = target.read.texture;
      this.pass.render(this.renderer, this.mats.copy, next.read);
      target.dispose();
    } else {
      this.renderer.setRenderTarget(next.read);
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.clear();
    }
    return next;
  }

  resize(width, height) {
    super.resize(width, height);
    this.aspect = width / height;
    this.mats.display.uniforms.uAspect.value = this.aspect;
    this.mats.splat.uniforms.aspectRatio.value = this.aspect;
    this._allocate();
  }

  setQuality(level) {
    super.setQuality(level);
    this._allocate();
  }

  // -------------------------------------------------------------- colour

  /** Updates loudness, hue shift and the hue rotation matrix from the audio. */
  _updateColourState(dt, audio) {
    this.height = this.music.height;
    this.loud = this.music.energy;
    this.note = this.scored ? audio.perf.key.tonic : audio.dominantNote;
    let target;
    let smoothing = COLOUR.HUE_SMOOTHING;
    if (this.scored) {
      // the key of the passage turns the paint's hue (profile KEYS), slowly
      target = this._keyStyle(audio.perf.key).turn * audio.presence;
      smoothing = PROFILE.BURST.TURN_SMOOTHING;
    } else {
      // dominant pitch class -> small hue shift; positions on the circle of
      // fifths, so related keys get related shifts
      const fifths = (audio.dominantNote * 7) % 12;
      target = COLOUR.HUE_SHIFT_DEG * Math.sin((fifths / 12) * Math.PI * 2) * smoothstep(0.3, 0.7, audio.noteStrength) * audio.presence;
    }
    this.hueShift += (target - this.hueShift) * (1 - Math.exp(-dt / smoothing));
    // rotation about the grey axis (keeps luminance roughly, turns hue)
    const a = (this.hueShift * Math.PI) / 180;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const k = (1 - cos) / 3;
    const s3 = Math.sqrt(1 / 3) * sin;
    this._hue = [cos + k, k - s3, k + s3, k + s3, cos + k, k - s3, k - s3, k + s3, cos + k];
  }

  /**
   * Ramp colour (sRGB, 0..1) at a pitch height, with the current hue shift
   * and loudness-dependent saturation and brightness applied.
   */
  _rampColour(height, out = this._rgb) {
    const x = clamp01(height) * 255;
    const i = Math.min(254, Math.floor(x));
    const f = x - i;
    // the two journey palette stops around the current journey, blended
    const P = this.pal;
    const at = (lut, k) => lerp(lut[i * 3 + k], lut[i * 3 + 3 + k], f);
    const lo = STOPS[P.lo].lut;
    const hi = STOPS[P.hi].lut;
    let r = lerp(at(lo, 0), at(hi, 0), P.f);
    let g = lerp(at(lo, 1), at(hi, 1), P.f);
    let b = lerp(at(lo, 2), at(hi, 2), P.f);
    const m = this._hue;
    [r, g, b] = [m[0] * r + m[1] * g + m[2] * b, m[3] * r + m[4] * g + m[5] * b, m[6] * r + m[7] * g + m[8] * b];
    const sat = lerp(COLOUR.LOUD_SATURATION[0], COLOUR.LOUD_SATURATION[1], this.loud);
    const bright = lerp(COLOUR.LOUD_BRIGHTNESS[0], COLOUR.LOUD_BRIGHTNESS[1], this.loud);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    out[0] = clamp01((lum + (r - lum) * sat) * bright);
    out[1] = clamp01((lum + (g - lum) * sat) * bright);
    out[2] = clamp01((lum + (b - lum) * sat) * bright);
    return out;
  }

  /**
   * Premultiplied dye for a pour: the ramp colour at the current pitch
   * height (plus the pour's own jitter), in Oklab.
   */
  _dye(jitter, amount, height = this.height, tint = null) {
    const [L, A, B] = this._lab(jitter, height, tint);
    const a = amount * lerp(COLOUR.LOUD_AMOUNT[0], COLOUR.LOUD_AMOUNT[1], this.loud);
    return [L * a, A * a, B * a, a];
  }

  /**
   * Oklab colour of new paint: the palette colour for this pitch height, or
   * with a `tint` (a note's colour family) that family's hue and chroma, with
   * the pitch setting the lightness inside the family's range. Always kept
   * inside the allowed hues.
   */
  _lab(jitter, height = this.height, tint = null) {
    if (tint?.lab) return toPalette(...tint.lab);
    const c = this._rampColour(height + jitter);
    let [L, A, B] = srgbToOklab(c[0], c[1], c[2]);
    if (tint) {
      const f = PALETTE.FAMILIES[tint.family];
      const P = this.pal;
      // the family's own lightness, squeezed into the journey's window (a
      // night note stays dark unless it is one of the rare bright accents)
      const [lo, hi] = tint.accent ? PROFILE.ACCENT.L : P.L;
      const fl = (lerp(f.L[0], f.L[1], clamp01(height + jitter)) - FAMILY_L[0]) / (FAMILY_L[1] - FAMILY_L[0]);
      const rampL = L;
      const rampA = A;
      const rampB = B;
      L = lerp(lo, hi, clamp01(fl));
      // accents are cyan / ice white, whatever the family
      const a = ((tint.accent ? tint.accentHue : tint.hue) * Math.PI) / 180;
      const chroma = tint.accent ? tint.accentChroma : tint.chroma * P.chroma;
      A = Math.cos(a) * chroma;
      B = Math.sin(a) * chroma;
      if (tint.pull) {
        // key bursts: pulled toward the journey palette so the arc stays coherent
        L = lerp(L, rampL, tint.pull);
        A = lerp(A, rampA, tint.pull);
        B = lerp(B, rampB, tint.pull);
      }
    }
    return toPalette(L, A, B);
  }

  /**
   * Colour for the next note: with probability `colour variety` a family
   * colour (blue, purple, yellow or white, never the last note's family),
   * otherwise null (the pitch colour).
   */
  _nextTint() {
    if (Math.random() >= this.tune.values.hueVariety) return null;
    // the journey palette sets how often each family appears (more white at dawn, more purple at night)
    const options = PALETTE.FAMILIES.map((f, i) => (i === this.lastFamily ? 0 : f.weight * this.pal.families[i]));
    let r = Math.random() * options.reduce((a, b) => a + b, 0);
    let family = 0;
    while (family < options.length - 1 && r >= options[family]) r -= options[family++];
    this.lastFamily = family;
    const f = PALETTE.FAMILIES[family];
    const A = PROFILE.ACCENT;
    return { family, hue: rand(...f.hue), chroma: rand(...f.C), accent: Math.random() < this.pal.accent, accentHue: rand(...A.HUE), accentChroma: rand(...A.CHROMA) };
  }

  // -------------------------------------------------------------- journey

  /**
   * The journey value for this frame: keyframes at the playhead (or a slow
   * drift on music heard, for live input), smoothed, minus the climax lift.
   * Returns true when a seek moved it far enough to repaint the canvas.
   */
  _updateJourney(dt, audio, perf, jumped) {
    const J = PROFILE.JOURNEY;
    let base;
    if (this.scored) {
      this.musicTime = perf.t;
      this.pieceEnd = perf.map?.duration;
      base = monotone(J.KEYS, perf.t);
    } else {
      // live: the same arc, paced by the music actually heard, then back again
      if (audio.presence > 0.3) this.heard = true;
      this.liveClock += dt * audio.presence;
      this.musicTime = this.liveClock;
      const p = (this.liveClock / J.DRIFT_SECONDS) % 2;
      base = this.heard ? monotone(J.KEYS, (p < 1 ? p : 2 - p) * J.KEYS[J.KEYS.length - 1][0]) : J.IDLE;
    }
    if (J.FORCE >= 0) base = J.FORCE;
    const before = this.journeyBase;
    this.journeyBase = jumped ? base : this.journeyBase + (base - this.journeyBase) * (1 - Math.exp(-dt / J.SMOOTHING));
    // deep in the night a climax flares instead of lifting the whole palette
    const F = PROFILE.FLARE;
    const deep = smoothstep(F.FROM[0], F.FROM[1], this.journeyBase);
    const climax = perf?.climax ?? 0;
    const liftTarget = J.CLIMAX_LIFT * climax * (1 - 0.6 * deep);
    this.lift = jumped ? liftTarget : this.lift + (liftTarget - this.lift) * (1 - Math.exp(-dt / (liftTarget > this.lift ? J.LIFT_RISE : J.LIFT_FALL)));
    this.flare = deep * climax * audio.presence;
    this.journey = clamp01(this.journeyBase - this.lift);
    this._applyJourney(this.journey);
    return jumped && Math.abs(this.journeyBase - before) > PROFILE.REPAINT.MIN_CHANGE;
  }

  /** Blends the palette stops and the fluid's feel for journey value j. */
  _applyJourney(j) {
    const P = this.pal;
    let hi = STOPS.findIndex((s) => s.at >= j);
    if (hi < 0) hi = STOPS.length - 1;
    const lo = Math.max(0, hi - 1);
    const f = hi === lo ? 0 : clamp01((j - STOPS[lo].at) / (STOPS[hi].at - STOPS[lo].at));
    const a = STOPS[lo];
    const b = STOPS[hi];
    Object.assign(P, { lo, hi, f });
    P.L = [lerp(a.L[0], b.L[0], f), lerp(a.L[1], b.L[1], f)];
    P.families = a.families.map((w, i) => lerp(w, b.families[i], f));
    for (const k of ['chroma', 'exposure', 'lace', 'vignette', 'gold', 'glow']) P[k] = lerp(a[k], b[k], f);
    P.accent = lerp(...PROFILE.ACCENT.CHANCE, j);
    for (const [k, [dawn, night]] of Object.entries(PROFILE.FEEL)) this.feel[k] = lerp(dawn, night, j);
    const u = this.mats?.display.uniforms;
    if (!u) return;
    u.cDeep.value.lerpColors(a.groundCol[0], b.groundCol[0], f);
    u.cNavy.value.lerpColors(a.groundCol[1], b.groundCol[1], f);
    u.uLaceLight.value = P.lace;
    u.uLaceAmt.value = this.feel.LACE;
    u.uVignette.value = P.vignette;
  }

  /**
   * The pour choreography of a section, seeded by its index: orbiting
   * nozzles, vertical streams, scattered bursts, an inward spiral or a drift
   * along the flow, never one of the last CHOREO.AVOID patterns. Live input
   * changes pattern every LIVE_EVERY seconds.
   */
  _updateChoreo(perf) {
    const C = PROFILE.CHOREO;
    const id = this.scored ? perf.section?.index ?? 0 : Math.floor(this.realTime / C.LIVE_EVERY);
    if (id === this.choreo.id) return;
    const ch = this.choreo;
    // the pattern sequence is built from the start, so a seek lands on the same pattern
    while (ch.seq.length <= id) {
      const rng = seeded(C.SEED + ch.seq.length * 7919);
      const options = C.TYPES.filter((t) => !ch.seq.slice(-C.AVOID).includes(t));
      ch.seq.push(options[Math.floor(rng() * options.length)]);
    }
    const rng = seeded(C.SEED * 3 + id * 104729);
    const r = (a, b) => a + rng() * (b - a);
    ch.id = id;
    ch.type = ch.seq[id];
    ch.centre = [r(0.35, 0.65), r(0.35, 0.6)];
    const sign = rng() < 0.5 ? -1 : 1;
    this.emitters.forEach((e, i) => {
      e.phase = r(0, Math.PI * 2);
      e.speed = r(0.05, 0.11) * (i % 2 ? -sign : sign);
      e.radius = r(0.18, 0.32);
      e.wobble = r(0, 10);
      e.col = (i + 0.5) / this.emitters.length + r(-0.08, 0.08); // streams: their column
      e.up = i % 2 ? -1 : 1; // streams: rising or falling
      e.x0 = r(0.1, 0.9); // drift: starting point
      e.y0 = r(0.1, 0.9);
      e.travel = 0;
    });
  }

  /** Moves the pour nozzles for the section's choreography and sets their pour direction. */
  _moveEmitters(sdt, t) {
    const type = this.choreo.type;
    const [cx, cy] = this.choreo.centre;
    const sx = 1 / Math.max(1, this.aspect * 0.75);
    const fx = Math.cos(this.flowAngle);
    const fy = Math.sin(this.flowAngle);
    for (const e of this.emitters) {
      e.phase += sdt * e.speed * 2.2;
      const dir = Math.sign(e.speed);
      if (type === 'streams') {
        e.x = e.col;
        e.y = 0.5 - e.up * (0.3 - 0.08 * Math.sin(e.phase));
        e.dx = 0.25 * Math.sin(t * 0.3 + e.wobble);
        e.dy = e.up * 1.4;
      } else if (type === 'scatter') {
        // the nozzle jumps to a fresh spot for every pour (pour() moves it); bursts fly outward
        e.x ??= 0.5;
        e.y ??= 0.5;
        e.dx = (e.x - cx) * 2.5;
        e.dy = (e.y - cy) * 2.5;
      } else if (type === 'spiral') {
        // nozzles wind inward toward the centre, then start again further out
        const k = 1 - ((e.phase / (Math.PI * 4)) % 1 + 1) % 1;
        const r = 0.06 + e.radius * k;
        e.x = cx + r * Math.cos(e.phase) * sx;
        e.y = cy + r * Math.sin(e.phase) * 1.15;
        e.dx = -Math.sin(e.phase) * dir * 0.9 + (cx - e.x) * 2;
        e.dy = Math.cos(e.phase) * dir * 0.9 + (cy - e.y) * 2;
      } else if (type === 'drift') {
        // nozzles travel with the dominant flow and wrap around
        e.travel += sdt * Math.abs(e.speed) * 2.2;
        const s = e.travel * 0.06;
        const wrap = (v) => 0.08 + ((((v - 0.08) % 0.84) + 0.84) % 0.84);
        e.x = wrap(e.x0 + fx * s);
        e.y = wrap(e.y0 + fy * s);
        e.dx = fx * 1.2;
        e.dy = fy * 1.2;
      } else {
        // orbit: the scene's original pattern, swirling with a pull toward the centre
        const r = e.radius + 0.06 * Math.sin(t * 0.21 + e.wobble);
        e.x = 0.5 + r * Math.cos(e.phase) * sx;
        e.y = 0.5 + r * Math.sin(e.phase) * 1.15;
        e.dx = -Math.sin(e.phase) * dir * 0.8 + (0.5 - e.x) * 1.2;
        e.dy = Math.cos(e.phase) * dir * 0.8 + (0.5 - e.y) * 1.2;
      }
    }
  }

  /**
   * The dominant flow: a broad, slow diagonal current early in the journey,
   * slow spirals around the section's centre later; its direction turns
   * slowly with the music.
   */
  _flow(sdt) {
    const F = PROFILE.FLOW;
    this.flowAngle = ((F.ANGLE + F.TURN * this.musicTime) * Math.PI) / 180;
    this.acc.flow += sdt / F.EVERY;
    if (this.acc.flow < 1) return;
    this.acc.flow %= 1;
    const spiral = smoothstep(F.SPIRAL[0], F.SPIRAL[1], this.journey);
    const force = this.feel.FORCE;
    if (spiral < 1) {
      const push = F.PUSH * (1 - spiral) * force;
      this._gust({ x: rand(0.15, 0.85), y: rand(0.15, 0.85), vx: Math.cos(this.flowAngle) * push, vy: Math.sin(this.flowAngle) * push, radius: F.RADIUS, duration: F.EVERY * 1.5 });
    }
    if (spiral > 0) {
      const [cx, cy] = this.choreo.centre;
      const ax = this.aspect > 1 ? 1 / this.aspect : 1;
      const r = rand(0.1, 0.3);
      const a0 = Math.random() * Math.PI * 2;
      const push = F.SPIRAL_PUSH * spiral * force;
      for (let i = 0; i < 4; i++) {
        const a = a0 + (i * Math.PI) / 2;
        // tangential with a slight inward lean: a slow spiral, not a ring
        const vx = -Math.sin(a) - 0.25 * Math.cos(a);
        const vy = Math.cos(a) - 0.25 * Math.sin(a);
        this._gust({ x: cx + Math.cos(a) * r * ax, y: cy + Math.sin(a) * r, vx: vx * push, vy: vy * push, radius: F.SPIRAL_RADIUS, duration: F.EVERY * 1.2 });
      }
    }
  }

  /**
   * A wash: a large, slow sweep of the current palette from upstream across
   * the canvas, two heights at once so it never lays down a flat colour.
   * `tint` (a key burst) colours it in the new key instead.
   */
  _wash(strength = 1, tint = null) {
    const W = PROFILE.WASH;
    const fx = Math.cos(this.flowAngle);
    const fy = Math.sin(this.flowAngle);
    const side = rand(-0.3, 0.3);
    const x = clamp01(0.5 - fx * 0.32 - fy * side);
    const y = clamp01(0.5 - fy * 0.32 + fx * side);
    const h0 = Math.random();
    for (let i = 0; i < 2; i++) {
      const push = rand(...W.PUSH) * this.feel.FORCE;
      this._gust({
        x: x + rand(-0.06, 0.06),
        y: y + rand(-0.06, 0.06),
        vx: fx * push,
        vy: fy * push,
        amount: rand(...W.PAINT) * strength,
        height: (h0 + i * rand(0.3, 0.6)) % 1,
        tint,
        radius: rand(...W.RADIUS) * this.feel.RADIUS,
        duration: W.DURATION,
      });
    }
  }

  /** Deep-night climax: blue-white paint and light bursting out against the dark. */
  _flareBurst(drive) {
    const F = PROFILE.FLARE;
    const [cx, cy] = this.choreo.centre;
    const x = clamp01(cx + rand(-0.25, 0.25));
    const y = clamp01(cy + rand(-0.2, 0.2));
    const a = Math.random() * Math.PI * 2;
    const h = (F.HUE * Math.PI) / 180;
    const lab = [F.L, Math.cos(h) * F.CHROMA, Math.sin(h) * F.CHROMA];
    const push = rand(...F.PUSH) * (0.6 + 0.6 * drive);
    const radius = rand(...F.RADIUS);
    this._gust({ x, y, vx: Math.cos(a) * push, vy: Math.sin(a) * push, amount: F.PAINT, tint: { lab }, radius, duration: 0.8 });
    const [r, g, b] = oklabToLinear(...lab);
    this.glows.push({ x, y, age: 0, bloom: { radius: radius * F.GLOW_SIZE }, col: [r, g, b], strength: GLOW.STRENGTH * F.GLOW * this.flare });
    if (this.glows.length > GLOW.MAX) this.glows.shift();
  }

  /** After a seek: most of the old paint fades at once and the canvas is repainted in the new palette. */
  _repaint() {
    const R = PROFILE.REPAINT;
    const c = this.mats.clear.uniforms.value;
    c.value = R.KEEP;
    for (const t of [this.dye, this.gold]) {
      this.mats.clear.uniforms.uTexture.value = t.read.texture;
      this.pass.render(this.renderer, this.mats.clear, t.write);
      t.swap();
    }
    c.value = PRESSURE_DECAY;
    for (let i = 0; i < R.SPLATS; i++) {
      const a = Math.random() * Math.PI * 2;
      const dye = this._dye(0, rand(0.8, 1.3), (i + Math.random()) / R.SPLATS);
      this.splat(rand(0.08, 0.92), rand(0.08, 0.92), Math.cos(a) * 240, Math.sin(a) * 240, dye, rand(0.006, 0.014) * this.feel.RADIUS);
    }
    this.repaints++;
  }

  // -------------------------------------------------------------- splats

  /** Splat radius in the solver's units, corrected for wide screens. */
  _radius(r) {
    return this.aspect > 1 ? r * this.aspect : r;
  }

  /**
   * Queues a splat. (x, y) in 0..1 uv, (vx, vy) impulse in sim texels / s
   * (scaled so the look is resolution independent), `dye` is premultiplied
   * colour + amount (or null), `fade` opens a hole in the paint (cells),
   * `gold` is [bright, deep] gold amounts (or null).
   */
  splat(x, y, vx, vy, dye, radius, fade = 0, gold = null) {
    const k = this.simHeight / 128;
    this.queue.push({ x, y, vx: vx * k, vy: vy * k, dye, fade, gold, radius: this._radius(radius) });
  }

  /** Gold for a pour: high notes gild (more when loud), accents gild at any pitch. */
  _goldFor(g, w) {
    const G = COLOUR.GOLD;
    let amount = (g.goldAccent ?? 0) * w;
    if (g.amount) {
      const high = smoothstep(G.HEIGHT_START, 1, this.height + g.jitter);
      amount += g.amount * w * G.FROM_HEIGHT * high * lerp(0.6, 1.2, this.loud);
    }
    amount *= this.pal.gold; // fewer gold accents at dawn and deep in the night
    if (amount <= 0) return null;
    return [amount * (1 - g.goldTone), amount * g.goldTone];
  }

  _initialPour() {
    // no music yet: colours from across the ramp
    for (let i = 0; i < 18; i++) {
      const a = Math.random() * Math.PI * 2;
      const dye = this._dye(0, rand(0.8, 1.4), rand(0.15, 0.9));
      this.splat(rand(0.1, 0.9), rand(0.1, 0.9), Math.cos(a) * 260, Math.sin(a) * 260, dye, rand(0.006, 0.014));
    }
    // and a few gold accents
    for (let i = 0; i < 3; i++) {
      const a = Math.random() * Math.PI * 2;
      const tone = Math.random() * 0.6;
      this.splat(rand(0.15, 0.85), rand(0.15, 0.85), Math.cos(a) * 200, Math.sin(a) * 200, null, rand(0.003, 0.006), 0, [0.9 * (1 - tone), 0.9 * tone]);
    }
    for (let i = 0; i < 70; i++) {
      this._flushSplats();
      this._step(1 / 60);
    }
  }

  _flushSplats() {
    const u = this.mats.splat.uniforms;
    const fade = u.uFade.value;
    while (this.queue.length) {
      const batch = this.queue.splice(0, MAX_SPLATS);
      u.uCount.value = batch.length;

      batch.forEach((s, i) => {
        u.uPoints.value[i].set(s.x, s.y, s.radius);
        u.uColors.value[i].set(s.vx, s.vy, 0, 0);
      });
      fade.fill(0);
      u.uTarget.value = this.velocity.read.texture;
      u.uMin.value = -1e6;
      this.pass.render(this.renderer, this.mats.splat, this.velocity.write);
      this.velocity.swap();

      batch.forEach((s, i) => {
        if (s.dye) u.uColors.value[i].fromArray(s.dye);
        else u.uColors.value[i].set(0, 0, 0, 0);
        fade[i] = s.fade;
      });
      u.uTarget.value = this.dye.read.texture;
      u.uMin.value = -1e6; // Oklab a/b are signed; amounts only ever grow or fade
      this.pass.render(this.renderer, this.mats.splat, this.dye.write);
      this.dye.swap();

      if (batch.some((s) => s.gold || s.fade)) {
        batch.forEach((s, i) => {
          if (s.gold) u.uColors.value[i].set(s.gold[0], s.gold[1], 0, 0);
          else u.uColors.value[i].set(0, 0, 0, 0);
          fade[i] = s.fade * 0.6;
        });
        u.uTarget.value = this.gold.read.texture;
        u.uMin.value = 0;
        this.pass.render(this.renderer, this.mats.splat, this.gold.write);
        this.gold.swap();
      }
    }
  }

  // ---------------------------------------------------------- simulation

  _step(dt) {
    const r = this.renderer;
    const m = this.mats;
    const pass = this.pass;

    // 1. curl of the velocity field
    m.curl.uniforms.uVelocity.value = this.velocity.read.texture;
    pass.render(r, m.curl, this.curl);

    // 2. vorticity confinement
    m.vorticity.uniforms.uVelocity.value = this.velocity.read.texture;
    m.vorticity.uniforms.uCurl.value = this.curl.texture;
    m.vorticity.uniforms.curl.value = this.curlStrength;
    m.vorticity.uniforms.dt.value = dt;
    pass.render(r, m.vorticity, this.velocity.write);
    this.velocity.swap();

    // 3. divergence
    m.divergence.uniforms.uVelocity.value = this.velocity.read.texture;
    pass.render(r, m.divergence, this.divergence);

    // 4. keep part of last frame's pressure as a warm start
    m.clear.uniforms.uTexture.value = this.pressure.read.texture;
    pass.render(r, m.clear, this.pressure.write);
    this.pressure.swap();

    // 5. Jacobi pressure solve
    m.pressure.uniforms.uDivergence.value = this.divergence.texture;
    for (let i = 0; i < PRESSURE_ITERATIONS; i++) {
      m.pressure.uniforms.uPressure.value = this.pressure.read.texture;
      pass.render(r, m.pressure, this.pressure.write);
      this.pressure.swap();
    }

    // 6. subtract the pressure gradient -> divergence-free velocity
    m.gradient.uniforms.uPressure.value = this.pressure.read.texture;
    m.gradient.uniforms.uVelocity.value = this.velocity.read.texture;
    pass.render(r, m.gradient, this.velocity.write);
    this.velocity.swap();

    // 7. advect velocity through itself
    const adv = m.advection.uniforms;
    adv.dt.value = dt;
    adv.uVelocity.value = this.velocity.read.texture;
    adv.uSource.value = this.velocity.read.texture;
    adv.dissipation.value.setScalar(this.velocityDissipation);
    pass.render(r, m.advection, this.velocity.write);
    this.velocity.swap();

    // 8. advect the paint (same dissipation on every channel keeps hues stable)
    adv.uVelocity.value = this.velocity.read.texture;
    adv.uSource.value = this.dye.read.texture;
    adv.dissipation.value.setScalar(COLOUR.DYE_DISSIPATION * this.tune.values.fade * this.feel.DYE_FADE);
    pass.render(r, m.advection, this.dye.write);
    this.dye.swap();

    // 9. advect the gold layer
    adv.uSource.value = this.gold.read.texture;
    adv.dissipation.value.setScalar(COLOUR.GOLD.DISSIPATION * this.tune.values.fade);
    pass.render(r, m.advection, this.gold.write);
    this.gold.swap();
  }

  // -------------------------------------------------------------- motion

  /**
   * Advances the scene clock from the smoothed `drive` value instead of raw
   * energy. Two cascaded first-order followers give an ease-in / ease-out
   * curve, so movement builds up and calms down gradually, never in steps.
   * Returns the simulated time step.
   */
  _advanceClock(dt, audio, jumped) {
    const follow = (v, to, rise, fall) => v + (to - v) * (1 - Math.exp(-dt / ((to > v ? rise : fall) * 0.5)));
    if (this.scored) {
      // the score's drive already anticipates; the tide follows it, quiet stays slow
      const D = PROFILE.DRIVE;
      const target = audio.presence * Math.min(1, D.FROM_LEVEL * Math.pow(audio.perf.drive, D.CURVE) + D.FROM_DENSITY * audio.density);
      if (jumped) this.driveStage = this.drive = target;
      this.driveStage = follow(this.driveStage, target, D.RISE, D.FALL);
      this.drive = follow(this.drive, this.driveStage, D.RISE, D.FALL);
    } else {
      // loudness leads; note density lets busy passages swirl more than slow ones
      const target = audio.presence * Math.min(1, DRIVE_FROM_ENERGY * audio.energy + DRIVE_FROM_DENSITY * audio.density);
      this.driveStage = follow(this.driveStage, target, DRIVE_RISE, DRIVE_FALL);
      this.drive = follow(this.drive, this.driveStage, DRIVE_RISE, DRIVE_FALL);
    }

    // dragging temporarily speeds the clock up so pouring by hand feels responsive
    this.pointerBoost = follow(this.pointerBoost, pointer.down ? 1 : 0, 0.3, 2.0);

    this.speed = (IDLE_SPEED + MUSIC_SPEED * this.tune.values.flowSpeed * this.drive) * this.stage.speed * this.feel.SPEED + 0.6 * this.pointerBoost;
    const sdt = dt * this.speed;
    this.time += sdt;
    return sdt;
  }

  /**
   * Queues a pour: the impulse and paint are released over `duration`
   * simulated seconds with a smooth sine envelope rather than in one frame.
   * The paint is coloured as it is released, from the pitch height at that
   * moment, so a long pour paints the melody's movement. If `emitter` is
   * given, the pour follows that moving nozzle.
   */
  _gust(g) {
    this.gusts.push({ age: 0, jitter: (Math.random() * 2 - 1) * COLOUR.JITTER, goldTone: Math.random() * 0.6, ...g });
  }

  _updateGusts(sdt) {
    for (const g of this.gusts) {
      const a0 = g.age / g.duration;
      g.age = Math.min(g.duration, g.age + sdt);
      const a1 = g.age / g.duration;
      // share of the whole pour released in this step (integral of the envelope)
      const w = (Math.cos(Math.PI * a0) - Math.cos(Math.PI * a1)) * 0.5;
      if (w <= 0) continue;
      const x = g.emitter ? g.emitter.x : g.x;
      const y = g.emitter ? g.emitter.y : g.y;
      // velocity is a rate of push; spreading it needs a little extra gain
      const k = w * 1.6;
      const { vx, vy } = g;
      const dye = g.fade || !g.amount ? null : this._dye(g.jitter, g.amount * w, g.height ?? this.height, g.tint);
      const gold = g.fade ? null : this._goldFor(g, w);
      this.splat(x, y, vx * k, vy * k, dye, g.radius, g.fade ? g.fade * w : 0, gold);
    }
    this.gusts = this.gusts.filter((g) => g.age < g.duration);
  }

  // -------------------------------------------------------------- note blooms

  /**
   * A new note: a pop of paint coloured by its pitch and a short jet that
   * rolls it up into a jellyfish. It becomes the held bloom, which _growBloom
   * keeps feeding until the note ends (a new note simply takes over).
   */
  _spawnBloom(pitch, energy, drive) {
    pitch = clamp01(pitch);
    const [x, y] = this._placeBloom(pitch);
    const b = {
      x,
      y,
      pitch,
      energy,
      held: 0,
      puffClock: 0,
      spinClock: 0,
      spin: Math.random() < 0.5 ? -1 : 1, // clockwise or counter-clockwise
      // the jet's direction: around straight up, spread wider the lower 'upward' is
      dir: Math.PI / 2 + (Math.random() * 2 - 1) * Math.PI * (1 - this.tune.values.upward),
      // width factor for this note (radius goes with width squared)
      width: 2 ** ((Math.random() * 2 - 1) * BLOOM.SIZE_SPREAD * this.tune.values.sizeVariation) * lerp(...BLOOM.SIZE_LOUD, this.loud),
      jitter: (Math.random() * 2 - 1) * COLOUR.JITTER,
      goldTone: Math.random() * 0.6,
      goldAccent: Math.random() < COLOUR.GOLD.ACCENT_CHANCE * this.pal.gold ? rand(...COLOUR.GOLD.ACCENT_AMOUNT) : 0,
      amount: 1,
      tint: this._nextTint(),
    };
    b.radius = rand(...BLOOM.ATTACK_RADIUS) * this.tune.values.bloomSize * b.width ** 2 * this.stage.size * this.feel.BLOOM;
    // the colour: a short streak from the centre outward, so the spin below
    // visibly winds it into a spiral (a round dot would just turn in place)
    const amount = rand(...BLOOM.ATTACK_PAINT) * this.tune.values.bloomPaint * this.stage.paint;
    const len = BLOOM.STREAK_LEN * Math.sqrt(this._radius(b.radius));
    const ax = this.aspect > 1 ? 1 / this.aspect : 1;
    const sa = Math.random() * Math.PI * 2;
    for (let i = 0; i < BLOOM.STREAK; i++) {
      const f = i / (BLOOM.STREAK - 1);
      this._gust({
        x: b.x + Math.cos(sa) * len * f * ax,
        y: b.y + Math.sin(sa) * len * f,
        vx: 0,
        vy: 0,
        amount: (amount * 1.6) / BLOOM.STREAK,
        jitter: b.jitter,
        tint: b.tint,
        height: b.pitch,
        goldAccent: b.goldAccent / BLOOM.STREAK,
        radius: b.radius * 0.45,
        duration: 0.25,
      });
    }
    // pushes scale with the width, so a big swirl turns like a small one, only larger
    this._spin(b, rand(...BLOOM.SPIN) * (0.6 + 0.6 * drive) * this.tune.values.spin * b.width);
    // the jet: velocity only (the paint is the pop above), short and sharp
    const jet = rand(...BLOOM.JET) * (0.6 + 0.6 * drive) * this.tune.values.jet * b.width;
    this._gust({ x: b.x, y: b.y, vx: Math.cos(b.dir) * jet, vy: Math.sin(b.dir) * jet, radius: this._jetRadius(b), duration: BLOOM.JET_TIME * this.speed });
    this._addGlow(b);
    if (this.bloom) this._release(this.bloom);
    this.bloom = b;
    this.blooms++;
  }

  /** A glow where a note appears, in the note's colour leaning toward white. */
  _addGlow(b) {
    const [r, g, bl] = oklabToLinear(...this._lab(b.jitter, b.pitch, b.tint));
    // a night climax flares: glows lean further to white and shine brighter
    const w = lerp(GLOW.WHITE, 0.5, this.flare);
    const strength = GLOW.STRENGTH * lerp(0.7, 1.2, this.loud) * this.pal.glow * (1 + PROFILE.FLARE.GLOW * this.flare) * (b.tint?.accent ? 1.5 : 1);
    this.glows.push({ x: b.x, y: b.y, age: 0, bloom: b, col: [lerp(r, 1, w), lerp(g, 1, w), lerp(bl, 1, w)], strength });
    if (this.glows.length > GLOW.MAX) this.glows.shift();
  }

  /** Ages the glows (real time) and hands them to the display shader. */
  _updateGlows(dt) {
    const { glow, glowFade, glowSize } = this.tune.values;
    for (const g of this.glows) g.age += dt;
    this.glows = this.glows.filter((g) => g.age < glowFade * 4);
    const u = this.mats.display.uniforms;
    let n = 0;
    if (glow > 0) {
      for (const g of this.glows) {
        const radius = GLOW.SIZE * glowSize * Math.sqrt(this._radius(g.bloom.radius));
        u.uGlow.value[n].set(g.x, g.y, radius, g.strength * glow * Math.exp(-g.age / glowFade));
        u.uGlowCol.value[n].set(g.col[0], g.col[1], g.col[2]);
        n++;
      }
    }
    u.uGlowCount.value = n;
  }

  /**
   * Picks where a bloom goes: best-candidate sampling, so each new bloom
   * lands far from the recent ones. Height leans toward the pitch (high
   * notes higher) by the pitchPull setting; distances are measured in screen space.
   */
  _placeBloom(pitch) {
    const { CANDIDATES, RECENT, MARGIN } = BLOOM;
    const { pitchPull } = this.tune.values;
    const span = 1 - 2 * MARGIN;
    const aspect = Math.max(1, this.aspect);
    let best = null;
    let bestDist = -1;
    for (let i = 0; i < CANDIDATES; i++) {
      const x = MARGIN + span * Math.random();
      const y = MARGIN + span * lerp(Math.random(), pitch, pitchPull);
      let dist = Infinity;
      for (const [px, py] of this.recentBlooms) dist = Math.min(dist, ((x - px) * aspect) ** 2 + (y - py) ** 2);
      if (dist > bestDist) {
        bestDist = dist;
        best = [x, y];
      }
    }
    this.recentBlooms.push(best);
    if (this.recentBlooms.length > RECENT) this.recentBlooms.shift();
    return best;
  }

  /**
   * Spins the paint around a bloom: small, overlapping pushes around a circle,
   * along it, at a random starting angle (a few pushes at fixed angles would
   * stretch the paint into arms, a plus shape). The spin is strongest at that
   * circle and weaker further out, so paint winds into a spiral.
   */
  _spin(b, push) {
    if (push <= 0) return;
    const n = BLOOM.SPIN_POINTS;
    const d = 0.6 * Math.sqrt(this._radius(b.radius));
    const ax = this.aspect > 1 ? 1 / this.aspect : 1;
    const a0 = Math.random() * Math.PI * 2;
    const k = push * (4 / n); // same total push whatever the number of points
    for (let i = 0; i < n; i++) {
      const a = a0 + (i * Math.PI * 2) / n;
      const c = Math.cos(a);
      const sn = Math.sin(a);
      this.splat(b.x + c * d * ax, b.y + sn * d, -sn * b.spin * k, c * b.spin * k, null, b.radius * 0.7);
    }
  }

  /** Width of a bloom's jet, in splat radius units. */
  _jetRadius(b) {
    return b.radius * BLOOM.JET_WIDTH * this.tune.values.jetWidth;
  }

  /**
   * While the note is held (pitch near where it started, loudness not fallen
   * away) the bloom keeps receiving paint and widens; real time, not the
   * scene clock, because it measures how long the note actually sounds.
   */
  _growBloom(dt) {
    const b = this.bloom;
    if (!b) return;
    const m = this.music;
    if (b.held < BLOOM.SETTLE && !this.scored) {
      // the smoothed live pitch and loudness are still catching up with the attack
      b.pitch = m.height;
      b.energy = Math.max(b.energy, m.energy);
    }
    const sustained = Math.abs(m.height - b.pitch) < BLOOM.PITCH_TOLERANCE && m.energy > b.energy * this.tune.values.release;
    if (m.presence < 0.3 || b.held > BLOOM.MAX_HOLD || (b.held > BLOOM.SETTLE && !sustained)) {
      this._release(b);
      return;
    }
    b.held += dt;
    const { bloomSize, bloomGrowth, bloomPaint, puff, spin } = this.tune.values;
    const grow = bloomSize * bloomGrowth;
    const w2 = b.width ** 2;
    b.radius = Math.min(Math.max(b.radius, BLOOM.MAX_RADIUS * grow * w2), b.radius + BLOOM.GROW * grow * w2 * dt);
    const w = BLOOM.FEED * bloomPaint * dt;
    this.splat(b.x, b.y, 0, 0, this._dye(b.jitter, w, b.pitch, b.tint), b.radius, 0, this._goldFor(b, w));
    // a held note keeps its colour turning
    b.spinClock += dt;
    if (b.spinClock > BLOOM.SPIN_EVERY) {
      b.spinClock -= BLOOM.SPIN_EVERY;
      this._spin(b, BLOOM.SPIN_HOLD * spin * b.width);
    }
    // follow-up puffs in the jet's direction feed the ring from behind
    b.puffClock += dt;
    if (b.puffClock > BLOOM.PUFF_EVERY && puff > 0) {
      b.puffClock -= BLOOM.PUFF_EVERY;
      const k = BLOOM.PUFF * puff * b.width;
      this.splat(b.x, b.y, Math.cos(b.dir) * k, Math.sin(b.dir) * k, null, this._jetRadius(b));
    }
  }

  /**
   * A held note has ended: the longer it was held, the longer its swirl is
   * kept alive afterwards (short notes simply end).
   */
  _release(b) {
    if (this.bloom === b) this.bloom = null;
    const life = Math.min(BLOOM.LINGER_MAX, (b.held - BLOOM.SETTLE) * BLOOM.LINGER * this.tune.values.linger);
    if (life > 0.1) this.lingering.push({ b, age: 0, life });
  }

  /** Afterlife of ended long notes: paint and spin that taper off to nothing. */
  _updateLingering(dt) {
    const { bloomPaint, spin } = this.tune.values;
    for (const l of this.lingering) {
      l.age += dt;
      const k = Math.max(0, 1 - l.age / l.life);
      const b = l.b;
      const w = BLOOM.FEED * bloomPaint * BLOOM.LINGER_PAINT * k * dt;
      this.splat(b.x, b.y, 0, 0, this._dye(b.jitter, w, b.pitch, b.tint), b.radius, 0, this._goldFor(b, w));
      b.spinClock += dt;
      if (b.spinClock > BLOOM.SPIN_EVERY) {
        b.spinClock -= BLOOM.SPIN_EVERY;
        this._spin(b, BLOOM.SPIN_HOLD * BLOOM.LINGER_SPIN * spin * k * b.width);
      }
    }
    this.lingering = this.lingering.filter((l) => l.age < l.life);
  }

  // -------------------------------------------------------------- update

  /** Section state from the score (or the live stage): current stage blending into the next one ahead of time. */
  _updateStage(dt, perf, jumped) {
    const S = PROFILE.STAGES;
    const now = S[perf.stage] ?? S.building;
    const next = perf.next ? S[perf.next.stage] ?? now : now;
    const cross = perf.next ? smoothstep(SCORE_CONFIG.LOOKAHEAD, 0, perf.timeToNext) : 0;
    const k = jumped ? 1 : 1 - Math.exp(-dt / (PROFILE.STAGE_BLEND / 3));
    for (const key of Object.keys(this.stage)) {
      // live input keeps the scene's own (building) behaviour; only the score reshapes it
      const target = this.scored ? lerp(now[key], next[key], cross) : 1;
      this.stage[key] += (target - this.stage[key]) * k;
    }
  }

  _keyStyle(key) {
    return PROFILE.KEYS[NOTE_NAMES[key.tonic]] ?? PROFILE.KEYS.DEFAULT;
  }

  /** A key change: a burst of the new key's colour radiating from a free spot. */
  _keyBurst(key, drive) {
    const K = this._keyStyle(key);
    const B = PROFILE.BURST;
    const [x, y] = this._placeBloom(0.5);
    // the key's colour, pulled toward the journey palette (a gold A major at night stays dark and blue-leaning)
    const tint = { family: K.family, hue: K.hue, chroma: PALETTE.FAMILIES[K.family].C[1], pull: B.PALETTE_PULL };
    const ax = this.aspect > 1 ? 1 / this.aspect : 1;
    const a0 = Math.random() * Math.PI * 2;
    for (let i = 0; i < B.SPOKES; i++) {
      const a = a0 + (i / B.SPOKES) * Math.PI * 2;
      const push = rand(...B.PUSH) * (0.6 + 0.6 * drive);
      this._gust({
        x: x + Math.cos(a) * 0.01 * ax,
        y: y + Math.sin(a) * 0.01,
        vx: Math.cos(a) * push,
        vy: Math.sin(a) * push,
        amount: B.PAINT / B.SPOKES * 3,
        tint,
        height: 0.4 + 0.4 * Math.random(),
        goldAccent: ((K.gold ?? 0) / B.SPOKES) * 3 * this.pal.gold,
        radius: rand(...B.RADIUS),
        duration: B.DURATION,
      });
    }
    // and a wash in the new key sweeps across the canvas
    this._wash(1.2, tint);
    this.acc.wash = rand(...PROFILE.WASH.EVERY);
    this.keyBursts++;
  }

  update(dt, audio) {
    const perf = audio.perf;
    this.scored = perf?.source === 'score';
    const jumped = !!perf && perf.jumpId !== this.jumpId;
    if (perf) this.jumpId = perf.jumpId;
    // what the blooms and colours read: the score's melody (held through unclear frames) or the live analyser
    const m = this.music;
    m.presence = audio.presence;
    if (this.scored) {
      if (perf.heightConf > PROFILE.NOTES.PITCH_HOLD || jumped) m.height = perf.height;
      m.energy = perf.level;
      this._updateStage(dt, perf, jumped);
    } else {
      m.height = audio.pitchHeight;
      m.energy = audio.energy;
      if (perf) this._updateStage(dt, perf, jumped);
    }
    // the journey first: it sets the palette, the fluid's feel and the clock's pace
    if (this._updateJourney(dt, audio, perf, jumped)) this._repaint();
    const sdt = this._advanceClock(dt, audio, jumped);
    this.realTime += dt;
    this._updateColourState(dt, audio);
    // quiet passages look quiet: the whole pour dims (score only; live keeps full exposure);
    // early in the journey only partly, so the dawn canvas stays high-key
    const X = PROFILE.EXPOSURE;
    const dynamic = this.scored ? lerp(X.QUIET, X.LOUD, this.drive) * this.stage.exposure * lerp(1, X.CLIMAX, perf.climax) : 1;
    const expTarget = lerp(1, dynamic, this.feel.EXPOSURE_RANGE) * this.pal.exposure;
    this.exposure += (expTarget - this.exposure) * (jumped ? 1 : 1 - Math.exp(-dt / (expTarget > this.exposure ? X.ATTACK : X.RELEASE)));
    const t = this.time;
    const drive = this.drive;
    const treble = audio.treble * drive; // sparkle only when music plays
    const force = 0.4 + 1.2 * drive; // louder = harder pours

    // Pour points: each section has its own choreography (they move on the
    // scene clock, so slowly when calm)
    this._updateChoreo(perf);
    this._moveEmitters(sdt, t);

    const pour = (e, strength, radius, duration) => {
      if (this.choreo.type === 'scatter') {
        // scattered bursts: every pour from a fresh spot
        e.x = rand(0.12, 0.88);
        e.y = rand(0.12, 0.88);
        e.dx = (e.x - this.choreo.centre[0]) * 2.5;
        e.dy = (e.y - this.choreo.centre[1]) * 2.5;
      }
      // the choreography's direction, a little randomness, and the journey's feel
      // (large soft pours at dawn, heavier ones at night); louder pours are bigger
      strength *= this.feel.FORCE;
      const vx = (e.dx + rand(-0.3, 0.3)) * strength;
      const vy = (e.dy + rand(-0.3, 0.3)) * strength;
      const accent = Math.random() < COLOUR.GOLD.ACCENT_CHANCE * this.pal.gold ? rand(...COLOUR.GOLD.ACCENT_AMOUNT) : 0;
      this._gust({ emitter: e, vx, vy, amount: rand(0.7, 1.3), goldAccent: accent, radius: radius * this.feel.RADIUS * lerp(0.85, 1.25, this.loud), duration });
    };
    const anyEmitter = () => this.emitters[(Math.random() * 3) | 0];

    // Beats: extra pours that only matter once the music has built up
    if (audio.beatId !== this.lastBeat) {
      this.lastBeat = audio.beatId;
      if (Math.random() < drive * MOTION.BEAT_CHANCE * this.stage.pours) pour(anyEmitter(), rand(...MOTION.BEAT_PUSH) * this.tune.values.beatPours * drive * force, rand(0.004, 0.008), 0.7);
    }

    // Notes: every articulated note (bow stroke, pluck, key, wind attack)
    // spawns a bloom of paint, spread over the canvas away from the recent
    // ones, at a height that leans toward the pitch.
    if (this.scored) {
      // the score's onsets, each at its own pitch, rate-limited so dense runs stay readable
      const N = PROFILE.NOTES;
      this.noteBudget = Math.min(N.MAX_PER_SECOND * 0.5, this.noteBudget + dt * N.MAX_PER_SECOND);
      for (const o of perf.onsets) {
        if (audio.presence < 0.3 || drive < N.MIN_DRIVE || this.noteBudget < 1 || this.realTime - this.lastBloom <= BLOOM.MIN_GAP) continue;
        this.noteBudget -= 1;
        this.lastBloom = this.realTime;
        this._spawnBloom(o.height, perf.level, drive);
      }
      // key changes: a burst of the new key's colour
      if (perf.keyId !== this.keyId) {
        if (!jumped && this.keyId >= 0 && audio.presence > 0.5) this._keyBurst(perf.key, drive);
        this.keyId = perf.keyId;
      }
      // the rising finale (the last section, a climax): big pours from below
      if (perf.stage === 'climax' && !perf.next) {
        const F = PROFILE.FINALE;
        this.acc.finale += dt * F.RATE * drive * (0.4 + 0.6 * perf.climax);
        while (this.acc.finale > 1) {
          this.acc.finale -= 1;
          const a = Math.PI / 2 + rand(-0.6, 0.6);
          const push = rand(...F.PUSH) * (0.5 + drive);
          this._gust({ x: rand(0.2, 0.8), y: rand(0.04, 0.16), vx: Math.cos(a) * push, vy: Math.sin(a) * push, amount: F.PAINT, goldAccent: Math.random() < 0.5 ? F.GOLD : 0, radius: rand(...F.RADIUS), duration: 1.4 });
        }
      }
    } else if (audio.melodyNoteId !== this.lastNote) {
      // melodyNoteId: the sensitive melody-range detector (noteId misses most legato notes)
      this.lastNote = audio.melodyNoteId;
      if (audio.presence > 0.3 && this.realTime - this.lastBloom > BLOOM.MIN_GAP) {
        this.lastBloom = this.realTime;
        this._spawnBloom(audio.pitchHeight, audio.energy, drive);
      }
    }
    this._growBloom(dt);
    this._updateLingering(dt);

    // the journey's own motion: the dominant flow, washes of the new palette,
    // and the blue-white flare of a climax deep in the night
    this._flow(sdt);
    this.acc.wash -= dt;
    if (this.acc.wash <= 0) {
      this.acc.wash = rand(...PROFILE.WASH.EVERY);
      this._wash(0.5 + 0.5 * audio.presence);
    }
    this.acc.flare += dt * PROFILE.FLARE.RATE * this.flare;
    while (this.acc.flare > 1) {
      this.acc.flare -= 1;
      this._flareBurst(drive);
    }

    // Bass (the continuo line): broad, slow pours from the lower part of the
    // canvas; rate and push follow the drive
    this.acc.bass += dt * drive * MOTION.BASS_RATE * this.stage.pours * (0.25 + audio.bass * audio.bass);
    while (this.acc.bass > 1) {
      this.acc.bass -= 1;
      const low = this.emitters.reduce((a, b) => (b.y < a.y ? b : a));
      const e = Math.random() < 0.6 ? low : anyEmitter();
      pour(e, rand(...MOTION.BASS_PUSH) * this.tune.values.bassPours * force * (0.6 + audio.bass), rand(0.004, 0.008), 1.3);
    }

    // Ambient: slow, faint pours keep the paint drifting in silence
    this.acc.ambient += dt * (0.12 + 0.2 * drive);
    if (this.acc.ambient > 1) {
      this.acc.ambient -= 1;
      pour(anyEmitter(), rand(110, 170), rand(0.004, 0.008), 2.4);
    }

    // Treble: tiny bright specks that bloom in
    this.acc.treble += dt * treble * treble * MOTION.SPECKS_RATE * this.tune.values.specks;
    while (this.acc.treble > 1) {
      this.acc.treble -= 1;
      const a = Math.random() * Math.PI * 2;
      const gilded = Math.random() < COLOUR.GOLD.FLECKS;
      this._gust({ x: rand(0.05, 0.95), y: rand(0.05, 0.95), vx: Math.cos(a) * 60, vy: Math.sin(a) * 60, amount: gilded ? 0 : rand(1.2, 2), goldAccent: gilded ? rand(1.2, 2) : 0, radius: rand(0.00005, 0.00016), duration: 0.4 });
    }

    // Cells: small fades open holes in the paint; the lacing shader then
    // outlines them in dark blue like cells in a real pour.
    this.acc.cells += dt * (0.25 + drive * (1.2 + treble * 3)) * MOTION.CELLS_RATE * this.tune.values.cells * this.feel.CELLS;
    while (this.acc.cells > 1) {
      this.acc.cells -= 1;
      const a = Math.random() * Math.PI * 2;
      const amt = rand(1.4, 2.4);
      // clusters of cells look more natural than isolated holes
      const cx = rand(0.05, 0.95);
      const cy = rand(0.05, 0.95);
      const n = 1 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) {
        this._gust({ x: cx + rand(-0.02, 0.02), y: cy + rand(-0.03, 0.03), vx: Math.cos(a) * 40, vy: Math.sin(a) * 40, fade: amt, radius: rand(0.0002, 0.0006), duration: 0.6 });
      }
    }

    // Pointer / touch dragging pours paint along the stroke (immediate by design)
    if (pointer.pressId !== this.lastPress) {
      this.lastPress = pointer.pressId;
      this.pointerJitter = (Math.random() * 2 - 1) * COLOUR.JITTER;
    }
    // slow camera: zoom in as the journey deepens, with a faint drift
    const V = PROFILE.VIEW;
    const zoom = lerp(V.ZOOM[0], V.ZOOM[1], this.journey);
    const room = Math.min(V.DRIFT, (1 - 1 / zoom) / 2);
    const ph = (this.musicTime / V.PERIOD) * Math.PI * 2;
    this.view.set(0.5 + room * Math.sin(ph), 0.5 + room * Math.cos(ph * 0.73), zoom);
    if (pointer.down && (pointer.dx || pointer.dy)) {
      // pointer -> canvas position through the zoom, so paint lands under the finger
      const vx = (pointer.dx * 6000 * (this.aspect > 1 ? this.aspect : 1)) / zoom;
      const vy = (pointer.dy * 6000) / zoom;
      this.splat(this.view.x + (pointer.x - 0.5) / zoom, this.view.y + (pointer.y - 0.5) / zoom, vx, vy, this._dye(this.pointerJitter, 0.9), 0.0028);
    }

    // Swirliness: nearly laminar when calm, mid band adds curl as the music builds
    const [curlBase, curlDrive, curlMid] = MOTION.CURL;
    const curlTarget = (curlBase + drive * (curlDrive + audio.mid * curlMid)) * this.tune.values.swirl * this.stage.swirl * this.feel.SWIRL;
    this.curlStrength += (curlTarget - this.curlStrength) * (1 - Math.exp(-dt / 1.5));
    // motion settles faster when calm, carries further when the music is up
    this.velocityDissipation = (VELOCITY_DISSIPATION.calm + (this.tune.values.damping - VELOCITY_DISSIPATION.calm) * Math.min(1, drive * 1.6)) * this.feel.DAMPING;

    const u = this.mats.display.uniforms;
    // gilded highlights swell with the music, gently
    this.sheen += (audio.presence * audio.energy - this.sheen) * (1 - Math.exp(-dt / 1.2));
    u.uSheen.value = this.sheen;
    u.uTime.value = t;
    u.uTreble.value = treble;
    u.uBeat.value = audio.beat * drive;

    this._updateGlows(dt);
    this._updateGusts(sdt);
    this._flushSplats();
    this._step(Math.min(sdt, 1 / 30));
  }

  /** Live values for the debug overlay (D). */
  get debug() {
    const [r, g, b] = this._rampColour(this.height, [0, 0, 0]);
    const hex = '#' + [r, g, b].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
    const P = this.pal;
    const toHex = (c) => '#' + c.map((v) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0')).join('');
    const sw = (c, w = 14) => `<span class="debug-swatch" style="background:${c};width:${w}px"></span>`;
    const u = this.mats.display.uniforms;
    const ground = [u.cDeep.value, u.cNavy.value].map((c) => '#' + c.getHexString());
    const palette = [0, 0.2, 0.4, 0.6, 0.8, 1].map((h) => sw(toHex(this._rampColour(h, [0, 0, 0])))).join('');
    return {
      journey: `${this.journey.toFixed(3)}  (keys ${this.journeyBase.toFixed(3)} − lift ${this.lift.toFixed(3)})${this.flare > 0.01 ? ` · flare ${this.flare.toFixed(2)}` : ''}${PROFILE.JOURNEY.FORCE >= 0 ? ' · PINNED' : ''}`,
      palette: { html: `${palette} ground ${sw(ground[0], 10)}${sw(ground[1], 10)} ${STOPS[P.lo].name}→${STOPS[P.hi].name} ${(P.f * 100).toFixed(0)}%` },
      'journey arc': { html: this._journeySvg() },
      choreography: `${this.choreo.type} (section ${this.choreo.id}) · flow ${(((this.flowAngle * 180) / Math.PI) % 360).toFixed(0)}° · zoom ${this.view.z.toFixed(3)} · repaints ${this.repaints}`,
      colour: { swatch: hex, text: `${hex}  at height ${this.height.toFixed(2)}` },
      'hue shift': `${this.hueShift >= 0 ? '+' : ''}${this.hueShift.toFixed(1)}°  (${NOTE_NAMES[this.note]})`,
      loudness: this.loud.toFixed(2),
      drive: this.drive.toFixed(2),
      'speed ×': `${this.speed.toFixed(2)} · exposure ${this.exposure.toFixed(2)}`,
      stage: `speed ${this.stage.speed.toFixed(2)} · pours ${this.stage.pours.toFixed(2)} · swirl ${this.stage.swirl.toFixed(2)}`,
      'key bursts': String(this.keyBursts),
      blooms: `${this.blooms}${this.bloom ? `  (holding ${this.bloom.held.toFixed(1)} s)` : ''}`,
    };
  }

  /**
   * The journey curve for the debug overlay: the keyframe curve over the
   * piece (light at the top, night at the bottom), keyframes as dots, the
   * playhead, and the current value (with the climax lift) as a bright dot.
   */
  _journeySvg() {
    const J = PROFILE.JOURNEY;
    const W = 200;
    const H = 44;
    const end = (this.scored && this.pieceEnd) || J.KEYS[J.KEYS.length - 1][0];
    const t = this.scored ? this.musicTime : ((this.liveClock / J.DRIFT_SECONDS) % 1) * end;
    const X = (s) => ((s / end) * W).toFixed(1);
    const Y = (j) => (2 + j * (H - 4)).toFixed(1);
    let d = '';
    for (let i = 0; i <= 120; i++) d += `${i ? 'L' : 'M'}${X((i / 120) * end)},${Y(monotone(J.KEYS, (i / 120) * end))}`;
    const keys = J.KEYS.map(([s, j]) => `<circle cx="${X(s)}" cy="${Y(j)}" r="1.8" fill="#9fc4e8"/>`).join('');
    return (
      `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="display:block;border-radius:4px;background:linear-gradient(#e8f6fb,#5d9ccc 35%,#14245a 70%,#03040e)">` +
      `<path d="${d}" fill="none" stroke="#fff" stroke-width="1.5" opacity="0.85"/>${keys}` +
      `<line x1="${X(t)}" x2="${X(t)}" y1="0" y2="${H}" stroke="#ffd23f" stroke-width="1.2"/>` +
      `<circle cx="${X(t)}" cy="${Y(this.journey)}" r="3.2" fill="#ffd23f" stroke="#000" stroke-width="0.6"/></svg>`
    );
  }

  render(target) {
    const u = this.mats.display.uniforms;
    u.uDye.value = this.dye.read.texture;
    u.uGold.value = this.gold.read.texture;
    this.pass.render(this.renderer, this.mats.display, target);
  }

  dispose() {
    this.tune?.dispose();
    this.velocity?.dispose();
    this.dye?.dispose();
    this.gold?.dispose();
    this.pressure?.dispose();
    this.divergence?.dispose();
    this.curl?.dispose();
    for (const m of Object.values(this.mats ?? {})) m.dispose();
  }
}
