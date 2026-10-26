import * as THREE from 'three';
import { SceneBase } from './SceneBase.js';
import { FullscreenPass, passMaterial } from '../gl/FullscreenPass.js';
import { DoubleTarget, createTarget } from '../gl/targets.js';
import { pointer } from '../input.js';
import { NOTE_NAMES } from '../audio.js';

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
 * leaves a small curling flourish placed by pitch height along a travelling
 * "phrase line", and the continuo bass pours in from below.
 */

// ===================================================================== config
const COLOUR = {
  // pitchHeight -> colour (sRGB), sampled with smooth monotone interpolation
  RAMP: [
    [0.0, '#2a0a4a'], // deep purple
    [0.25, '#0f2a8f'], // navy / cobalt
    [0.45, '#1a8cff'], // bright azure ...
    [0.55, '#22d3ff'], // ... into bright cyan
    [0.7, '#8ae3ff'], // light blue ...
    [0.8, '#b8f6e6'], // ... into mint
    [1.0, '#fff8dc'], // white with a hint of warm yellow (bright gold comes from the gold layer)
  ],
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
    DEEP: '#f0a01e', // rich deep gold
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
const VELOCITY_DISSIPATION = { calm: 0.85, active: 0.22 };

// Simulation clock: speed = IDLE_SPEED + MUSIC_SPEED * drive
const IDLE_SPEED = 0.1;
const MUSIC_SPEED = 1.3;
// How quickly the motion follows the music (seconds, per smoothing stage x2)
const DRIVE_RISE = 3.0;
const DRIVE_FALL = 5.0;
// drive = presence * (loudness and note density blend)
const DRIVE_FROM_ENERGY = 0.7;
const DRIVE_FROM_DENSITY = 0.3;
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

const RAMP_LUT = buildRamp(COLOUR.RAMP);

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
    this.lastFlourish = -1;
    this.phrase = Math.random(); // position of the travelling phrase line
    this.lastPitch = 0.5;
    this.acc = { bass: 0, treble: 0, cells: 0, ambient: 0 };
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
          cNavy: { value: new THREE.Color(0x0a1f4a) },
          cDeep: { value: new THREE.Color(0x030a1e) },
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
    this.height = audio.pitchHeight;
    this.loud = audio.energy;
    this.note = audio.dominantNote;
    // dominant pitch class -> small hue shift; positions on the circle of
    // fifths, so related keys get related shifts
    const fifths = (audio.dominantNote * 7) % 12;
    const target = COLOUR.HUE_SHIFT_DEG * Math.sin((fifths / 12) * Math.PI * 2) * smoothstep(0.3, 0.7, audio.noteStrength) * audio.presence;
    this.hueShift += (target - this.hueShift) * (1 - Math.exp(-dt / COLOUR.HUE_SMOOTHING));
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
    let r = lerp(RAMP_LUT[i * 3], RAMP_LUT[i * 3 + 3], f);
    let g = lerp(RAMP_LUT[i * 3 + 1], RAMP_LUT[i * 3 + 4], f);
    let b = lerp(RAMP_LUT[i * 3 + 2], RAMP_LUT[i * 3 + 5], f);
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
  _dye(jitter, amount, height = this.height) {
    const c = this._rampColour(height + jitter);
    const [L, A, B] = srgbToOklab(c[0], c[1], c[2]);
    const a = amount * lerp(COLOUR.LOUD_AMOUNT[0], COLOUR.LOUD_AMOUNT[1], this.loud);
    return [L * a, A * a, B * a, a];
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
    adv.dissipation.value.setScalar(COLOUR.DYE_DISSIPATION);
    pass.render(r, m.advection, this.dye.write);
    this.dye.swap();

    // 9. advect the gold layer
    adv.uSource.value = this.gold.read.texture;
    adv.dissipation.value.setScalar(COLOUR.GOLD.DISSIPATION);
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
  _advanceClock(dt, audio) {
    // loudness leads; note density lets busy passages swirl more than slow ones
    const target = audio.presence * Math.min(1, DRIVE_FROM_ENERGY * audio.energy + DRIVE_FROM_DENSITY * audio.density);
    const follow = (v, to, rise, fall) => v + (to - v) * (1 - Math.exp(-dt / ((to > v ? rise : fall) * 0.5)));
    this.driveStage = follow(this.driveStage, target, DRIVE_RISE, DRIVE_FALL);
    this.drive = follow(this.drive, this.driveStage, DRIVE_RISE, DRIVE_FALL);

    // dragging temporarily speeds the clock up so pouring by hand feels responsive
    this.pointerBoost = follow(this.pointerBoost, pointer.down ? 1 : 0, 0.3, 2.0);

    this.speed = IDLE_SPEED + MUSIC_SPEED * this.drive + 0.6 * this.pointerBoost;
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
      let vx = g.vx;
      let vy = g.vy;
      if (g.spin) {
        // turn the push as the pour goes on, so the paint curls like an ornament
        const a = g.spin * (a0 + a1) * 0.5;
        const c = Math.cos(a);
        const sn = Math.sin(a);
        vx = g.vx * c - g.vy * sn;
        vy = g.vx * sn + g.vy * c;
      }
      const dye = g.fade || !g.amount ? null : this._dye(g.jitter, g.amount * w);
      const gold = g.fade ? null : this._goldFor(g, w);
      this.splat(x, y, vx * k, vy * k, dye, g.radius, g.fade ? g.fade * w : 0, gold);
    }
    this.gusts = this.gusts.filter((g) => g.age < g.duration);
  }

  // -------------------------------------------------------------- update

  update(dt, audio) {
    const sdt = this._advanceClock(dt, audio);
    this.realTime += dt;
    this._updateColourState(dt, audio);
    const t = this.time;
    const drive = this.drive;
    const treble = audio.treble * drive; // sparkle only when music plays
    const force = 0.4 + 1.2 * drive; // louder = harder pours

    // Orbiting pour points (they move on the scene clock, so slowly when calm)
    for (const e of this.emitters) {
      e.phase += sdt * e.speed * 2.2;
      const r = e.radius + 0.06 * Math.sin(t * 0.21 + e.wobble);
      e.x = 0.5 + (r * Math.cos(e.phase)) / Math.max(1, this.aspect * 0.75);
      e.y = 0.5 + r * Math.sin(e.phase) * 1.15;
    }

    const pour = (e, strength, radius, duration) => {
      // swirl tangentially, with a bit of push toward the centre
      const tx = -Math.sin(e.phase) * Math.sign(e.speed);
      const ty = Math.cos(e.phase) * Math.sign(e.speed);
      const vx = (tx * 0.8 + (0.5 - e.x) * 1.2 + rand(-0.3, 0.3)) * strength;
      const vy = (ty * 0.8 + (0.5 - e.y) * 1.2 + rand(-0.3, 0.3)) * strength;
      const accent = Math.random() < COLOUR.GOLD.ACCENT_CHANCE ? rand(...COLOUR.GOLD.ACCENT_AMOUNT) : 0;
      this._gust({ emitter: e, vx, vy, amount: rand(0.7, 1.3), goldAccent: accent, radius, duration });
    };
    const anyEmitter = () => this.emitters[(Math.random() * 3) | 0];

    // Beats: extra pours that only matter once the music has built up
    if (audio.beatId !== this.lastBeat) {
      this.lastBeat = audio.beatId;
      if (Math.random() < drive * 0.8) {
        const n = 1 + (Math.random() < drive * 0.6 ? 1 : 0);
        for (let i = 0; i < n; i++) pour(anyEmitter(), rand(650, 1000) * drive * force, rand(0.004, 0.008), 0.7);
      }
    }

    // Notes: every articulated note (bow stroke, pluck, wind attack) leaves a
    // small curling flourish of paint. Flourishes are placed along a slowly
    // travelling "phrase line", at a height that follows the pitch height,
    // like ornaments written along a melody.
    this.phrase += sdt * 0.045;
    if (audio.noteId !== this.lastNote) {
      this.lastNote = audio.noteId;
      if (audio.presence > 0.3 && this.realTime - this.lastFlourish > 0.08) {
        this.lastFlourish = this.realTime;
        const pitch = audio.pitchHeight;
        const x = 0.1 + 0.8 * (this.phrase % 1) + rand(-0.06, 0.06);
        const y = 0.12 + 0.76 * pitch + rand(-0.07, 0.07);
        // melodic direction tilts the stroke: rising lines curl upward
        const rise = Math.max(-1, Math.min(1, (pitch - this.lastPitch) * 12));
        this.lastPitch = pitch;
        const a = Math.atan2(rise * 0.8, 1) + rand(-0.5, 0.5) + (Math.random() < 0.5 ? 0 : Math.PI);
        const strength = rand(220, 380) * (0.35 + 0.9 * drive);
        this._gust({
          x,
          y,
          vx: Math.cos(a) * strength,
          vy: Math.sin(a) * strength,
          amount: rand(0.35, 0.65),
          radius: rand(0.0008, 0.0022),
          duration: 0.55,
          spin: (Math.random() < 0.5 ? -1 : 1) * rand(2.5, 4.5),
        });
      }
    }

    // Bass (the continuo line): broad, slow pours from the lower part of the
    // canvas; rate and push follow the drive
    this.acc.bass += dt * drive * (0.4 + 2.6 * audio.bass * audio.bass);
    while (this.acc.bass > 1) {
      this.acc.bass -= 1;
      const low = this.emitters.reduce((a, b) => (b.y < a.y ? b : a));
      const e = Math.random() < 0.6 ? low : anyEmitter();
      pour(e, rand(380, 650) * force * (0.6 + audio.bass), rand(0.004, 0.008), 1.3);
    }

    // Ambient: slow, faint pours keep the paint drifting in silence
    this.acc.ambient += dt * (0.12 + 0.2 * drive);
    if (this.acc.ambient > 1) {
      this.acc.ambient -= 1;
      pour(anyEmitter(), rand(110, 170), rand(0.004, 0.008), 2.4);
    }

    // Treble: tiny bright specks that bloom in
    this.acc.treble += dt * treble * treble * 16;
    while (this.acc.treble > 1) {
      this.acc.treble -= 1;
      const a = Math.random() * Math.PI * 2;
      const gilded = Math.random() < COLOUR.GOLD.FLECKS;
      this._gust({ x: rand(0.05, 0.95), y: rand(0.05, 0.95), vx: Math.cos(a) * 60, vy: Math.sin(a) * 60, amount: gilded ? 0 : rand(1.2, 2), goldAccent: gilded ? rand(1.2, 2) : 0, radius: rand(0.00005, 0.00016), duration: 0.4 });
    }

    // Cells: small fades open holes in the paint; the lacing shader then
    // outlines them in dark blue like cells in a real pour.
    this.acc.cells += dt * (0.25 + drive * (1.2 + treble * 3));
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
    if (pointer.down && (pointer.dx || pointer.dy)) {
      const vx = pointer.dx * 6000 * (this.aspect > 1 ? this.aspect : 1);
      const vy = pointer.dy * 6000;
      this.splat(pointer.x, pointer.y, vx, vy, this._dye(this.pointerJitter, 0.9), 0.0028);
    }

    // Swirliness: nearly laminar when calm, mid band adds curl as the music builds
    const curlTarget = 1.5 + drive * (5 + audio.mid * 22);
    this.curlStrength += (curlTarget - this.curlStrength) * (1 - Math.exp(-dt / 1.5));
    // motion settles faster when calm, carries further when the music is up
    this.velocityDissipation = VELOCITY_DISSIPATION.calm + (VELOCITY_DISSIPATION.active - VELOCITY_DISSIPATION.calm) * Math.min(1, drive * 1.6);

    const u = this.mats.display.uniforms;
    // gilded highlights swell with the music, gently
    this.sheen += (audio.presence * audio.energy - this.sheen) * (1 - Math.exp(-dt / 1.2));
    u.uSheen.value = this.sheen;
    u.uTime.value = t;
    u.uTreble.value = treble;
    u.uBeat.value = audio.beat * drive;

    this._updateGusts(sdt);
    this._flushSplats();
    this._step(Math.min(sdt, 1 / 30));
  }

  /** Live values for the debug overlay (D). */
  get debug() {
    const [r, g, b] = this._rampColour(this.height, [0, 0, 0]);
    const hex = '#' + [r, g, b].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
    return {
      colour: { swatch: hex, text: `${hex}  at height ${this.height.toFixed(2)}` },
      'hue shift': `${this.hueShift >= 0 ? '+' : ''}${this.hueShift.toFixed(1)}°  (${NOTE_NAMES[this.note]})`,
      loudness: this.loud.toFixed(2),
      drive: this.drive.toFixed(2),
      'speed ×': this.speed.toFixed(2),
    };
  }

  render(target) {
    const u = this.mats.display.uniforms;
    u.uDye.value = this.dye.read.texture;
    u.uGold.value = this.gold.read.texture;
    this.pass.render(this.renderer, this.mats.display, target);
  }

  dispose() {
    this.velocity?.dispose();
    this.dye?.dispose();
    this.gold?.dispose();
    this.pressure?.dispose();
    this.divergence?.dispose();
    this.curl?.dispose();
    for (const m of Object.values(this.mats ?? {})) m.dispose();
  }
}
