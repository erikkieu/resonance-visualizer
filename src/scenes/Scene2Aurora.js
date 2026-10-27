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
 * The curtains move like an audio wave (PROFILE.AURORA): the live spectrum
 * runs along them as an equaliser (48 log bands, low notes left, high
 * right), every note onset sends a pulse travelling along the curtain its
 * pitch belongs to (high notes the nearest curtain, which spans the upper
 * sky), and the melody sets the colour along a green -> teal -> blue ->
 * violet -> pink ramp, each curtain gliding toward the hue of the notes it
 * receives. Amplitude follows the anticipating drive, the climax and the
 * section stage. A soft per-pixel cap keeps the climax from washing out.
 * The A key fades the aurora out and in, for comparison.
 */

const AU = PROFILE.AURORA;
// ramp stops as linear light at full intensity (brightest channel = 1): the ramp sets the hue,
// the curtain sets the brightness, like the original HDR aurora colours (a plain hex is far dimmer)
const hexToLinear = (hex) => {
  const c = new THREE.Color(hex); // THREE.Color stores linear (colour management on)
  return c.multiplyScalar(1 / Math.max(c.r, c.g, c.b, 1e-4));
};
// band edges of the equaliser, log-spaced (Hz)
const bandEdges = (lo, hi, n) => Array.from({ length: n + 1 }, (_, i) => lo * Math.pow(hi / lo, i / n));

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
    // the audio-wave aurora (PROFILE.AURORA)
    this.amp = 0;
    this.spec = new Float32Array(AU.SPECTRUM.BANDS);
    this.pulses = [];
    this.pulseBudget = 0;
    this.pulsesFired = 0;
    this.baseHue = 0.3; // ramp position the melody points at (smoothed)
    this.keyBias = 0;
    this.ribbons = Array.from({ length: AU.RIBBONS }, () => ({ hue: 0.3, rot: 0, noteHue: 0.3, noteRot: 0, noteAt: -1e9 }));
    this.realTime = 0;
    this.on = 1; // A toggles the aurora
    this.onTarget = 1;
    this._onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.key.toLowerCase() !== 'a') return;
      if (e.target instanceof HTMLInputElement && e.target.type !== 'range') return;
      this.onTarget = this.onTarget > 0 ? 0 : 1;
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
      // the audio-wave aurora
      uAmp: { value: 0 },
      uTopScale: { value: 1.6 },
    };
    const top = Math.max(...AU.WAVE.HEIGHT) * (1 + AU.SPECTRUM.HEIGHT) + AU.PULSE.LIFT;
    this.shared.uTopScale.value = top;
    const prefix = noiseGLSL + commonGLSL;
    this.auroraMat = passMaterial({
      fragmentShader: prefix + auroraFrag,
      uniforms: {
        ...this.shared,
        uSteps: { value: 34 },
        tCurtains: { value: null },
        uRamp: { value: AU.RAMP.map(([, hex]) => hexToLinear(hex)) },
        uRampAt: { value: AU.RAMP.map(([at]) => at) },
        uHueRot: { value: new THREE.Vector3() },
        uCrest: { value: AU.HUE.CREST },
        uCap: { value: AU.CAP },
        uOn: { value: 1 },
      },
    });
    this.landMat = passMaterial({
      fragmentShader: prefix + landscapeFrag,
      uniforms: { ...this.shared, tAurora: { value: null }, tTerrain: { value: null }, tAmbient: { value: null } },
    });
    this.terrainMat = passMaterial({ fragmentShader: prefix + terrainFrag, uniforms: { ...this.shared } });
    this.ambientMat = passMaterial({ fragmentShader: ambientFrag, uniforms: { tAurora: { value: null } } });
    this.ambientTarget = createTarget(1, 1);
    this.curtainMat = passMaterial({
      fragmentShader: prefix + curtainsFrag,
      uniforms: {
        ...this.shared,
        uSpec: { value: this.spec },
        uPulse: { value: Array.from({ length: AU.PULSE.MAX }, () => new THREE.Vector4()) },
        uPulseHue: { value: new Float32Array(AU.PULSE.MAX) },
        uRibbonHue: { value: new THREE.Vector3() },
        uRibbonHeight: { value: new THREE.Vector3(1, 1, 1) },
        uSpecHeight: { value: AU.SPECTRUM.HEIGHT },
        uSpecBright: { value: AU.SPECTRUM.BRIGHT },
        uPulseBright: { value: AU.PULSE.BRIGHT },
        uPulseLift: { value: AU.PULSE.LIFT },
      },
    });
    this.curtainTarget = createTarget(4096, 3);
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
    const W = AU.WAVE;
    const wave = (range) => lerp(1, lerp(range[0], range[1], this.amp), presence); // idle: the plain look

    // --- the clock: slow ripples when quiet; with nothing playing, the old gentle idle
    const speedTarget = lerp(0.35 + 1.5 * audio.energy, lerp(P.SPEED.QUIET, P.SPEED.FULL, this.build) * st.speed, presence) * wave(W.SPEED);
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
    this.shape.bright *= wave(W.BRIGHT);
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
    this._updateSpectrum(dt, audio, jumped);
    this._updatePulses(dt, audio, perf, presence, jumped);
    this._updateHues(dt, audio, perf, presence, jumped);
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

  // ------------------------------------------------------------ audio-wave aurora

  /**
   * The equaliser: the live spectrum in log-spaced bands (low notes left,
   * high right), gated and curved so quiet bands stay down, smoothed with a
   * fast attack and a slow release.
   */
  _updateSpectrum(dt, audio, jumped) {
    const S = AU.SPECTRUM;
    const f = audio.freqData;
    const rate = audio.ctx?.sampleRate;
    if (!this._edges || this._edgeRate !== rate || this._edgeLen !== f?.length) {
      this._edgeRate = rate;
      this._edgeLen = f?.length;
      const hzPerBin = rate && f ? rate / (f.length * 2) : 1;
      this._edges = bandEdges(S.HZ[0], S.HZ[1], S.BANDS).map((hz) => Math.floor(hz / hzPerBin));
    }
    for (let b = 0; b < S.BANDS; b++) {
      let v = 0;
      if (f && rate) {
        const lo = this._edges[b];
        const hi = Math.max(lo + 1, this._edges[b + 1]);
        for (let i = lo; i < hi && i < f.length; i++) v = Math.max(v, f[i]);
        v = Math.pow(Math.max(0, (v / 255 - S.GATE) / (1 - S.GATE)), S.CURVE);
      }
      const cur = this.spec[b];
      this.spec[b] = jumped ? v : cur + (v - cur) * (1 - Math.exp(-dt / (v > cur ? S.ATTACK : S.RELEASE)));
    }
  }

  /** Pitch class (0..11) of the current note: from the melody frequency, else the strongest chroma bin. */
  _pitchClass(perf, audio) {
    if (perf.pitchHz > 0) return (((Math.round(12 * Math.log2(perf.pitchHz / 440)) + 9) % 12) + 12) % 12;
    const c = perf.chroma ?? audio.chroma;
    let best = 0;
    for (let i = 1; i < 12; i++) if (c[i] > c[best]) best = i;
    return best;
  }

  /** Pitch class -> a small hue twist (radians), on the circle of fifths so related notes twist alike. */
  _twist(pc) {
    return ((AU.HUE.CHROMA_DEG * Math.sin(((pc * 7) % 12) / 12 * Math.PI * 2)) * Math.PI) / 180;
  }

  /** The ramp position of a note at pitch height h (with the key's bias). */
  _noteHue(h) {
    const H = AU.HUE;
    return Math.min(1, Math.max(0, lerp(H.RANGE[0], H.RANGE[1], h) + this.keyBias));
  }

  /**
   * Note onsets -> pulses travelling along the curtain their pitch belongs
   * to (high notes the nearest curtain, which spans the upper sky), starting
   * where the note sits on the equaliser. Melody notes are full strength,
   * the accompaniment weaker and rate-limited.
   */
  _updatePulses(dt, audio, perf, presence, jumped) {
    const P = AU.PULSE;
    if (jumped) this.pulses.length = 0;
    this.pulseBudget = Math.min(P.MAX_PER_SECOND * 0.5, this.pulseBudget + dt * P.MAX_PER_SECOND);
    const last = AU.RIBBONS - 1;
    for (const o of perf.onsets) {
      if (presence < 0.3) continue;
      if (!o.melody && this.pulseBudget < 1) continue;
      this.pulseBudget = Math.max(0, this.pulseBudget - 1);
      const h = Math.min(1, Math.max(0, o.height));
      const k = Math.min(last, Math.max(0, Math.round((1 - h) * last)));
      const hue = this._noteHue(h);
      const strength = o.strength * (o.melody ? 1 : P.ACCOMPANIMENT) * lerp(0.5, 1, perf.level);
      this.pulses.push({ x0: lerp(P.X[0], P.X[1], h), k, age: 0, strength, hue });
      if (this.pulses.length > P.MAX) this.pulses.shift();
      this.pulsesFired++;
      if (o.melody) {
        // the curtain glides toward this note's colour
        const r = this.ribbons[k];
        r.noteHue = hue;
        r.noteRot = this._twist(this._pitchClass(perf, audio));
        r.noteAt = this.realTime;
      }
    }
    for (const p of this.pulses) p.age += dt;
    this.pulses = this.pulses.filter((p) => p.age < P.LIFE);
  }

  /**
   * Colour: the melody's pitch height moves the base along the ramp (minor
   * keys bluer, major greener), the curtains fan out around it (more at the
   * climax), and each curtain glides to the hue of the melody notes it
   * receives, then back.
   */
  _updateHues(dt, audio, perf, presence, jumped) {
    const H = AU.HUE;
    const k = (tau) => (jumped ? 1 : 1 - Math.exp(-dt / tau));
    const scored = perf.source === 'score';
    const height = scored ? (perf.heightConf > 0.25 ? perf.height : null) : audio.pitchHeight;
    if (height != null && presence > 0.3) this.baseHue += (lerp(H.RANGE[0], H.RANGE[1], height) - this.baseHue) * k(H.MELODY_SMOOTHING);
    this.keyBias += ((H.KEY_BIAS[perf.key?.mode] ?? 0) - this.keyBias) * k(H.KEY_SMOOTHING);
    const spread = lerp(H.SPREAD[0], H.SPREAD[1], this.amp);
    const last = AU.RIBBONS - 1;
    this.ribbons.forEach((r, i) => {
      const held = this.realTime - r.noteAt < H.HOLD;
      // nearer curtains sit higher in the sky and further up the ramp
      const base = Math.min(1, Math.max(0, this.baseHue + this.keyBias + (last / 2 - i) * spread));
      const tau = held ? H.ATTACK : H.RELEASE;
      r.hue += ((held ? lerp(base, r.noteHue, H.PULL) : base) - r.hue) * k(tau);
      r.rot += ((held ? r.noteRot : 0) - r.rot) * k(tau);
    });
  }

  /** Hands the aurora state to the curtain and aurora passes. */
  _writeAurora(height) {
    const P = AU.PULSE;
    const cu = this.curtainMat.uniforms;
    const au = this.auroraMat.uniforms;
    this.shared.uAmp.value = this.amp;
    const speed = lerp(P.SPEED[0], P.SPEED[1], this.amp);
    cu.uPulse.value.forEach((v, i) => {
      const p = this.pulses[i];
      if (!p) return v.set(0, 0, 0, 0.05);
      const env = (1 - Math.exp(-p.age / P.ATTACK)) * Math.exp(-Math.max(0, p.age - P.ATTACK) / P.DECAY);
      v.set(p.x0 + speed * p.age, p.k, p.strength * env, lerp(P.WIDTH[0], P.WIDTH[1], p.age / P.LIFE));
      cu.uPulseHue.value[i] = p.hue;
    });
    const [r0, r1, r2] = this.ribbons;
    cu.uRibbonHue.value.set(r0.hue, r1.hue, r2.hue);
    cu.uRibbonHeight.value.setScalar(height);
    cu.uSpecHeight.value = AU.SPECTRUM.HEIGHT;
    cu.uSpecBright.value = AU.SPECTRUM.BRIGHT;
    cu.uPulseBright.value = P.BRIGHT;
    cu.uPulseLift.value = P.LIFT;
    au.uHueRot.value.set(r0.rot, r1.rot, r2.rot);
    au.uCap.value = AU.CAP;
    au.uOn.value = this.on;
  }

  /** Ramp colour (sRGB hex) at position h, for the debug swatches. */
  _rampHex(h, rot = 0) {
    const R = AU.RAMP;
    const c = new THREE.Color(R[0][1]);
    for (let i = 1; i < R.length; i++) {
      const f = Math.min(1, Math.max(0, (h - R[i - 1][0]) / (R[i][0] - R[i - 1][0])));
      c.lerp(new THREE.Color(R[i][1]), f * f * (3 - 2 * f));
    }
    if (rot) c.offsetHSL(rot / (Math.PI * 2), 0, 0);
    return '#' + c.getHexString();
  }

  /** Aurora state for the verify script. */
  get auroraState() {
    const hues = this.ribbons.map((r) => r.hue);
    return { amp: this.amp, pulses: this.pulses.length, fired: this.pulsesFired, hue: hues.reduce((a, b) => a + b, 0) / hues.length, hues, on: this.onTarget > 0 };
  }

  /** Live values for the debug overlay (D). */
  get debug() {
    const sh = this.shape;
    const sw = (c) => `<span class="debug-swatch" style="background:${c}"></span>`;
    const name = (h) => ['green', 'teal', 'blue', 'violet', 'purple', 'pink'][Math.min(5, Math.floor(h * 6))];
    const spec = Array.from(this.spec).reduce((a, b) => a + b, 0) / this.spec.length;
    return {
      aurora: `${this.onTarget > 0 ? 'on' : 'OFF (A)'} · amp ${this.amp.toFixed(2)} · pulses ${this.pulses.length} (fired ${this.pulsesFired})`,
      'aurora hue': { html: `${this.ribbons.map((r) => sw(this._rampHex(r.hue, r.rot))).join('')} ${this.ribbons.map((r) => `${r.hue.toFixed(2)} ${name(r.hue)}`).join(' · ')}` },
      'hue drivers': `melody ${this.baseHue.toFixed(2)} · key ${this.keyBias >= 0 ? '+' : ''}${this.keyBias.toFixed(2)} (${this.keyBias > 0.02 ? 'minor' : this.keyBias < -0.02 ? 'major' : '-'}) · spectrum ${spec.toFixed(2)}`,
      'speed ×': this.speed.toFixed(2),
      build: `${this.build.toFixed(2)} · climax ${this.climax.toFixed(2)} · exposure ${this.exposure.toFixed(2)}`,
      curtains: `height ${sh.height.toFixed(2)} · width ${sh.width.toFixed(2)} · cover ${sh.cover.toFixed(2)}`,
      light: `bright ${sh.bright.toFixed(2)} · warm ${sh.warm.toFixed(2)} · fold ${sh.fold.toFixed(2)}`,
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
