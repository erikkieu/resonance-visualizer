import * as THREE from 'three';
import { SceneBase } from './SceneBase.js';
import { FullscreenPass, passMaterial } from '../gl/FullscreenPass.js';
import { createTarget } from '../gl/targets.js';
import { Bloom } from '../gl/Bloom.js';
import { createTunePanel, configParams, bindConfig } from '../tune.js';
import { SCORE_CONFIG } from '../scoreMap.js';
import { PROFILE, TUNE } from './profiles/standchen.js';

import noiseGLSL from '../shaders/common/noise.glsl?raw';
import commonGLSL from '../shaders/aurora/common.glsl?raw';
import auroraFrag from '../shaders/aurora/aurora.frag?raw';
import landscapeFrag from '../shaders/aurora/landscape.frag?raw';
import terrainFrag from '../shaders/aurora/terrain.frag?raw';
import ambientFrag from '../shaders/aurora/ambient.frag?raw';
import curtainsFrag from '../shaders/aurora/curtains.frag?raw';

/**
 * Scene 2: Aurora borealis over a fjord, performing the Schubert/Liszt
 * "Ständchen" (solo piano: near-silent opening, one big climax, long fade).
 *
 *   terrain.frag    static mountains + Milky Way, baked once per resize
 *   curtains.frag   per-frame lookup table of curtain shapes (4096 x 3)
 *   aurora.frag     low-res sliced volume of curtain sheets (HDR)
 *   ambient.frag    1x1 average of the aurora, used as scene lighting
 *   landscape.frag  sky, stars, snowy mountains, rippled reflection, rocks
 *   Bloom           soft glow on the curtains and their reflection
 *
 * Audio arrives through audio.perf (scoreMap.js), performed by
 * profiles/standchen.js: a smoothed `build` grows the curtains in
 * height, width, coverage and brightness, sections set the state (slow, low
 * ripples in quiet passages, a warm flare at the climax), and accented
 * onsets send a soft shimmer through the rays. Bass still swells the
 * curtains, mid sets the fold frequency, treble the fine rays and twinkle.
 *
 * The aurora is two layers of travelling waves (PROFILE.AURORA), one per
 * voice of the music (audio.perf.voices, src/voices.js). Every note spawns
 * a packet: a soft swell that runs across the sky along its layer's
 * curtains, widening and fading, then leaves off the far side. The LOW
 * layer (bass notes and low chord changes) sends broad, slow, green swells
 * left -> right along the far curtains; the MELODY layer narrower, brighter,
 * faster swells right -> left along the near ones, higher in the sky and
 * further along its teal -> violet -> pink ramp for higher notes. Score
 * notes are announced ahead, so each packet's fade-in peaks on its note.
 * Amplitude (the anticipating drive, the climax and the section stage)
 * scales the speed, size and brightness of every wave. The light is laid
 * on as brush strokes (landscape.frag, AURORA.PAINT), and a soft per-pixel
 * cap keeps the climax from washing out the scene.
 * Over the whole piece the night moves on (PROFILE.NIGHT): `night` and
 * `dawn` follow a keyframe timeline at the playhead, from late dusk through
 * the deepest night at the climax toward the first light of dawn, and set the
 * sky, horizon glow, stars, Milky Way, water and the aurora's strength.
 * Noise reduction (AURORA.NOISE): every audio value feeding the aurora is
 * smoothed through a soft dead-band, the slice jitter is a fixed pattern,
 * the rays are long, low-contrast and advected along the curtains, the
 * aurora layer gets a stable tent blur and the final dither is fixed and
 * under 1/255. N toggles the previous look for comparison.
 * The look follows public/textures/aurora-reference-2.jpg (PROFILE.LOOK), a
 * long exposure looking up into a big green aurora over a calm fjord: the
 * curtains are drawn in perspective around a vanishing point near the top
 * (aurora.frag), folding and looping, as soft long-exposure rays over a
 * teal-grey sky with a green airglow and a few hundred stars; faint cool
 * cloud wisps (C), a low band of snowy mountains rim-lit green, and dark
 * green water holding a smeared reflection. The longship (B) is hidden by
 * default. LOOK colours are given as seen: seen() inverts the tone curve.
 * On top, the vivid version (LOOK.PALETTE.vivid, V toggles the muted one):
 * up to 6 ribbons (LOOK.RIBBONS) in emerald, turquoise, blue, violet and a
 * magenta fringe, 3 when quiet and 6 when loud, with HDR cores rolled off by
 * the composite's hue-keeping 'soft' tone curve; and a strong mirror of the
 * sky in the water (LOOK.WATER, R toggles it) with ripple rings on onsets.
 * More alive (PROFILE.ALIVE, _updateAlive): loudness becomes an intensity
 * x (the anticipating drive normalised to the piece, soft knee, ^1.6) that
 * widens every mapping (brightness, ribbon height and spread, saturation,
 * hue range, movement), scaled by a global REACTIVITY ([ ] and a slider in
 * the debug overlay). Every melody note kicks the brightness (peaking on
 * the note) and sends a bright pulse along its wave; strong low notes swell
 * and lift the big lower ribbons; accents (the strongest fifth of the
 * onsets) lift a glow and ripple the water. Each section's role sets an
 * energy state (movement, ribbon count, brightness ceiling, colour range).
 * One clock drives every motion: time += dt × speed (0.45x quiet .. ~3x at
 * the climax, from loudness and its momentum). With a score the speed is
 * computed for the whole piece and integrated in advance, so the clock is a
 * function of the playhead (a seek lands on the same sky, never a jump).
 * The ribbons sway, billow, travel and cross, the curtain system turns to
 * and fro around the vanishing point, the loop forms and unravels, the rays
 * fan open, the stars wheel slowly around a pole and the cloud wisps drift.
 * Mist and low clouds (PROFILE.MIST, landscape.frag) roll along the horizon
 * in 4 depth layers on the same clock, lit from above by the aurora.
 * Keys: R reflection, V vivid / muted palette, M mist, [ ] reactivity.
 * Keys: A fades the whole aurora out and in, L the low layer, K the melody
 * layer, N clean / previous look, C clouds, B the ship.
 */

const AU = PROFILE.AURORA;
// ramp stops as linear light at full intensity (brightest channel = 1): the ramp sets the hue,
// the curtain sets the brightness, like the original HDR aurora colours (a plain hex is far dimmer)
const hexToLinear = (hex) => {
  const c = new THREE.Color(hex); // THREE.Color stores linear (colour management on)
  return c.multiplyScalar(1 / Math.max(c.r, c.g, c.b, 1e-4));
};
// a ramp as RAMP_STOPS (6) linear colours + positions, the unused stops repeating the last
const rampStops = (ramp) => {
  const r = Array.from({ length: 6 }, (_, i) => ramp[Math.min(i, ramp.length - 1)]);
  return { colors: r.map(([, hex]) => hexToLinear(hex)), at: r.map(([at], i) => (i < ramp.length ? at : 1 + i * 1e-3)) };
};
const LAYERS = ['melody', 'low']; // packet slots 0-11 and 12-23 in curtains.frag
const SLOTS = 12;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

const NI = PROFILE.NIGHT;
const LK = PROFILE.LOOK;
// sRGB hex -> linear RGB (unnormalised, for scene colours)
const lin = (hex) => {
  const c = new THREE.Color(hex);
  return new THREE.Vector3(c.r, c.g, c.b);
};
// sRGB hex as seen on screen -> the scene-linear colour the composite's ACES (exposure 1)
// turns back into it (fixed-point iteration through the same curve; cached per hex)
const ACES_IN = [0.59719, 0.076, 0.0284, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777];
const ACES_OUT = [1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602];
const mat3 = (m, v) => [0, 1, 2].map((r) => m[r] * v[0] + m[r + 3] * v[1] + m[r + 6] * v[2]); // column-major, as in GLSL
const rrt = (v) => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
const aces = (c) => mat3(ACES_OUT, mat3(ACES_IN, c).map(rrt)).map((x) => Math.min(1, Math.max(0, x)));
const seenCache = new Map();
const seen = (hex) => {
  if (!seenCache.has(hex)) {
    const l = lin(hex);
    const target = [l.x, l.y, l.z];
    let c = target.map((x) => x * 3);
    for (let i = 0; i < 120; i++) {
      const o = aces(c);
      c = c.map((x, j) => Math.max(0, x * Math.sqrt(target[j] / Math.max(o[j], 1e-5))));
    }
    seenCache.set(hex, new THREE.Vector3(...c));
  }
  return seenCache.get(hex).clone();
};

/**
 * Monotone cubic (Fritsch-Carlson) through the keyframes: smooth, and never
 * overshooting between two keys. Returns (t) -> value, held flat outside.
 */
function monotone(xs, ys) {
  const n = xs.length;
  const d = xs.slice(1).map((x, i) => (ys[i + 1] - ys[i]) / (x - xs[i]));
  const m = xs.map((_, i) => (i === 0 ? d[0] : i === n - 1 ? d[n - 2] : d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2));
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      m[i] = (3 * a * d[i]) / Math.sqrt(s);
      m[i + 1] = (3 * b * d[i]) / Math.sqrt(s);
    }
  }
  return (t) => {
    if (t <= xs[0]) return ys[0];
    if (t >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (t > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i];
    const u = (t - xs[i]) / h;
    const u2 = u * u;
    const u3 = u2 * u;
    return (2 * u3 - 3 * u2 + 1) * ys[i] + (u3 - 2 * u2 + u) * h * m[i] + (-2 * u3 + 3 * u2) * ys[i + 1] + (u3 - u2) * h * m[i + 1];
  };
}

const SHAPE_KEYS = ['height', 'width', 'cover', 'bright', 'fold'];
const lerp = (a, b, x) => a + (b - a) * x;

