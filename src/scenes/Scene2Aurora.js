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
 * Keys: A fades the whole aurora out and in, L the low layer, M the melody.
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

const SHAPE_KEYS = ['height', 'width', 'cover', 'bright', 'fold'];
const lerp = (a, b, x) => a + (b - a) * x;

// aurora pass resolution (fraction of the scene target) and slice count
const AURORA = [
  { scale: 0.4, steps: 34 },
  { scale: 0.36, steps: 30 },
  { scale: 0.32, steps: 26 },
  { scale: 0.28, steps: 22 },
];

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
    // the two-layer wave aurora (PROFILE.AURORA)
    this.amp = 0;
    this.keyBias = 0;
    this.realTime = 0;
    this.nextId = 1;
    this.seed = 0x2f6e2b1;
    const layer = () => ({ packets: [], pending: [], lastSpawn: -1e9, spawned: 0, heard: 0, hue: 0.4, rot: 0, rotTarget: 0, on: 1, onTarget: 1 });
    this.layers = { low: layer(), melody: layer() };
    this.on = 1; // A toggles the aurora, L and M one layer each
    this.onTarget = 1;
    this._onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target instanceof HTMLInputElement && e.target.type !== 'range') return;
      const k = e.key.toLowerCase();
      if (k === 'a') this.onTarget = this.onTarget > 0 ? 0 : 1;
      const l = k === 'l' ? this.layers.low : k === 'm' ? this.layers.melody : null;
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
    };
    // the tallest a curtain can get: base height + a full packet's lift (+ the melody's pitch height)
    const tall = (L) => (L.HEIGHT + 1.2 * (L.LIFT + (L.HEIGHT_PITCH ?? 0)) * AU.SCALE.SIZE[1]) * AU.SCALE.HEIGHT[1];
    this.shared.uTopScale.value = Math.max(tall(AU.LOW), tall(AU.MELODY));
    const mel = rampStops(AU.MELODY.RAMP);
    const low = rampStops(AU.LOW.RAMP);
    const prefix = noiseGLSL + commonGLSL;
    this.auroraMat = passMaterial({
      fragmentShader: prefix + auroraFrag,
      uniforms: {
        ...this.shared,
        uSteps: { value: 34 },
        tCurtains: { value: null },
        uRampMel: { value: mel.colors },
        uRampMelAt: { value: mel.at },
        uRampLow: { value: low.colors },
        uRampLowAt: { value: low.at },
        uHueRot: { value: new THREE.Vector4() },
        uRowSheet: { value: new THREE.Vector4(1, 1, 1, 1) },
        uCrest: { value: AU.CREST },
        uScreen: { value: 0 },
        uCap: { value: AU.CAP },
        uOn: { value: 1 },
      },
    });
    this.landMat = passMaterial({
      fragmentShader: prefix + landscapeFrag,
      uniforms: { ...this.shared, tAurora: { value: null }, tTerrain: { value: null }, tAmbient: { value: null }, uPaint: { value: new THREE.Vector4() }, uPaint2: { value: new THREE.Vector4() } },
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
      },
    });
    this.curtainTarget = createTarget(4096, 4);
    this.auroraMat.uniforms.tCurtains.value = this.curtainTarget.texture;
    this.bloom = new Bloom({ levels: 5, threshold: 0.35, knee: 0.3, strength: 0.9, radius: 1.0 });
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
    this.auroraMat.uniforms.uSteps.value = q.steps;
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

    // --- the clock: slow ripples when quiet; with nothing playing, the old gentle idle
    const speedTarget = lerp(0.35 + 1.5 * audio.energy, lerp(P.SPEED.QUIET, P.SPEED.FULL, this.build) * st.speed, presence) * wave([0.45, 1.25]);
    this.speed = jumped ? speedTarget : follow(this.speed, speedTarget, P.SPEED.SMOOTHING / 2);
    this.time += dt * this.speed;

    // --- curtain shape and light: lerp(QUIET, FULL, build) x stage + CLIMAX x climax (idle: the plain look)
    const plain = { height: 1, width: 1, cover: 0.5, bright: 1, fold: 1 };
    for (const k of SHAPE_KEYS) {
      const c = P[k.toUpperCase()];
      this.shape[k] = lerp(plain[k], lerp(c.QUIET, c.FULL, this.build) * st[k] + c.CLIMAX * this.climax, presence);
    }
    this.shape.warm = lerp(0, lerp(P.WARM.QUIET, P.WARM.FULL, this.build) + P.WARM.CLIMAX * this.climax, presence);
    this.shape.fold *= wave(W.FOLD);
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
    this._updateWaves(dt, perf, presence, jumped);
    this.on = follow(this.on, this.onTarget, 0.25);
    this._writeAurora(wave(W.HEIGHT));

    const s = this.shared;
    s.uTime.value = this.time;
    s.uBass.value = audio.bass;
    s.uMid.value = audio.mid;
    s.uTreble.value = Math.min(1, audio.treble + this.shimmer);
    s.uEnergy.value = audio.energy;
    s.uSurge.value = this.surge;
    s.uHeight.value = this.shape.height;
    s.uWidth.value = this.shape.width;
    s.uCover.value = this.shape.cover;
    s.uFold.value = this.shape.fold;
    s.uBright.value = this.shape.bright;
    s.uWarm.value = this.shape.warm;
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
    const speedScale = lerp(S.SPEED[0], S.SPEED[1], this.amp);
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
    if (e.strength < L.MIN_STRENGTH || this.realTime - layer.lastSpawn < L.MIN_GAP) return;
    layer.lastSpawn = this.realTime;
    layer.spawned++;
    const h = clamp01(e.height);
    const S = AU.SCALE;
    const size = lerp(S.SIZE[0], S.SIZE[1], this.amp);
    const strength = lerp(0.5, 1, clamp01(e.strength));
    const hue = clamp01(lerp(L.HUE_RANGE[0], L.HUE_RANGE[1], h) + this.keyBias);
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
  _writeAurora(height) {
    const cu = this.curtainMat.uniforms;
    const au = this.auroraMat.uniforms;
    const S = AU.SCALE;
    const bright = lerp(S.BRIGHT[0], S.BRIGHT[1], this.amp);
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
        v.set(p.x, p.curtain, p.strength * this._envelope(p, L) * layer.on, this._width(p, L));
        q.set(p.hue, p.lift, L.DIRECTION * L.FRONT, 0);
      }
    });
    const M = AU.MELODY;
    const L = AU.LOW;
    const mel = this.layers.melody;
    const low = this.layers.low;
    cu.uRowHeight.value.set(M.HEIGHT * height, M.HEIGHT * height, L.HEIGHT * height, L.HEIGHT * height);
    cu.uRowHue.value.set(mel.hue, mel.hue, low.hue, low.hue);
    cu.uRowBright.value.set(M.BRIGHT * bright, M.BRIGHT * bright, L.BRIGHT * bright, L.BRIGHT * bright);
    cu.uRowBend.value.set(M.BEND, M.BEND, L.BEND, L.BEND);
    cu.uRowCurve.value.set(M.CURVE, M.CURVE, L.CURVE, L.CURVE);
    cu.uRowStria.value.set(M.STRIATION, M.STRIATION * 0.85, L.STRIATION, L.STRIATION * 0.85);
    cu.uGlow.value = AU.GLOW * this.amp;
    au.uRowSheet.value.set(M.SHEET, M.SHEET, L.SHEET, L.SHEET);
    au.uHueRot.value.set(mel.rot, mel.rot, low.rot, low.rot);
    au.uCrest.value = AU.CREST;
    au.uScreen.value = AU.BLEND === 'screen' ? 1 : 0;
    au.uCap.value = AU.CAP;
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
        speed: L.SPEED * lerp(AU.SCALE.SPEED[0], AU.SCALE.SPEED[1], this.amp),
      };
    };
    const v = this.perfVoices;
    return { amp: this.amp, on: this.onTarget > 0, low: layer('low'), melody: layer('melody'), melodyHeight: v?.melody.height ?? 0, lowNote: v?.low.note ?? -1 };
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
      aurora: `${this.onTarget > 0 ? 'on' : 'OFF (A)'} · amp ${this.amp.toFixed(2)} · packets low ${low.packets.length}/${AU.LOW.POOL}${onOff(low, 'L')} · melody ${mel.packets.length}/${AU.MELODY.POOL}${onOff(mel, 'M')}`,
      melody: { html: `${sw(this._rampHex(AU.MELODY.RAMP, mel.hue, mel.rot))} height ${(v?.melody.height ?? 0).toFixed(2)} · hue ${mel.hue.toFixed(2)} · ${(v?.melody.rate ?? 0).toFixed(1)} notes/s · spawned ${mel.spawned}/${mel.heard}` },
      'low note': { html: `${sw(this._rampHex(AU.LOW.RAMP, low.hue, low.rot))} ${v && v.low.note >= 0 ? names[v.low.note] : '-'} · height ${(v?.low.height ?? 0).toFixed(2)} · ${(v?.low.rate ?? 0).toFixed(1)} notes/s · spawned ${low.spawned}/${low.heard}` },
      voices: perf ? { html: this._voiceStrip(perf) + ' <span style="color:#b98cff">melody</span> / <span style="color:#2fd39a">low</span>' } : '-',
      'speed ×': this.speed.toFixed(2),
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
