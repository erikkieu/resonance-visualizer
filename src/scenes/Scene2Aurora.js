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
 */

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
    };
    const prefix = noiseGLSL + commonGLSL;
    this.auroraMat = passMaterial({
      fragmentShader: prefix + auroraFrag,
      uniforms: { ...this.shared, uSteps: { value: 34 }, tCurtains: { value: null } },
    });
    this.landMat = passMaterial({
      fragmentShader: prefix + landscapeFrag,
      uniforms: { ...this.shared, tAurora: { value: null }, tTerrain: { value: null }, tAmbient: { value: null } },
    });
    this.terrainMat = passMaterial({ fragmentShader: prefix + terrainFrag, uniforms: { ...this.shared } });
    this.ambientMat = passMaterial({ fragmentShader: ambientFrag, uniforms: { tAurora: { value: null } } });
    this.ambientTarget = createTarget(1, 1);
    this.curtainMat = passMaterial({ fragmentShader: prefix + curtainsFrag, uniforms: { ...this.shared } });
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

    // --- the clock: slow ripples when quiet; with nothing playing, the old gentle idle
    const speedTarget = lerp(0.35 + 1.5 * audio.energy, lerp(P.SPEED.QUIET, P.SPEED.FULL, this.build) * st.speed, presence);
    this.speed = jumped ? speedTarget : follow(this.speed, speedTarget, P.SPEED.SMOOTHING / 2);
    this.time += dt * this.speed;

    // --- curtain shape and light: lerp(QUIET, FULL, build) x stage + CLIMAX x climax (idle: the plain look)
    const plain = { height: 1, width: 1, cover: 0.5, bright: 1, fold: 1 };
    for (const k of SHAPE_KEYS) {
      const c = P[k.toUpperCase()];
      this.shape[k] = lerp(plain[k], lerp(c.QUIET, c.FULL, this.build) * st[k] + c.CLIMAX * this.climax, presence);
    }
    this.shape.warm = lerp(0, lerp(P.WARM.QUIET, P.WARM.FULL, this.build) + P.WARM.CLIMAX * this.climax, presence);
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

  /** Live values for the debug overlay (D). */
  get debug() {
    const sh = this.shape;
    return {
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