const AL = PROFILE.ALIVE;
const MI = PROFILE.MIST;
// a [quiet, loud] range at x, widened by the reactivity r around its geometric middle
const react = ([a, b], x, r) => {
  const m = Math.sqrt(a * b);
  return m * ((a + (b - a) * x) / m) ** r;
};
const smooth01 = (x) => {
  const f = clamp01(x);
  return f * f * (3 - 2 * f);
};
// a section's role when there is no score (the live stage)
const ROLE_OF_STAGE = { calm: 'release', building: 'build', climax: 'climax', resolving: 'release' };
const SECTION_KEYS = ['MOVE', 'RIBBONS', 'BRIGHT', 'COLOUR'];
/** The energy state of a section `role`, cross-fading (0..1) into `next`'s. */
function sectionMix(role, next, cross, out = {}) {
  const S = AL.SECTIONS;
  const a = S[role] ?? S.build;
  const b = S[next] ?? a;
  for (const k of SECTION_KEYS) out[k] = lerp(a[k], b[k], cross);
  return out;
}
/** One step of the speed multiplier: the smoothed intensity, its momentum, the section's movement. */
function speedStep(s, x, move, dt, r) {
  const S = AL.SPEED;
  const prev = s.xs;
  s.xs += (x - s.xs) * (1 - Math.exp(-dt / (x > s.xs ? S.ATTACK : S.RELEASE)));
  s.mom += (Math.max(0, (s.xs - prev) / dt) - s.mom) * (1 - Math.exp(-dt / S.MOMENTUM_TIME));
  const v = react(S.RANGE, s.xs, r) * move * (1 + S.MOMENTUM * s.mom);
  // a soft ceiling: faster still means faster, so the climax stays the fastest moment
  const [lo, hi] = S.LIMIT;
  return v <= lo ? lo : lo + (hi - lo) * (1 - Math.exp(-(v - lo) / (hi - lo)));
}

// aurora pass resolution (fraction of the scene target)
const AURORA = [{ scale: 0.4 }, { scale: 0.36 }, { scale: 0.32 }, { scale: 0.28 }];

export default class Scene2Aurora extends SceneBase {
  constructor() {
    super({ baseSpeed: 0.35, speedGain: 1.5 });
    this.renderScale = 0.8;
    this.toneMapped = true;
    this.exposure = 1.15;
    this.surge = 0;
    this.shimmer = 0;
    this.lastBeat = -1;
    // performance state (profiles/standchen.js)
    this.stage = { ...PROFILE.STAGES.calm };
    this.build = 0;
    this.climax = 0;
    this.speed = 0.5;
    this.shape = { height: 1, width: 1, cover: 0.5, bright: 1, fold: 1, warm: 0 };
    this.jumpId = -1;
    // the night progression (PROFILE.NIGHT)
    this.night = NI.KEYS[0][1];
    this.dawn = NI.KEYS[0][2];
    this.nightSource = 'loop';
    // the two-layer wave aurora (PROFILE.AURORA)
    this.amp = 0;
    this.keyBias = 0;
    this.realTime = 0;
    this.nextId = 1;
    this.seed = 0x2f6e2b1;
    const layer = () => ({ packets: [], pending: [], lastSpawn: -1e9, spawned: 0, heard: 0, hue: 0.4, rot: 0, rotTarget: 0, on: 1, onTarget: 1 });
    this.layers = { low: layer(), melody: layer() };
    // noise reduction (AURORA.NOISE; N toggles the previous look)
    this.clean = AU.NOISE.CLEAN;
    this.smooth = { bass: 0, mid: 0, treble: 0, energy: 0, surge: 0 };
    this.rowHue = { melody: 0.4, low: 0.4 };
    this.jitterIn = 0; // mean per-frame change of the raw audio values (debug)
    this.jitterOut = 0; // ... of what the aurora gets
    this.hideStars = false; // verify: measure the aurora alone
    // the look (PROFILE.LOOK): C toggles the clouds, B the ship (0.4 s fades)
    this.cloudsOn = LK.CLOUDS.ON ? 1 : 0;
    this.cloudsTarget = this.cloudsOn;
    this.shipOn = LK.SHIP.ON ? 1 : 0;
    this.shipTarget = this.shipOn;
    // the vivid version: V palette, R reflection (fades), onset rings on the water
    this.vivid = LK.PALETTE.VIVID;
    this.reflectOn = LK.WATER.ON ? 1 : 0;
    this.reflectTarget = this.reflectOn;
    this.rings = []; // { x, z (water plane), age, amp }
    this.lastRing = -1e9;
    this.ribbonShow = LK.RIBBONS.map(() => 0);
    this.melGlow = 0; // melody activity, smoothed (ship lights)
    this.rippleKick = 0; // strong melody notes -> extra rings
    this.on = 1; // A toggles the aurora, L and K one layer each
    this.onTarget = 1;
    // more alive (PROFILE.ALIVE): intensity, section state, the clock, kicks, swells, accents
    this.alive = {
      x: 0, // intensity 0..1
      sec: sectionMix('release', 'release', 0),
      map: null, // the analysis the percentiles and the clock curve belong to
      quiet: 0, // level percentiles (sCurve space) of the piece
      loud: 1,
      accentAt: 1, // onset strength of the strongest SHARE
      curve: null, // { sig, rate, speed: Float32Array, clock: Float64Array }
      offset: 0, // clock offset: paused time, retuning
      live: { xs: 0, mom: 0 }, // the live speed integrator
      clock: 0,
      speed: AL.SPEED.RANGE[0],
      bright: 1, // the aurora's music gain (debug, verify)
      kick: { hold: 0, v: 0, last: -1e9 },
      swell: { hold: 0, v: 0, last: -1e9 },
      glow: { hold: 0, v: 0, last: -1e9 },
      queue: [], // scheduled { at (realTime), kind, s }
      lastAccentT: -1,
      accentRing: 0, // an accent fired this frame (strength) -> a ring on the water
      hue: 0, // melody pitch -> ribbon hue shift (ramp units)
    };
    this.mistOn = MI.ON ? 1 : 0;
    this.mistTarget = this.mistOn;
    this.debugControls = [{ label: 'reactivity', min: 0.5, max: 3, step: 0.05, get: () => AL.REACTIVITY, set: (v) => (AL.REACTIVITY = v) }];
    this._onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target instanceof HTMLInputElement && e.target.type !== 'range') return;
      const k = e.key.toLowerCase();
      if (k === '[' || k === ']') AL.REACTIVITY = Math.round(Math.min(3, Math.max(0.5, AL.REACTIVITY + (k === ']' ? 0.1 : -0.1))) * 100) / 100;
      if (k === 'm') this.mistTarget = this.mistTarget > 0 ? 0 : 1;
      if (k === 'a') this.onTarget = this.onTarget > 0 ? 0 : 1;
      if (k === 'n') this.clean = !this.clean;
      if (k === 'c') this.cloudsTarget = this.cloudsTarget > 0 ? 0 : 1;
      if (k === 'b') this.shipTarget = this.shipTarget > 0 ? 0 : 1;
      if (k === 'r') this.reflectTarget = this.reflectTarget > 0 ? 0 : 1;
      if (k === 'v') {
        this.vivid = !this.vivid;
        this._writeRamps();
      }
      const l = k === 'l' ? this.layers.low : k === 'k' ? this.layers.melody : null;
      if (l) l.onTarget = l.onTarget > 0 ? 0 : 1;
    };
    window.addEventListener('keydown', this._onKey);
  }

  async init(renderer) {
    await super.init(renderer);
    this.pass = new FullscreenPass();
    this.shared = {
      uAspect: { value: 16 / 9 },
      uTime: { value: 0 },
      uBass: { value: 0 },
      uMid: { value: 0 },
      uTreble: { value: 0 },
      uEnergy: { value: 0 },
      uSurge: { value: 0 },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uHeight: { value: 1 },
      uWidth: { value: 1 },
      uCover: { value: 0.5 },
      uFold: { value: 1 },
      uBright: { value: 1 },
      uWarm: { value: 0 },
      // the wave aurora
      uTopScale: { value: 1.6 },
      // the night progression
      uNight: { value: 0.15 },
      uDawn: { value: 0 },
    };
    // the tallest a curtain can get: base height + a full packet's lift (+ the melody's pitch height)
    const tall = (L) => (L.HEIGHT + 1.2 * (L.LIFT + (L.HEIGHT_PITCH ?? 0)) * AU.SCALE.SIZE[1]) * AU.SCALE.HEIGHT[1];
    // (× the loudest ribbon height ALIVE can ask for, and a swell)
    this.shared.uTopScale.value = Math.max(tall(AU.LOW), tall(AU.MELODY)) * react(AL.RANGE.HEIGHT, 1, 3) * (1 + AL.SWELL.GROW);
    const prefix = noiseGLSL + commonGLSL;
    this.auroraMat = passMaterial({
      fragmentShader: prefix + auroraFrag,
      uniforms: {
        ...this.shared,
        tCurtains: { value: null },
        uRampMel: { value: [] },
        uRampMelAt: { value: [] },
        uRampLow: { value: [] },
        uRampLowAt: { value: [] },
        uHueRot: { value: new THREE.Vector4() },
        uCrest: { value: AU.CREST },
        uScreen: { value: 0 },
        uCap: { value: AU.CAP },
        uOn: { value: 1 },
        // the curtains in perspective (LOOK.CURTAINS, LOOK.RAYS; set in _writeLook)
        uRowZ: { value: new THREE.Vector4(...LK.RAYS.DEPTH) },
        uRib: { value: Array.from({ length: 6 }, () => new THREE.Vector4()) },
        uRib2: { value: Array.from({ length: 6 }, () => new THREE.Vector4()) },
        uRib3: { value: Array.from({ length: 6 }, () => new THREE.Vector4()) },
        uColour: { value: new THREE.Vector4() },
        uCore: { value: new THREE.Color() },
        uFringe: { value: new THREE.Color() },
        uVp: { value: new THREE.Vector4() },
        uCurl: { value: new THREE.Vector4() },
        uBillow: { value: new THREE.Vector4() },
        uRays: { value: new THREE.Vector4() },
        uTex: { value: new THREE.Vector4() },
        uGlowShape: { value: new THREE.Vector4() },
        uMove: { value: new THREE.Vector4() },
      },
    });
    this.landMat = passMaterial({
      fragmentShader: prefix + landscapeFrag,
      uniforms: { ...this.shared, tAurora: { value: null }, tTerrain: { value: null }, tAmbient: { value: null }, uPaint: { value: new THREE.Vector4() }, uPaint2: { value: new THREE.Vector4() }, uAuroraBlur: { value: new THREE.Vector2(2.5, 0) }, ...this._nightUniforms(), ...this._lookUniforms() },
    });
    this.terrainMat = passMaterial({ fragmentShader: prefix + terrainFrag, uniforms: { ...this.shared } });
    this.ambientMat = passMaterial({ fragmentShader: ambientFrag, uniforms: { tAurora: { value: null } } });
    this.ambientTarget = createTarget(1, 1);
    this.curtainMat = passMaterial({
      fragmentShader: prefix + curtainsFrag,
      uniforms: {
        ...this.shared,
        uPacket: { value: Array.from({ length: 2 * SLOTS }, () => new THREE.Vector4()) },
        uPacketShape: { value: Array.from({ length: 2 * SLOTS }, () => new THREE.Vector4()) },
        uRowHeight: { value: new THREE.Vector4() },
        uRowHue: { value: new THREE.Vector4() },
        uRowBright: { value: new THREE.Vector4() },
        uRowBend: { value: new THREE.Vector4() },
        uRowCurve: { value: new THREE.Vector4() },
        uRowStria: { value: new THREE.Vector4() },
        uGlow: { value: 0 },
        uRay: { value: new THREE.Vector4(1, 1, 0.55, 0.25) },
        uRowZ: { value: new THREE.Vector4(...LK.RAYS.DEPTH) },
      },
    });
    this._writeRamps();
    this.curtainTarget = createTarget(4096, 4);
    this.auroraMat.uniforms.tCurtains.value = this.curtainTarget.texture;
    this.bloom = new Bloom({ levels: 5, threshold: LK.GRADE.BLOOM.THRESHOLD, knee: 0.3, strength: LK.GRADE.BLOOM.STRENGTH, radius: 1.0 });
    await this.pass.compile(renderer, [this.auroraMat, this.landMat, this.terrainMat, this.ambientMat, this.curtainMat]);
    this.tune = createTunePanel({ title: 'Aurora · Ständchen', storageKey: 'resonance.tune.aurora', params: configParams(PROFILE, TUNE), onChange: bindConfig(PROFILE) });
  }

  resize(width, height) {
    super.resize(width, height);
    this.shared.uAspect.value = width / height;
    this.shared.uResolution.value.set(width, height);
    const q = AURORA[this.quality] ?? AURORA[0];
    const aw = Math.max(32, Math.round(width * q.scale));
    const ah = Math.max(18, Math.round(height * q.scale));
    if (!this.auroraTarget) this.auroraTarget = createTarget(aw, ah);
    else this.auroraTarget.setSize(aw, ah);
    this.landMat.uniforms.tAurora.value = this.auroraTarget.texture;
    this.ambientMat.uniforms.tAurora.value = this.auroraTarget.texture;
    this.landMat.uniforms.tAmbient.value = this.ambientTarget.texture;

    // static terrain is baked once per size (nearest filtering keeps material ids exact)
    const terrainOpts = { type: THREE.UnsignedByteType, filter: THREE.NearestFilter };
    if (!this.terrainTarget) this.terrainTarget = createTarget(width, height, terrainOpts);
    else this.terrainTarget.setSize(width, height);
    this.pass.render(this.renderer, this.terrainMat, this.terrainTarget);
    this.landMat.uniforms.tTerrain.value = this.terrainTarget.texture;

    if (!this.sceneTarget) this.sceneTarget = createTarget(width, height);
    else this.sceneTarget.setSize(width, height);
    this.bloom.setSize(width, height);
  }

  setQuality(level) {
    super.setQuality(level);
    if (this.width > 1) this.resize(this.width, this.height);
  }

  update(dt, audio) {
    const P = PROFILE;
    const perf = audio.perf;
    this.perf = perf;
    this.perfVoices = perf.voices;
    const presence = audio.presence;
    const follow = (v, to, tau) => v + (to - v) * (1 - Math.exp(-dt / tau));
    const jumped = perf.jumpId !== this.jumpId; // a seek: settle into the new moment at once
    this.jumpId = perf.jumpId;

    // --- section state, blending into the next one ahead of the change
    const now = P.STAGES[perf.stage] ?? P.STAGES.calm;
    const next = perf.next ? P.STAGES[perf.next.stage] ?? now : now;
    const x = perf.next ? Math.min(1, Math.max(0, 1 - perf.timeToNext / SCORE_CONFIG.LOOKAHEAD)) : 0;
    const cross = x * x * (3 - 2 * x);
    for (const k of Object.keys(this.stage)) {
      const target = lerp(now[k], next[k], cross);
      this.stage[k] = jumped ? target : follow(this.stage[k], target, P.STAGE_BLEND / 3);
    }
    const st = this.stage;

    // --- build and climax
    const B = P.BUILD;
    const buildTarget = presence * Math.pow(perf.drive, B.CURVE);
    this.build = jumped ? buildTarget : follow(this.build, buildTarget, buildTarget > this.build ? B.ATTACK : B.RELEASE);
    this.climax = jumped ? perf.climax * presence : follow(this.climax, perf.climax * presence, 1.0);

    // --- aurora amplitude: the anticipating build, the climax and the section stage (never blank while music plays)
    const M = AU.AMP;
    const stageAmp = lerp(M.STAGE[perf.stage] ?? M.STAGE.building, M.STAGE[perf.next?.stage] ?? M.STAGE[perf.stage] ?? M.STAGE.building, cross);
    const ampTarget = presence * Math.min(1, M.FLOOR + (M.BUILD * this.build + M.CLIMAX * Math.pow(this.climax, M.CLIMAX_CURVE)) * stageAmp);
    this.amp = jumped ? ampTarget : follow(this.amp, ampTarget, ampTarget > this.amp ? M.ATTACK : M.RELEASE);
    const W = AU.SCALE;
    const wave = (range) => lerp(1, lerp(range[0], range[1], this.amp), presence); // idle: the plain look

    // --- more alive: intensity, section state, kicks; the clock (0.45x quiet .. ~3x at the climax,
    // a function of the playhead with a score, so a seek never makes it jump)
    this._updateAlive(dt, audio, perf, presence, jumped);
    const al = this.alive;
    this.speed = al.speed;
    this.time = al.clock;

    // --- curtain shape and light: lerp(QUIET, FULL, build) x stage + CLIMAX x climax (idle: the plain look)
    const plain = { height: 1, width: 1, cover: 0.5, bright: 1, fold: 1 };
    for (const k of SHAPE_KEYS) {
      const c = P[k.toUpperCase()];
      this.shape[k] = lerp(plain[k], lerp(c.QUIET, c.FULL, this.build) * st[k] + c.CLIMAX * this.climax, presence);
    }
    this.shape.warm = lerp(0, lerp(P.WARM.QUIET, P.WARM.FULL, this.build) + P.WARM.CLIMAX * this.climax, presence);
    // brightness: the intensity's range × the section's ceiling, lifted by the note kicks and the accent glow
    const R = AL.REACTIVITY;
    al.gain = react(AL.RANGE.BRIGHT, al.x, R) * al.sec.BRIGHT * (1 + al.kick.v + al.glow.v);
    this.shape.bright = lerp(1, al.gain, presence);
    al.move = react(AL.RANGE.MOVE, al.x, R) * al.sec.MOVE;
    this.shape.fold *= wave(W.FOLD) * AL.MOTION.FOLD * al.move;
    this.exposure = lerp(1.15, lerp(P.EXPOSURE.QUIET, P.EXPOSURE.FULL, this.build) + P.EXPOSURE.CLIMAX * this.climax, presence);

    // --- accents: a soft shimmer and colour surge (live: the old beat surge)
    const A = P.ACCENT;
    if (perf.source === 'score') {
      for (const o of perf.onsets) {
        if (!o.accent || o.strength < A.MIN_STRENGTH) continue;
        this.shimmer = Math.min(1, this.shimmer + A.SHIMMER * o.strength);
        this.surge = Math.min(1, this.surge + A.SURGE * o.strength);
      }
      this.lastBeat = audio.beatId;
    } else if (audio.beatId !== this.lastBeat) {
      this.lastBeat = audio.beatId;
      this.surge = Math.min(1, this.surge + 0.55 + 0.4 * audio.energy);
    }
    const decay = perf.source === 'score' ? A.DECAY : 1 / 2.2;
    this.surge *= Math.exp(-dt / decay);
    this.shimmer *= Math.exp(-dt / decay);

    this.realTime += dt;
    this._updateNight(dt, perf, jumped);
    this._updateWaves(dt, perf, presence, jumped);
    this.on = follow(this.on, this.onTarget, 0.25);
    this._writeAurora(wave(W.HEIGHT) * lerp(1, react(AL.RANGE.HEIGHT, al.x, R), presence), dt, jumped);
    this._writeNoise();
    this._writeLook(dt, perf);

    const s = this.shared;
    const sm = this._smoothAudio(dt, audio, jumped);
    s.uTime.value = this.time;
    s.uBass.value = sm.bass;
    s.uMid.value = sm.mid;
    s.uTreble.value = sm.treble;
    s.uEnergy.value = sm.energy;
    s.uSurge.value = sm.surge;
    s.uHeight.value = this.shape.height;
    s.uWidth.value = this.shape.width;
    s.uCover.value = this.shape.cover;
    s.uFold.value = this.shape.fold;
    s.uBright.value = this.shape.bright;
    s.uWarm.value = this.shape.warm;
  }

  // ------------------------------------------------------------ more alive (PROFILE.ALIVE)

  /** Loudness (the drive, sCurve space) -> intensity 0..1: normalised to the piece, a soft knee, ^CURVE. */
  _intensity(drive) {
    const L = AL.LEVEL;
    const a = this.alive;
    const [lo, hi] = a.map ? [a.quiet, a.loud] : L.LIVE;
    const v = (drive - lo) / Math.max(1e-3, hi - lo);
    const k = L.KNEE;
    const knee = v >= k ? v : v <= -k ? 0 : (v + k) ** 2 / (4 * k);
    return clamp01(knee) ** L.CURVE;
  }

  /** A new analysis: the level percentiles, the accent threshold, and (lazily) the clock curve. */
  _prepareMap(map) {
    const a = this.alive;
    a.map = map;
    a.curve = null;
    if (!map) return;
    const sc = SCORE_CONFIG.S_CURVE;
    const s = Float32Array.from(map.level, (x) => {
      const p = clamp01(x) ** sc;
      return p / (p + (1 - clamp01(x)) ** sc);
    }).sort();
    const pct = (q) => s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))];
    a.quiet = pct(AL.LEVEL.QUIET);
    a.loud = Math.max(a.quiet + 0.05, pct(AL.LEVEL.LOUD));
    const st = map.onsets.map((o) => o.strength).sort((x, y) => x - y);
    a.accentAt = st.length ? st[Math.floor((1 - AL.ACCENT.SHARE) * (st.length - 1))] : AL.ACCENT.LIVE_STRENGTH;
  }

  /**
   * The speed multiplier over the whole piece and its integral (the clock), at the analysis frame
   * rate: the same drive the score follower computes (look-ahead, attack / release), the same
   * intensity, section states and speed step as live. Rebuilt when a setting it depends on changes;
   * the clock offset then absorbs the difference at the playhead, so a retune never jumps.
   */
  _clockCurve(t) {
    const a = this.alive;
    const map = a.map;
    const sig = JSON.stringify([AL.REACTIVITY, AL.LEVEL, AL.SPEED, AL.RANGE.MOVE, AL.SECTIONS, AL.SECTION_BLEND]);
    if (a.curve?.sig === sig) return a.curve;
    const C = SCORE_CONFIG;
    const rate = map.rate;
    const n = map.level.length;
    const dt = 1 / rate;
    const sCurve = (x) => {
      const p = clamp01(x) ** C.S_CURVE;
      return p / (p + (1 - clamp01(x)) ** C.S_CURVE);
    };
    const speed = new Float32Array(n);
    const clock = new Float64Array(n);
    const s = { xs: 0, mom: 0 };
    const sec = {};
    const blend = {};
    let drive = 0;
    let si = 0;
    const L = C.LOOKAHEAD;
    for (let i = 0; i < n; i++) {
      const tt = i * dt;
      const ahead = map.maxAhead(map.level, tt, tt + L, (d) => 1 - (1 - C.DRIVE.AHEAD_WEIGHT) * (d / L) - 0.25 * (d / L) ** 2);
      const target = Math.max(sCurve(map.level[i]), sCurve(ahead));
      drive = i === 0 ? target : drive + (target - drive) * (1 - Math.exp(-dt / (target > drive ? C.DRIVE.ATTACK : C.DRIVE.RELEASE)));
      while (si < map.sections.length - 1 && tt >= map.sections[si + 1].start) si++;
      const cur = map.sections[si];
      const next = map.sections[si + 1];
      sectionMix(cur.role, next?.role, next ? smooth01(1 - (next.start - tt) / L) : 0, sec);
      for (const k of SECTION_KEYS) blend[k] = i === 0 ? sec[k] : blend[k] + (sec[k] - blend[k]) * (1 - Math.exp(-dt / (AL.SECTION_BLEND / 3)));
      speed[i] = speedStep(s, this._intensity(drive), blend.MOVE, dt, AL.REACTIVITY);
      clock[i] = i === 0 ? 0 : clock[i - 1] + 0.5 * (speed[i] + speed[i - 1]) * dt;
    }
    const old = a.curve;
    a.curve = { sig, rate, speed, clock };
    if (old) a.offset += this._sampleCurve(old.clock, old.rate, t) - this._sampleCurve(clock, rate, t);
    return a.curve;
  }

  _sampleCurve(arr, rate, t) {
    const x = Math.max(0, t * rate);
    const i = Math.floor(x);
    if (i >= arr.length - 1) return arr[arr.length - 1];
    return arr[i] + (arr[i + 1] - arr[i]) * (x - i);
  }

  /**
   * The music -> intensity x, the section's energy state, the clock, and the
   * scheduled reactions: melody notes kick the brightness, strong low notes
   * swell the lower ribbons, accents lift a glow and ripple the water. Score
   * notes are announced ahead (`in`), so each envelope peaks on its note.
   */
  _updateAlive(dt, audio, perf, presence, jumped) {
    const a = this.alive;
    const R = AL.REACTIVITY;
    const score = perf.source === 'score' ? perf.map : null;
    if (score !== a.map) this._prepareMap(score);
    a.now = (a.now ?? 0) + dt;

    // intensity: fast attack, slow release, a small dead-band
    const L = AL.LEVEL;
    const target = presence * this._intensity(perf.drive);
    const d = target - a.x;
    if (jumped) a.x = target;
    else if (Math.abs(d) > L.DEADBAND) a.x += (d - Math.sign(d) * L.DEADBAND) * (1 - Math.exp(-dt / (d > 0 ? L.ATTACK : L.RELEASE)));

    // the section's energy state, into the next one ahead of the change
    const role = perf.section?.role ?? ROLE_OF_STAGE[perf.stage] ?? 'release';
    const next = perf.next?.role;
    const cross = next ? smooth01(1 - perf.timeToNext / SCORE_CONFIG.LOOKAHEAD) : 0;
    const want = sectionMix(role, next, cross, a.want);
    a.want = want;
    a.role = role;
    for (const k of SECTION_KEYS) a.sec[k] = jumped ? want[k] : a.sec[k] + (want[k] - a.sec[k]) * (1 - Math.exp(-dt / (AL.SECTION_BLEND / 3)));

    // the clock
    const paused = audio.element ? audio.element.paused : false;
    if (score) {
      const c = this._clockCurve(perf.t);
      if (paused) a.offset += dt * AL.SPEED.IDLE;
      a.speed = paused ? AL.SPEED.IDLE : this._sampleCurve(c.speed, c.rate, perf.t);
      a.clock = this._sampleCurve(c.clock, c.rate, perf.t) + a.offset;
    } else {
      a.speed = speedStep(a.live, a.x, a.sec.MOVE, Math.max(dt, 1e-3), R);
      a.clock += dt * a.speed;
    }

    // scheduled reactions
    if (jumped) {
      a.queue.length = 0;
      a.lastAccentT = perf.t;
    }
    const K = AL.KICK;
    const SW = AL.SWELL;
    const AC = AL.ACCENT;
    for (const e of perf.voices.melody.events) if (e.strength >= K.MIN_STRENGTH) a.queue.push({ at: a.now + e.in - 2 * K.ATTACK, kind: 'kick', s: e.strength });
    for (const e of perf.voices.low.events) if (e.strength >= SW.MIN_STRENGTH) a.queue.push({ at: a.now + e.in - 2 * SW.ATTACK, kind: 'swell', s: e.strength });
    if (score) {
      for (const o of perf.upcoming) {
        if (o.t <= a.lastAccentT) continue;
        a.lastAccentT = o.t;
        if (o.strength >= a.accentAt) a.queue.push({ at: a.now + o.in - 2 * AC.ATTACK, kind: 'accent', s: o.strength });
      }
    } else {
      for (const o of perf.onsets) if (o.strength >= AC.LIVE_STRENGTH) a.queue.push({ at: a.now, kind: 'accent', s: o.strength });
    }
    const imp = { kick: 0, swell: 0, accent: 0 };
    const gaps = { kick: [a.kick, K.MIN_GAP], swell: [a.swell, SW.MIN_GAP], accent: [a.glow, AC.MIN_GAP] };
    a.accentRing = 0;
    for (let i = a.queue.length - 1; i >= 0; i--) {
      const q = a.queue[i];
      if (q.at > a.now) continue;
      a.queue.splice(i, 1);
      const [env, gap] = gaps[q.kind];
      if (a.now - env.last < gap) continue; // rate-limited: a dense run reads as one swell, not a strobe
      env.last = a.now;
      imp[q.kind] = Math.max(imp[q.kind], q.s);
      if (q.kind === 'accent') a.accentRing = Math.max(a.accentRing, q.s);
    }
    // envelopes: an impulse into a slowly decaying hold, followed with a fast attack
    const env = (e, i, attack, decay, gain, max) => {
      e.hold = e.hold * Math.exp(-dt / decay) + i * gain * (R / 1.5);
      e.raw = (e.raw ?? 0) + (e.hold - (e.raw ?? 0)) * (1 - Math.exp(-dt / attack));
      e.v = max * (1 - Math.exp(-e.raw / max)); // a soft ceiling: a dense run never stacks into a flash
    };
    env(a.kick, imp.kick, K.ATTACK, K.DECAY, K.GAIN, K.MAX);
    env(a.swell, imp.swell, SW.ATTACK, SW.DECAY, 1, 1.2);
    env(a.glow, imp.accent, AC.ATTACK, AC.DECAY, AC.GLOW, 1);

    // the melody's pitch shifts the ribbons' hue
    const H = AL.HUE_FOLLOW;
    const mh = perf.voices.melody.conf > 0.2 || perf.source !== 'score' ? perf.voices.melody.height : 0.5;
    a.hue += (H.AMOUNT * a.sec.COLOUR * (2 * clamp01(mh) - 1) * presence - a.hue) * (jumped ? 1 : 1 - Math.exp(-dt / H.TIME));
  }

  // ------------------------------------------------------------ noise reduction

  /**
   * The audio values the aurora shaders read. Clean: each follows its raw
   * value with ATTACK / RELEASE through a soft dead-band (changes under
   * DEADBAND are ignored, larger ones count only beyond it), treble slower
   * still (SHIMMER.TIME). Previous look: the raw values.
   */
  _smoothAudio(dt, audio, jumped) {
    const raw = { bass: audio.bass, mid: audio.mid, treble: Math.min(1, audio.treble + this.shimmer), energy: audio.energy, surge: this.surge };
    const N = AU.NOISE;
    const out = this.smooth;
    let dIn = 0;
    let dOut = 0;
    for (const k of Object.keys(raw)) {
      const prev = out[k];
      if (!this.clean || jumped) out[k] = raw[k];
      else {
        const d = raw[k] - prev;
        const ex = Math.sign(d) * Math.max(0, Math.abs(d) - N.SMOOTH.DEADBAND);
        const tau = k === 'treble' ? N.SHIMMER.TIME : k === 'surge' ? (d > 0 ? N.SMOOTH.SURGE_ATTACK : dt) : d > 0 ? N.SMOOTH.ATTACK : N.SMOOTH.RELEASE;
        out[k] = k === 'surge' && d < 0 ? raw[k] : prev + ex * (1 - Math.exp(-dt / tau));
      }
      dIn += Math.abs(raw[k] - (this.lastRaw?.[k] ?? raw[k]));
      dOut += Math.abs(out[k] - prev);
    }
    this.lastRaw = raw;
    // (debug: mean change per frame, smoothed over ~1 s)
    const k = 1 - Math.exp(-dt / 1);
    this.jitterIn += (dIn / 5 - this.jitterIn) * k;
    this.jitterOut += (dOut / 5 - this.jitterOut) * k;
    return out;
  }

  /** Noise uniforms: the clean look (AURORA.NOISE) or the previous one. */
  _writeNoise() {
    const N = AU.NOISE;
    const c = this.clean;
    const st = PROFILE.LOOK.RAYS.STRIATION; // the look's streaks (smooth stripes, not noise)
    this.curtainMat.uniforms.uRay.value.set(c ? N.OCTAVES : 1, c ? st.FREQUENCY : 1, c ? st.CONTRAST : 0.55, c ? N.SHIMMER.AMP : 0.25);
    this.landMat.uniforms.uAuroraBlur.value.set(c ? N.BLUR : 2.5, c ? 1 : 0);
    this.dither = c ? N.DITHER : 1;
    this.ditherAnimated = !c;
  }

  // ------------------------------------------------------------ the look (reference restyle)

  _lookUniforms() {
    const v4 = () => ({ value: new THREE.Vector4() });
    const C = LK.CLOUDS;
    return {
      uClock: { value: 0 },
      uStreak: v4(),
      uSkyLook: v4(),
      uSkyLook2: v4(),
      uAirglow: { value: seen(LK.SKY.AIRGLOW) },
      uGapCol: { value: seen(LK.SKY.GAP.COLOR) },
      uHazeCol: { value: seen(LK.SKY.HAZE.COLOR) },
      uStarLook: v4(),
      uCloud: v4(),
      uCloud2: v4(),
      uCloud3: v4(),
      uCloudLight: v4(),
      uCloudStretch: { value: 1 },
      uCloudBody: { value: seen(C.BODY) },
      uCloudRim0: { value: lin(C.RIM[0]) },
      uCloudRim1: { value: lin(C.RIM[1]) },
      uRock: { value: seen(LK.MOUNTAINS.ROCK) },
      uSnow: { value: seen(LK.MOUNTAINS.SNOW) },
      uMount: v4(),
      uMountRim: { value: 0 },
      uMountLit: { value: 1 },
      uWaterLook: v4(),
      uWaterTop: { value: seen(LK.WATER.TOP) },
      uWaterBottom: { value: seen(LK.WATER.BOTTOM) },
      uReflect: v4(),
      uReach: { value: 1 },
      uReflect2: v4(),
      uReflect3: v4(),
      uRing: { value: Array.from({ length: 4 }, () => new THREE.Vector4()) },
      uShip: v4(),
      uShip2: v4(),
      uShip3: v4(),
      uHull: { value: lin(LK.SHIP.HULL) },
      uSail: { value: lin(LK.SHIP.SAIL) },
      uShipLight: { value: lin(LK.SHIP.LIGHT) },
      uGrade: v4(),
      uLift: { value: seen(LK.GRADE.LIFT) },
      uCloudGlow: { value: 0 },
      uStarRot: { value: new THREE.Vector3() },
      // the mist (PROFILE.MIST)
      uMist: v4(),
      uMistClock: v4(),
      uMistLayer: { value: Array.from({ length: 4 }, () => new THREE.Vector4()) },
      uMistShape: { value: Array.from({ length: 4 }, () => new THREE.Vector4()) },
      uMistBase: { value: seen(MI.BASE_COLOR) },
      uMistStar: { value: seen(MI.STARLIGHT) },
    };
  }

  /** The current palette (LOOK.PALETTE: vivid, or the reference photo's muted one), with its ramps. */
  _pal() {
    const P = LK.PALETTE;
    return this.vivid ? P.vivid : { ...P.muted, MELODY: AU.MELODY.RAMP, LOW: AU.LOW.RAMP };
  }

  /** The palette's ramps -> the aurora pass (on init and on V). */
  _writeRamps() {
    const pal = this._pal();
    const u = this.auroraMat.uniforms;
    const mel = rampStops(pal.MELODY);
    const low = rampStops(pal.LOW);
    u.uRampMel.value = mel.colors;
    u.uRampMelAt.value = mel.at;
    u.uRampLow.value = low.colors;
    u.uRampLowAt.value = low.at;
    u.uCore.value.copy(hexToLinear(pal.CORE));
    u.uFringe.value.copy(hexToLinear(pal.FRINGE));
    this.toneMapped = pal.TONE;
  }

  /**
   * Onset rings on the water: accents (the strongest onsets, ALIVE.ACCENT), at most MAX at a
   * time and MIN_GAP apart, each a soft swell running outward from a random spot of the far water.
   */
  _updateRings(dt) {
    const G = LK.WATER.ONSET_RINGS;
    for (const r of this.rings) r.age += dt;
    this.rings = this.rings.filter((r) => r.age < G.LIFE);
    const strong = this.alive.accentRing;
    if (strong > 0 && this.realTime - this.lastRing > G.MIN_GAP && this.rings.length < G.MAX) {
      this.lastRing = this.realTime;
      // a spot on the water plane (one unit below the eye): x across, z into the distance
      this.rings.push({ x: (this._rand() - 0.5) * 6, z: 3 + this._rand() * 6, age: 0, amp: strong });
    }
    const u = this.landMat.uniforms.uRing.value;
    for (let i = 0; i < 4; i++) {
      const r = this.rings[i];
      if (!r) u[i].set(0, 0, 0, 0);
      else {
        // fade in over 0.5 s, out over the last half of its life
        const env = Math.min(1, r.age / 0.5) * Math.min(1, (2 * (G.LIFE - r.age)) / G.LIFE);
        u[i].set(r.x, r.z, r.age * G.SPEED, G.AMP * r.amp * env * this.reflectOn);
      }
    }
  }

  /** × each layer's wave speed: the clock's speed and the intensity's WAVE range. */
  _waveSpeed() {
    return this.alive.speed * react(AL.RANGE.WAVE, this.alive.x, AL.REACTIVITY);
  }

  /**
   * The mist (PROFILE.MIST): 4 layers drifting on the sky clock at their own speeds, the shapes
   * rolling with it; the glow follows the bass, the aurora's brightness, the climax and the accents,
   * the billowing (gently) the mid range. M fades it out and in.
   */
  _writeMist(dt) {
    const u = this.landMat.uniforms;
    const al = this.alive;
    const M = MI.MUSIC;
    this.mistOn += (this.mistTarget - this.mistOn) * (1 - Math.exp(-dt / 0.4));
    const glow = 1 + M.BASS * this.smooth.bass + M.AURORA * Math.min(2, al.gain) + M.CLIMAX * this.climax + M.ACCENT * al.glow.v;
    u.uMist.value.set(this.mistOn, MI.COVER, MI.SOFT, MI.WARP * (1 + M.MID * this.smooth.mid));
    u.uMistClock.value.set(al.clock * MI.ROLL, glow, MI.OVERHEAD, MI.TINT);
    const octaves = Math.max(1, MI.OCTAVES - (this.quality >= 2 ? 1 : 0));
    al.mist = MI.LAYERS.map((L, i) => {
      const offset = al.clock * L.SPEED;
      u.uMistLayer.value[i].set(L.BASE, L.TOP, L.OPACITY, offset);
      u.uMistShape.value[i].set(L.SCALE, L.STRETCH, octaves, MI.REFLECT);
      return offset;
    });
    u.uMistBase.value.copy(seen(MI.BASE_COLOR));
    u.uMistStar.value.copy(seen(MI.STARLIGHT));
  }

  /** The look's per-frame values: the curtains in perspective, sky, clouds, mountains, water, ship, grade. */
  _writeLook(dt, perf) {
    const u = this.landMat.uniforms;
    const R = LK.RAYS;
    const CU = LK.CURTAINS;
    const C = LK.CLOUDS;
    const S = LK.SHIP;
    const W = LK.WATER;
    const t = this.realTime;
    const k = (tau) => 1 - Math.exp(-dt / tau);
    this.cloudsOn += (this.cloudsTarget - this.cloudsOn) * k(0.4);
    this.shipOn += (this.shipTarget - this.shipOn) * k(0.4);
    // melody activity -> the ship's lights; strong notes -> rings
    const mel = this.layers.melody.packets.reduce((s, p) => s + p.strength * this._envelope(p, AU.MELODY), 0);
    this.melGlow += (Math.min(1, mel / 2) - this.melGlow) * k(0.6);
    this.rippleKick *= Math.exp(-dt / 2);
    const bass = this.smooth.bass;

    // the curtains: vanishing point, the loop (forming and unravelling), the climax fan
    const au = this.auroraMat.uniforms;
    const pal = this._pal();
    // more alive: the clock drives every motion; the intensity widens the spread, the colour and the fan
    const al = this.alive;
    const Rx = AL.REACTIVITY;
    const MO = AL.MOTION;
    const clock = al.clock;
    const tau = 2 * Math.PI;
    au.uRowZ.value.set(...R.DEPTH);
    au.uVp.value.set(CU.VP[0], CU.VP[1], CU.SPREAD * react(AL.RANGE.WIDTH, al.x, Rx), CU.BEND);
    const L = CU.CURL;
    // the loop forms and unravels: its twist sways from almost none to twice the resting twist
    au.uCurl.value.set(L.X, L.Y, L.TWIST * (1 + Math.min(MO.CURL_MAX, L.SWAY * MO.CURL * al.move) * Math.sin(tau * MO.CURL_RATE * clock)), L.RADIUS);
    au.uBillow.value.set(0, CU.BILLOW_FREQUENCY, 0, CU.EDGE_ON);
    // sway of each ribbon (amplitude, phase) and the whole system's slow turn around the vanishing point
    au.uMove.value.set(MO.SWAY * al.move, MO.ROTATE * Math.min(1.5, al.move) * Math.sin(tau * MO.ROTATE_RATE * clock), tau * MO.SWAY_RATE * clock, 0);
    const sat = Math.min(1.7, lerp(pal.SATURATION[0], pal.SATURATION[1], this.amp) * react(AL.RANGE.SATURATION, al.x, Rx));
    const fan = Math.min(0.5, CU.FAN * this.climax + lerp(MO.FAN[0], MO.FAN[1], al.x) + MO.KICK_FAN * al.kick.v);
    au.uRays.value.set(fan, R.FADE, 0, sat);
    au.uTex.value.set(R.TEXTURE.CONTRAST, R.TEXTURE.FREQUENCY, R.TEXTURE.ALONG, CU.GAIN * pal.GAIN);
    au.uGlowShape.value.set(CU.CONVERGE, CU.LEFT_FADE, CU.LOW_GAIN, 0);
    au.uColour.value.set(pal.ZONE, pal.FRINGE_AMOUNT, pal.CORE_AMOUNT, 0);
    // the ribbons: loudness shows them (3 quiet .. 6 loud) up to the section's count; each travels
    // there and back along the sky and billows at its own pace; strong low notes swell and lift the
    // lower ones (rows 2-3); the melody's pitch shifts their hue
    const SW = AL.SWELL;
    LK.RIBBONS.forEach((rb, i) => {
      // (the first ribbons, SHOW 0, never go out: quiet is calm, never empty)
      const show = (rb.SHOW > 0 ? smooth01((al.x - rb.SHOW) / 0.12) : 1) * clamp01(al.sec.RIBBONS - i);
      this.ribbonShow[i] += (show - this.ribbonShow[i]) * k(0.8);
      const drift = ((rb.SHIFT * MO.DRIFT * MO.DRIFT_PERIOD) / tau) * Math.sin((tau * clock) / MO.DRIFT_PERIOD + i * 1.3);
      const low = rb.ROW >= 2 ? al.swell.v : 0;
      au.uRib.value[i].set(rb.EDGE - SW.RISE * low, rb.TILT, rb.FLAT, rb.LENGTH * (1 + SW.GROW * low));
      au.uRib2.value[i].set(rb.ROW, rb.HUE + al.hue * (rb.ROW >= 2 ? 0.5 : 1), drift, rb.BRIGHT * this.ribbonShow[i] * (1 + SW.GAIN * low));
      au.uRib3.value[i].set(rb.BILLOW * MO.BILLOW * al.move, this.time * rb.RATE + i * 11.3, rb.EDGE_SOFT, 0);
    });
    this.curtainMat.uniforms.uRowZ.value.set(...R.DEPTH);
    u.uStreak.value.set(CU.VP[0], CU.VP[1], this.clean ? R.STREAK : 0, 0);

    u.uClock.value = t;
    u.uSkyLook.value.set(pal.SKY_WASH, LK.SKY.HAZE.STRENGTH, LK.SKY.HAZE.HEIGHT, LK.SKY.SHORE_GLOW);
    u.uSkyLook2.value.set(LK.SKY.CORNERS, LK.SKY.GAP.AMOUNT, pal.AMBIENT_CAP, 0);
    u.uAirglow.value.copy(seen(LK.SKY.AIRGLOW));
    u.uGapCol.value.copy(seen(LK.SKY.GAP.COLOR));
    u.uHazeCol.value.copy(seen(LK.SKY.HAZE.COLOR));
    u.uStarLook.value.set(LK.STARS.DENSITY, LK.STARS.SIZE, LK.STARS.BEHIND_AURORA, 0);
    // the stars wheel slowly around a pole above the frame, on the sky clock
    u.uStarRot.value.set(clock * AL.STARS.ROTATION, AL.STARS.POLE[0], AL.STARS.POLE[1]);
    // clouds: dark wisps drifting left -> right with the mist (the warm rims are off in this look: RIM_STRENGTH 0)
    u.uCloud.value.set(this.cloudsOn, C.SCALE, C.COVER + (1 - this.cloudsOn) * 0.6, C.SOFT);
    u.uCloud2.value.set(C.SIDES[0], C.SIDES[1], C.BAND[0], C.BAND[1]);
    u.uCloud3.value.set(C.AURORA_TINT, C.RIM_STRENGTH * (1 + C.BASS_GAIN * bass + C.DAWN_GAIN * this.dawn) * this.cloudsOn, C.RIM_WIDTH, C.OPACITY);
    u.uCloudStretch.value = C.STRETCH;
    u.uCloudLight.value.set(C.LIGHT[0], C.LIGHT[1], -clock * C.DRIFT[0] * C.SCALE, -clock * C.DRIFT[1] * C.SCALE);
    u.uCloudGlow.value = C.EDGE_GLOW * this.cloudsOn;
    this._writeMist(dt);
    u.uCloudBody.value.copy(seen(C.BODY));
    u.uCloudRim0.value.copy(lin(C.RIM[0]));
    u.uCloudRim1.value.copy(lin(C.RIM[1]));
    const M = LK.MOUNTAINS;
    u.uMount.value.set(M.HAZE[0], M.HAZE[1], M.HAZE[2], M.SKY_LIGHT);
    u.uMountRim.value = M.RIM;
    const lit = clamp01((this.amp - M.LIT.AMP[0]) / (M.LIT.AMP[1] - M.LIT.AMP[0]));
    u.uMountLit.value = lerp(M.LIT.LIGHT[0], M.LIT.LIGHT[1], lit * lit * (3 - 2 * lit));
    u.uRock.value.copy(seen(M.ROCK));
    u.uSnow.value.copy(seen(M.SNOW));
    u.uWaterLook.value.set(W.RIPPLE, W.FINE, W.RINGS + W.NOTE_RINGS * this.rippleKick, W.ROCKS ? 1 : 0);
    u.uWaterTop.value.copy(seen(W.TOP));
    u.uWaterBottom.value.copy(seen(W.BOTTOM));
    this.reflectOn += (this.reflectTarget - this.reflectOn) * k(0.4);
    u.uReflect.value.set(W.REFLECT[0] * this.reflectOn, W.BLUR[0], W.BLUR[1], W.SPEED);
    u.uReflect2.value.set(W.REFLECT[1] * this.reflectOn, W.FRESNEL, W.WOBBLE, W.STARS);
    u.uReflect3.value.set(W.GLOW, W.SHORE, W.ONSET_RINGS.WIDTH, 0);
    this._updateRings(dt);
    u.uReach.value = W.REACH;
    // the ship: a very slow drift across the fjord (piece time, so a seek puts it in place), bob, roll, billow
    const minutes = (perf.source === 'score' ? perf.t : t % 360) / 60;
    const bob = S.BOB * (Math.sin(t * 0.55) + 0.5 * Math.sin(t * 0.93 + 1));
    u.uShip.value.set(S.X - S.DRIFT * minutes, S.WATERLINE, S.SIZE, this.shipOn);
    u.uShip2.value.set(bob, S.ROLL * Math.sin(t * 0.42), lerp(S.BILLOW[0], S.BILLOW[1], bass), S.LIGHT_STRENGTH * (1 + S.MELODY_GAIN * this.melGlow));
    u.uShip3.value.set(S.SAIL_LIGHT, S.FLICKER, 0, 0);
    u.uHull.value.copy(lin(S.HULL));
    u.uSail.value.copy(lin(S.SAIL));
    u.uShipLight.value.copy(lin(S.LIGHT));
    const G = LK.GRADE;
    u.uGrade.value.set(G.SATURATION * pal.GRADE_SATURATION, G.WARM_KEEP, G.VIGNETTE, 0);
    u.uLift.value.copy(seen(G.LIFT));
    this.bloom.threshold = G.BLOOM.THRESHOLD;
    this.bloom.strength = G.BLOOM.STRENGTH;
  }

  // ------------------------------------------------------------ the night progression

  _nightUniforms() {
    const v3 = (c) => ({ value: new THREE.Vector3(...c) });
    return {
      uSkyDusk: { value: [new THREE.Vector3(), new THREE.Vector3()] },
      uSkyNight: { value: [new THREE.Vector3(), new THREE.Vector3()] },
      uDuskWarm: v3(NI.DUSK_GLOW.WARM),
      uDuskCool: v3(NI.DUSK_GLOW.COOL),
      uDuskGlow: { value: new THREE.Vector4() },
      uDawnLow: v3(NI.DAWN_GLOW.LOW),
      uDawnHigh: v3(NI.DAWN_GLOW.HIGH),
      uGlowHeight: { value: new THREE.Vector4() },
      uStars: { value: new THREE.Vector4() },
      uMilkyWay: { value: 0 },
      uNightAurora: { value: new THREE.Vector4() },
      uSnowGlow: { value: 0 },
    };
  }

  /**
   * night / dawn at the playhead (monotone cubic through NIGHT.KEYS); with no
   * score, a slow ping-pong over NIGHT.LOOP s through the same timeline.
   */
  _updateNight(dt, perf, jumped) {
    const keys = NI.KEYS;
    const sig = JSON.stringify(keys);
    if (sig !== this.nightSig) {
      // (rebuilt when the keys are tuned)
      this.nightSig = sig;
      const xs = keys.map((k) => k[0]);
      this.nightCurve = monotone(xs, keys.map((k) => k[1]));
      this.dawnCurve = monotone(xs, keys.map((k) => k[2]));
    }
    const end = keys[keys.length - 1][0];
    let t;
    if (perf.source === 'score') {
      this.nightSource = 'score';
      t = perf.t;
    } else {
      this.nightSource = 'loop';
      const ph = (this.realTime / NI.LOOP) % 1;
      t = end * (1 - Math.abs(2 * ph - 1)); // there and back, so the cycle never jumps
    }
    const night = clamp01(this.nightCurve(t));
    const dawn = clamp01(this.dawnCurve(t));
    const k = jumped ? 1 : 1 - Math.exp(-dt / NI.SMOOTHING);
    this.night += (night - this.night) * k;
    this.dawn += (dawn - this.dawn) * k;
    this.shared.uNight.value = this.night;
    this.shared.uDawn.value = this.dawn;

    const u = this.landMat.uniforms;
    u.uSkyDusk.value[0].set(...NI.SKY.DUSK[0]);
    u.uSkyDusk.value[1].set(...NI.SKY.DUSK[1]);
    u.uSkyNight.value[0].set(...NI.SKY.NIGHT[0]);
    u.uSkyNight.value[1].set(...NI.SKY.NIGHT[1]);
    const G = NI.DUSK_GLOW;
    u.uDuskWarm.value.set(...G.WARM);
    u.uDuskCool.value.set(...G.COOL);
    u.uDuskGlow.value.set(G.COOL_AT[0], G.COOL_AT[1], G.FADE, G.STRENGTH);
    const D = NI.DAWN_GLOW;
    u.uDawnLow.value.set(...D.LOW);
    u.uDawnHigh.value.set(...D.HIGH);
    u.uGlowHeight.value.set(G.HEIGHT, D.HEIGHT, D.STRENGTH, 0);
    const S = NI.STARS;
    u.uStars.value.set(this.hideStars ? 0 : lerp(S.GAIN[0], S.GAIN[1], this.night), lerp(S.SHOWN[0], S.SHOWN[1], this.night), S.DAWN_REACH, 0);
    const mw = this.night <= 0.55 ? 0 : ((this.night - 0.55) / 0.45) ** 2;
    u.uMilkyWay.value = lerp(NI.MILKY_WAY[0], NI.MILKY_WAY[1], mw);
    const A = NI.AURORA;
    u.uNightAurora.value.set(lerp(A.GAIN[0], A.GAIN[1], this.night) * (1 - A.DAWN_FADE * this.dawn), lerp(A.SATURATION[0], A.SATURATION[1], this.night), 0, 0);
    u.uSnowGlow.value = NI.SNOW;
  }

  /** Horizon colour now (sRGB hex), for the debug swatch. */
  _horizonHex() {
    const G = NI.DUSK_GLOW;
    const D = NI.DAWN_GLOW;
    const n = this.night;
    const s = (a, b, x) => {
      const f = clamp01((x - a) / (b - a));
      return f * f * (3 - 2 * f);
    };
    const cool = s(G.COOL_AT[0], G.COOL_AT[1], n);
    const glow = (1 - s(0, G.FADE, n)) * G.STRENGTH;
    const c = [0, 1, 2].map((i) => lerp(NI.SKY.DUSK[0][i], NI.SKY.NIGHT[0][i], n) + lerp(G.WARM[i], G.COOL[i], cool) * glow + D.LOW[i] * this.dawn * D.STRENGTH);
    const col = new THREE.Color(c[0], c[1], c[2]); // linear -> displayed as sRGB
    return '#' + col.multiplyScalar(4).getHexString();
  }

  // ------------------------------------------------------------ the wave aurora

  /** Seeded random 0..1 (mulberry32), so a run is repeatable. */
  _rand() {
    let t = (this.seed = (this.seed + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Pitch class -> a hue twist (radians, up to +/- deg), on the circle of fifths so related notes twist alike. */
  _twist(pc, deg) {
    return pc < 0 ? 0 : ((deg * Math.sin((((pc * 7) % 12) / 12) * Math.PI * 2)) * Math.PI) / 180;
  }

  /** Packet envelope 0..1 at `age`: raised-cosine fade-in peaking on the note, then decay and a final fade. */
  _envelope(p, L) {
    const a = p.age;
    const rise = a < L.FADE_IN ? 0.5 - 0.5 * Math.cos((Math.PI * a) / L.FADE_IN) : 1;
    const x = clamp01((a - (L.LIFE - L.FADE_OUT)) / L.FADE_OUT);
    return rise * Math.exp(-Math.max(0, a - L.FADE_IN) / L.DECAY) * (1 - x * x * (3 - 2 * x));
  }

  /** Width of a packet now (it widens as it travels). */
  _width(p, L) {
    return lerp(L.WIDTH[0], L.WIDTH[1], Math.min(1, p.age / L.LIFE)) * p.size;
  }

  /**
   * The two voices -> packets. Notes come announced ahead (perf.voices,
   * `in` s early): each waits until its fade-in would peak exactly on the
   * note; live notes (in = 0) start at once. Weak notes and notes closer
   * than MIN_GAP to the last packet are skipped; a full pool replaces its
   * faintest packet.
   */
  _updateWaves(dt, perf, presence, jumped) {
    const S = AU.SCALE;
    const k = (tau) => (jumped ? 1 : 1 - Math.exp(-dt / tau));
    this.keyBias += ((AU.KEY_BIAS[perf.key?.mode] ?? 0) - this.keyBias) * k(AU.KEY_SMOOTHING);
    // the waves travel with the clock (0.45x .. ~3x) and faster still when loud
    const speedScale = this._waveSpeed();
    for (const name of LAYERS) {
      const L = AU[name.toUpperCase()];
      const layer = this.layers[name];
      layer.on += (layer.onTarget - layer.on) * k(0.25);
      if (jumped) {
        layer.packets.length = 0;
        layer.pending.length = 0;
      }
      for (const e of perf.voices[name].events) {
        layer.heard++;
        if (presence > 0.3) layer.pending.push({ ...e, wait: e.in - L.FADE_IN });
      }
      for (let i = layer.pending.length - 1; i >= 0; i--) {
        const e = layer.pending[i];
        e.wait -= dt;
        if (e.wait > 0) continue;
        layer.pending.splice(i, 1);
        this._spawn(name, L, layer, e);
      }
      // travel: eased start, then the layer's speed (higher notes faster), x the quiet/loud scaling
      for (const p of layer.packets) {
        p.age += dt;
        p.x += L.DIRECTION * p.speed * speedScale * (1 - Math.exp(-p.age / L.FADE_IN)) * dt;
      }
      layer.packets = layer.packets.filter((p) => {
        const w = 2.5 * this._width(p, L);
        return p.age < L.LIFE && (L.DIRECTION > 0 ? p.x - w < 1.05 : p.x + w > -0.05);
      });
      // the layer's resting colour follows its notes; the twist follows the note's pitch class
      if (name === 'low') layer.rotTarget = this._twist(perf.voices.low.note, L.HUE_DEG);
      layer.rot += (layer.rotTarget - layer.rot) * k(0.8);
    }
  }

  _spawn(name, L, layer, e) {
    const NS = AU.NOISE.SPAWN;
    const minGap = this.clean ? Math.max(L.MIN_GAP, NS.MIN_GAP) : L.MIN_GAP;
    if (e.strength < L.MIN_STRENGTH || this.realTime - layer.lastSpawn < minGap) return;
    layer.lastSpawn = this.realTime;
    layer.spawned++;
    const h = clamp01(e.height);
    const S = AU.SCALE;
    const size = lerp(S.SIZE[0], S.SIZE[1], this.amp);
    let strength = lerp(0.5, 1, clamp01(e.strength));
    // clean: a packet differs from the last one by at most STEP, so fast notes form a stream, not a strobe
    if (this.clean && layer.lastStrength !== undefined) strength = Math.min(layer.lastStrength + NS.STEP, Math.max(layer.lastStrength - NS.STEP, strength));
    layer.lastStrength = strength;
    let hue = clamp01(lerp(L.HUE_RANGE[0], L.HUE_RANGE[1], h) + this.keyBias);
    if (name === 'melody') {
      // around the palette's centre, the climax opening up the whole ramp
      const pal = this._pal();
      // (louder and more colourful sections open the range wider)
      const spread = lerp(pal.HUE_SPREAD[0], pal.HUE_SPREAD[1], this.climax) * react(AL.RANGE.HUE, this.alive.x, AL.REACTIVITY) * this.alive.sec.COLOUR;
      hue = clamp01(pal.HUE_CENTRE + (hue - pal.HUE_CENTRE) * Math.min(1.3, spread));
      if (e.strength > 0.6) this.rippleKick = Math.min(1, this.rippleKick + 0.5 * e.strength);
    }
    const p = {
      id: this.nextId++,
      age: 0, // score notes: the fade-in peaks on the note; live ones (in = 0) peak FADE_IN late
      x: lerp(L.START[0], L.START[1], this._rand()),
      curtain: lerp(L.CURTAINS[0], L.CURTAINS[1], h),
      strength,
      hue,
      lift: (L.LIFT * strength + (L.HEIGHT_PITCH ?? 0) * h) * size,
      speed: L.SPEED * (1 + L.PITCH_SPEED * (h - 0.5)) * (0.9 + 0.2 * this._rand()),
      size,
      h,
    };
    if (layer.packets.length >= Math.min(SLOTS, L.POOL)) {
      // replace the faintest
      let worst = 0;
      layer.packets.forEach((q, i) => {
        if (this._envelope(q, L) * q.strength < this._envelope(layer.packets[worst], L) * layer.packets[worst].strength) worst = i;
      });
      layer.packets.splice(worst, 1);
    }
    layer.packets.push(p);
    layer.hue = hue;
    if (name === 'melody') layer.rotTarget = this._twist(e.pc, L.HUE_DEG);
  }

  /** Hands the aurora state to the curtain, aurora and landscape passes. */
  _writeAurora(height, dt = 0, jumped = true) {
    const cu = this.curtainMat.uniforms;
    const au = this.auroraMat.uniforms;
    const S = AU.SCALE;
    const bright = lerp(S.BRIGHT[0], S.BRIGHT[1], this.amp) * (this.clean ? AU.NOISE.GAIN : 1) * PROFILE.LOOK.RAYS.GAIN;
    LAYERS.forEach((name, li) => {
      const L = AU[name.toUpperCase()];
      const layer = this.layers[name];
      for (let i = 0; i < SLOTS; i++) {
        const v = cu.uPacket.value[li * SLOTS + i];
        const q = cu.uPacketShape.value[li * SLOTS + i];
        const p = layer.packets[i];
        if (!p) {
          v.set(0, 0, 0, 0.05);
          continue;
        }
        // (each melody note's wave sets off with a bright pulse: ALIVE.KICK.PULSE)
        const pulse = name === 'melody' ? 1 + AL.KICK.PULSE * (AL.REACTIVITY / 1.5) * Math.exp(-p.age / AL.KICK.PULSE_TIME) : 1;
        v.set(p.x, p.curtain, p.strength * this._envelope(p, L) * layer.on * pulse, this._width(p, L));
        q.set(p.hue, p.lift, L.DIRECTION * L.FRONT, 0);
      }
    });
    const M = AU.MELODY;
    const L = AU.LOW;
    const mel = this.layers.melody;
    const low = this.layers.low;
    // spectrum bands set the heights: the melody rows reach with the mid / treble, the low rows with the bass
    const BH = LK.CURTAINS.BAND_HEIGHT;
    const hm = M.HEIGHT * height * (1 + BH.MELODY * (0.5 * this.smooth.mid + 0.5 * this.smooth.treble));
    const hl = L.HEIGHT * height * (1 + BH.LOW * this.smooth.bass);
    cu.uRowHeight.value.set(hm, hm, hl, hl);
    // the curtains' resting colour: clean, it glides to each new note's hue instead of jumping
    const kh = this.clean && !jumped ? 1 - Math.exp(-dt / AU.NOISE.SMOOTH.HUE) : 1;
    this.rowHue.melody += (mel.hue - this.rowHue.melody) * kh;
    this.rowHue.low += (low.hue - this.rowHue.low) * kh;
    cu.uRowHue.value.set(this.rowHue.melody, this.rowHue.melody, this.rowHue.low, this.rowHue.low);
    cu.uRowBright.value.set(M.BRIGHT * bright, M.BRIGHT * bright, L.BRIGHT * bright, L.BRIGHT * bright);
    cu.uRowBend.value.set(M.BEND, M.BEND, L.BEND, L.BEND);
    cu.uRowCurve.value.set(M.CURVE, M.CURVE, L.CURVE, L.CURVE);
    cu.uRowStria.value.set(M.STRIATION, M.STRIATION * 0.85, L.STRIATION, L.STRIATION * 0.85);
    cu.uGlow.value = AU.GLOW * this.amp * (this.clean ? AU.NOISE.GAIN : 1) * PROFILE.LOOK.RAYS.GAIN;
    au.uHueRot.value.set(mel.rot, mel.rot, low.rot, low.rot);
    au.uCrest.value = AU.CREST;
    au.uScreen.value = AU.BLEND === 'screen' ? 1 : 0;
    au.uCap.value = this._pal().CAP;
    au.uOn.value = this.on;
    const P = AU.PAINT;
    this.landMat.uniforms.uPaint.value.set(P.STROKE, P.LENGTH, P.WIDTH, P.SMEAR);
    this.landMat.uniforms.uPaint2.value.set(P.IMPASTO, P.SKY, P.CENTRE[0], P.CENTRE[1]);
  }

  /** Ramp colour (sRGB hex) at position h of a layer's ramp, for the debug swatches. */
  _rampHex(ramp, h, rot = 0) {
    const c = new THREE.Color(ramp[0][1]);
    for (let i = 1; i < ramp.length; i++) {
      const f = clamp01((h - ramp[i - 1][0]) / (ramp[i][0] - ramp[i - 1][0]));
      c.lerp(new THREE.Color(ramp[i][1]), f * f * (3 - 2 * f));
    }
    if (rot) c.offsetHSL(rot / (Math.PI * 2), 0, 0);
    return '#' + c.getHexString();
  }

  /**
   * The alive state for the verify script: intensity, the aurora's brightness gain (the same product
   * aurora.frag applies: energy, bass, surge, the music gain, the light gain), speed, clocks, kicks,
   * mist offsets, ribbons and the wave speed.
   */
  get aliveState() {
    const a = this.alive;
    const s = this.shared;
    const bright = (0.8 + 0.5 * s.uEnergy.value) * (1 + 0.25 * s.uBass.value) * (1 + 0.4 * s.uSurge.value) * s.uBright.value * this.auroraMat.uniforms.uTex.value.w;
    return { x: a.x, bright, gain: a.gain, speed: a.speed, clock: a.clock, sky: a.clock, kick: a.kick.v, swell: a.swell.v, glow: a.glow.v, mist: a.mist ?? [0, 0, 0, 0], ribbons: this.ribbonShow.filter((v) => v > 0.5).length, ribbonSpeed: AU.MELODY.SPEED * this._waveSpeed(), section: a.role, reactivity: AL.REACTIVITY };
  }

  /** Aurora state for the verify script. */
  get auroraState() {
    const layer = (name) => {
      const L = AU[name.toUpperCase()];
      const l = this.layers[name];
      return {
        active: l.packets.length,
        spawned: l.spawned,
        heard: l.heard,
        on: l.onTarget > 0,
        hue: l.hue,
        // visible wave energy: strength x envelope x size x brightness (incl. the quiet/loud scaling)
        activity: l.packets.reduce((s, p) => s + p.strength * this._envelope(p, L) * p.size, 0) * L.BRIGHT * lerp(AU.SCALE.BRIGHT[0], AU.SCALE.BRIGHT[1], this.amp),
        packets: l.packets.map((p) => ({ id: p.id, x: p.x, env: this._envelope(p, L), width: this._width(p, L) })),
        speed: L.SPEED * this._waveSpeed(),
      };
    };
    const v = this.perfVoices;
    return { clean: this.clean, vivid: this.vivid, ribbons: this.ribbonShow.filter((v) => v > 0.5).length, reflect: LK.WATER.REFLECT[0] * this.reflectOn, rings: this.rings.length, night: this.night, dawn: this.dawn, nightSource: this.nightSource, amp: this.amp, on: this.onTarget > 0, low: layer('low'), melody: layer('melody'), melodyHeight: v?.melody.height ?? 0, lowNote: v?.low.note ?? -1 };
  }

  /** A small scrolling strip of the two voices' recent notes (debug overlay). */
  _voiceStrip(perf) {
    const W = 220;
    const H = 34;
    const span = 6;
    const now = perf.t;
    const x = (t) => (W - 24 + ((t - now) / span) * (W - 24)).toFixed(1);
    const dots = perf.voices.history
      .map((e) => {
        const y = e.voice === 'melody' ? 2 + (1 - e.height) * 13 : 19 + (1 - e.height) * 13;
        const c = e.voice === 'melody' ? '#b98cff' : '#2fd39a';
        return `<circle cx="${x(e.t)}" cy="${y.toFixed(1)}" r="${(1 + 2 * e.strength).toFixed(1)}" fill="${c}" opacity="${e.t > now ? 0.45 : 0.9}"/>`;
      })
      .join('');
    return `<svg width="${W}" height="${H}" style="vertical-align:middle;background:rgba(255,255,255,.04)"><line x1="0" x2="${W}" y1="17" y2="17" stroke="rgba(255,255,255,.15)"/><line x1="${W - 24}" x2="${W - 24}" y1="0" y2="${H}" stroke="rgba(255,255,255,.4)"/>${dots}</svg>`;
  }

  /** Live values for the debug overlay (D). */
  get debug() {
    const sh = this.shape;
    const perf = this.perf;
    const sw = (c) => `<span class="debug-swatch" style="background:${c}"></span>`;
    const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const mel = this.layers.melody;
    const low = this.layers.low;
    const onOff = (l, key) => (l.onTarget > 0 ? '' : ` OFF (${key})`);
    const v = perf?.voices;
    return {
      aurora: `${this.onTarget > 0 ? 'on' : 'OFF (A)'} · amp ${this.amp.toFixed(2)} · packets low ${low.packets.length}/${AU.LOW.POOL}${onOff(low, 'L')} · melody ${mel.packets.length}/${AU.MELODY.POOL}${onOff(mel, 'K')}`,
      melody: { html: `${sw(this._rampHex(AU.MELODY.RAMP, mel.hue, mel.rot))} height ${(v?.melody.height ?? 0).toFixed(2)} · hue ${mel.hue.toFixed(2)} · ${(v?.melody.rate ?? 0).toFixed(1)} notes/s · spawned ${mel.spawned}/${mel.heard}` },
      'low note': { html: `${sw(this._rampHex(AU.LOW.RAMP, low.hue, low.rot))} ${v && v.low.note >= 0 ? names[v.low.note] : '-'} · height ${(v?.low.height ?? 0).toFixed(2)} · ${(v?.low.rate ?? 0).toFixed(1)} notes/s · spawned ${low.spawned}/${low.heard}` },
      voices: perf ? { html: this._voiceStrip(perf) + ' <span style="color:#b98cff">melody</span> / <span style="color:#2fd39a">low</span>' } : '-',
      vivid: { html: `${this.vivid ? 'vivid' : 'MUTED'} (V) · ribbons ${this.ribbonShow.filter((v) => v > 0.5).length}/${LK.RIBBONS.length} · hue ${this.layers.melody.hue.toFixed(2)} ${sw(this._rampHex(this._pal().MELODY, this.layers.melody.hue))} · saturation ${this.auroraMat.uniforms.uRays.value.w.toFixed(2)} · reflection ${this.reflectTarget > 0 ? (LK.WATER.REFLECT[0] * this.reflectOn).toFixed(2) : 'OFF'} (R) · rings ${this.rings.length}` },
      look: `clouds ${this.cloudsTarget > 0 ? 'on' : 'OFF'} (C) · ship ${this.shipTarget > 0 ? 'on' : 'OFF'} (B) · VP ${LK.CURTAINS.VP.join(', ')} · loop twist ${this.auroraMat.uniforms.uCurl.value.z.toFixed(2)} · sat ${this.auroraMat.uniforms.uRays.value.w.toFixed(2)} · streak ${LK.RAYS.STREAK} px · reflection ${LK.WATER.REFLECT}`,
      smoothness: `${this.clean ? 'clean' : 'PREVIOUS look'} (N) · audio jitter ${(this.jitterIn * 1000).toFixed(1)} -> ${(this.jitterOut * 1000).toFixed(1)} ‰/frame (${this.jitterIn > 0 ? Math.round((1 - this.jitterOut / this.jitterIn) * 100) : 0} % less) · blur ${this.landMat.uniforms.uAuroraBlur.value.x} px · rays ${this.curtainMat.uniforms.uRay.value.x} oct`,
      night: { html: `${sw(this._horizonHex())} night ${this.night.toFixed(2)} · dawn ${this.dawn.toFixed(2)} · ${this.nightSource === 'score' ? 'timeline' : `loop ${NI.LOOP} s`}` },
      alive: `reactivity ${AL.REACTIVITY.toFixed(2)} ([ ]) · x ${this.alive.x.toFixed(2)} · speed ×${this.alive.speed.toFixed(2)} · brightness ${(this.alive.gain ?? 0).toFixed(2)} · ribbons ${this.ribbonShow.filter((v) => v > 0.5).length}`,
      section: `${this.perf?.section?.role ?? this.perf?.stage ?? '-'} → move ${this.alive.sec.MOVE.toFixed(2)} · ribbons ≤ ${this.alive.sec.RIBBONS.toFixed(1)} · ceiling ${this.alive.sec.BRIGHT.toFixed(2)} · colour ${this.alive.sec.COLOUR.toFixed(2)}`,
      reactions: `kick ${this.alive.kick.v.toFixed(2)} · swell ${this.alive.swell.v.toFixed(2)} · accent glow ${this.alive.glow.v.toFixed(2)} · hue ${this.alive.hue >= 0 ? '+' : ''}${this.alive.hue.toFixed(2)}`,
      mist: `${this.mistTarget > 0 ? 'on' : 'OFF'} (M) · speed ${MI.LAYERS.map((L) => (L.SPEED * this.alive.speed).toFixed(3)).join(' / ')} screen h/s · clock ${this.alive.clock.toFixed(1)}`,
      build: `${this.build.toFixed(2)} · climax ${this.climax.toFixed(2)} · exposure ${this.exposure.toFixed(2)}`,
      curtains: `height ${sh.height.toFixed(2)} · width ${sh.width.toFixed(2)} · fold ${sh.fold.toFixed(2)}`,
    };
  }

  render(target) {
    this.pass.render(this.renderer, this.curtainMat, this.curtainTarget);
    this.pass.render(this.renderer, this.auroraMat, this.auroraTarget);
    this.pass.render(this.renderer, this.ambientMat, this.ambientTarget);
    this.pass.render(this.renderer, this.landMat, this.sceneTarget);
    this.bloom.render(this.renderer, this.sceneTarget.texture, target);
  }

  dispose() {
    window.removeEventListener('keydown', this._onKey);
    this.tune?.dispose();
    this.auroraTarget?.dispose();
    this.sceneTarget?.dispose();
    this.terrainTarget?.dispose();
    this.ambientTarget?.dispose();
    this.terrainMat?.dispose();
    this.ambientMat?.dispose();
    this.curtainTarget?.dispose();
    this.curtainMat?.dispose();
    this.bloom?.dispose();
    this.auroraMat?.dispose();
    this.landMat?.dispose();
  }
}
