import * as THREE from 'three';
import { SceneBase } from './SceneBase.js';
import { Bloom } from '../gl/Bloom.js';
import { precompile } from '../gl/FullscreenPass.js';
import { createTarget } from '../gl/targets.js';
import { pointer } from '../input.js';
import { createTunePanel, configParams, bindConfig } from '../tune.js';
import { SCORE_CONFIG } from '../scoreMap.js';
import { PROFILE, TUNE } from './profiles/interstellar.js';

import noiseGLSL from '../shaders/common/noise.glsl?raw';
import galaxyVert from '../shaders/galaxy/galaxy.vert?raw';
import galaxyFrag from '../shaders/galaxy/galaxy.frag?raw';
import starsVert from '../shaders/galaxy/stars.vert?raw';
import starsFrag from '../shaders/galaxy/stars.frag?raw';
import skyVert from '../shaders/galaxy/sky.vert?raw';
import skyFrag from '../shaders/galaxy/sky.frag?raw';
import skyCubeFrag from '../shaders/galaxy/skyCube.frag?raw';
import glowVert from '../shaders/galaxy/glow.vert?raw';
import coreFrag from '../shaders/galaxy/core.frag?raw';
import ringsFrag from '../shaders/galaxy/rings.frag?raw';
import farGalaxyFrag from '../shaders/galaxy/farGalaxy.frag?raw';

/**
 * Scene 5: a spiral galaxy of ~240k GPU particles in a nebula-filled sky.
 *
 * Particles store orbits (radius, angle, height) on logarithmic spiral arms;
 * galaxy.vert spins, breathes and ripples them. Dark dust lanes are a second
 * particle set drawn with multiplicative blending so they absorb starlight.
 * A nebula sphere, three parallax starfield layers and a few distant
 * galaxies fill the background; bloom adds the glow.
 *
 * Audio arrives through audio.perf (scoreMap.js), performed by
 * profiles/interstellar.js: one slowly smoothed `build` (the score's
 * anticipating drive, or the live one) sets rotation, core glow, bloom,
 * star density and how far the camera pulls back; sections set the state
 * (stillness in quiet parts, a vast opening-up at the climax); every beat
 * sends a shockwave ring from the core. Bass still breathes the arms and
 * the core, mid ripples the particles, treble makes the stars sparkle.
 */

const GALAXY_RADIUS = 10;
const MAX_STARS = 240000;
const MAX_DUST = 36000;
const QUALITY_FRACTION = [1, 0.75, 0.55, 0.38];
const ARMS = 2;
const PITCH = THREE.MathUtils.degToRad(17);
const TAN_PITCH = Math.tan(PITCH);
const ARM_START = 0.07;

const rand = (a = 0, b = 1) => a + Math.random() * (b - a);
// Box-Muller normal distribution
function gauss() {
  let u = 0;
  while (u === 0) u = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(Math.PI * 2 * Math.random());
}
/** Angle of a logarithmic spiral arm at radius r: r = a * e^(tan(pitch) * theta) */
const armAngle = (r, arm) => Math.log(Math.max(r, ARM_START) / ARM_START) / TAN_PITCH + (arm * Math.PI * 2) / ARMS;

function buildGalaxy() {
  const orbit = new Float32Array(MAX_STARS * 4);
  const seed = new Float32Array(MAX_STARS * 4);

  // star-forming clusters along the arms (pink HII regions gather here)
  const clusters = Array.from({ length: 260 }, () => {
    const r = rand(0.16, 0.95);
    const a = armAngle(r, (Math.random() * ARMS) | 0) + gauss() * 0.08;
    return [Math.cos(a) * r, Math.sin(a) * r];
  });

  for (let i = 0; i < MAX_STARS; i++) {
    const u = Math.random();
    const type = u < 0.13 ? 0 : u < 0.62 ? 1 : u < 0.83 ? 2 : u < 0.92 ? 3 : 4;
    let r;
    let a;
    let y;
    let size;
    let bright;
    const arm = (Math.random() * ARMS) | 0;
    switch (type) {
      case 0: // bulge: dense, warm, slightly flattened
        r = Math.abs(gauss()) * 0.085 + Math.random() * 0.015;
        a = Math.random() * Math.PI * 2;
        y = gauss() * 0.05 * Math.max(0.2, 1 - r * 6);
        size = rand(1.0, 1.9);
        bright = rand(0.45, 1.0);
        break;
      case 1: // old disk stars, loosely following the arms
        r = Math.min(1.2, 0.03 - Math.log(1 - Math.random() * 0.98) * 0.3);
        a = Math.random() < 0.55 ? armAngle(r, arm) + gauss() * 0.75 * (0.35 + r) : Math.random() * Math.PI * 2;
        y = gauss() * 0.02;
        size = rand(0.9, 1.7);
        bright = rand(0.18, 0.45);
        break;
      case 2: // young blue stars hug the arms tightly
        r = 0.12 + Math.pow(Math.random(), 0.85) * 0.92;
        a = armAngle(r, arm) + gauss() * 0.24 + 0.06;
        y = gauss() * 0.008;
        size = rand(1.1, 2.4);
        bright = rand(0.6, 1.4);
        break;
      case 3: {
        // pink HII glows around the clusters
        const c = clusters[(Math.random() * clusters.length) | 0];
        const x = c[0] + gauss() * 0.022;
        const z = c[1] + gauss() * 0.022;
        r = Math.hypot(x, z);
        a = Math.atan2(z, x);
        y = gauss() * 0.006;
        size = rand(3.5, 8);
        bright = rand(0.05, 0.13);
        break;
      }
      default: // violet dust glow on the inner edge of the arms
        r = 0.1 + Math.random() * 0.9;
        a = armAngle(r, arm) - 0.14 + gauss() * 0.32;
        y = gauss() * 0.012;
        size = rand(6, 12);
        bright = rand(0.018, 0.045);
    }
    orbit.set([r, a, y, type], i * 4);
    seed.set([size, Math.random(), Math.random(), bright], i * 4);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_STARS * 3), 3));
  geo.setAttribute('aOrbit', new THREE.BufferAttribute(orbit, 4));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
  return geo;
}

function buildDust() {
  const orbit = new Float32Array(MAX_DUST * 4);
  const seed = new Float32Array(MAX_DUST * 4);
  for (let i = 0; i < MAX_DUST; i++) {
    const r = 0.1 + Math.pow(Math.random(), 0.8) * 0.88;
    const a = armAngle(r, i % ARMS) - 0.22 + gauss() * 0.1;
    orbit.set([r, a, gauss() * 0.005, 5], i * 4);
    seed.set([rand(6, 14), Math.random(), Math.random(), rand(0.15, 0.35) * Math.min(1, r * 4)], i * 4);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_DUST * 3), 3));
  geo.setAttribute('aOrbit', new THREE.BufferAttribute(orbit, 4));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
  return geo;
}

function buildStarLayer(count, rMin, rMax, sizeMin, sizeMax, brightness) {
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const seedArr = new Float32Array(count);
  const v = new THREE.Vector3();
  const tints = [new THREE.Color(0xaec8ff), new THREE.Color(0xffffff), new THREE.Color(0xffe2b8), new THREE.Color(0xffc4a0)];
  for (let i = 0; i < count; i++) {
    v.set(gauss(), gauss(), gauss()).normalize().multiplyScalar(rand(rMin, rMax));
    pos.set([v.x, v.y, v.z], i * 3);
    const c = tints[(Math.random() * tints.length) | 0];
    const b = brightness * Math.pow(Math.random(), 2.2) + brightness * 0.08;
    col.set([c.r * b, c.g * b, c.b * b], i * 3);
    size[i] = rand(sizeMin, sizeMax);
    seedArr[i] = Math.random();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seedArr, 1));
  return geo;
}

export default class Scene5Galaxy extends SceneBase {
  constructor() {
    super({ baseSpeed: 0.4, speedGain: 1.3 });
    this.renderScale = 0.9;
    this.toneMapped = true;
    this.exposure = 1.0;
    this.rotation = 0;
    this.lastBeat = -1;
    this.waves = [];
    this.parallax = new THREE.Vector2();
    // performance state (profiles/interstellar.js)
    this.stage = { ...PROFILE.STAGES.calm };
    this.build = 0;
    this.climax = 0;
    this.pull = 0;
    this.speed = 0.5;
    this.starShare = 1;
    this.jumpId = -1;
  }

  async init(renderer) {
    await super.init(renderer);
    const scene = (this.scene = new THREE.Scene());
    this.camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 3000);
    this.disposables = [];
    const track = (o) => (this.disposables.push(o), o);

    const shared = {
      uTime: { value: 0 },
      uBass: { value: 0 },
      uMid: { value: 0 },
      uTreble: { value: 0 },
      uScale: { value: 1 },
    };
    this.shared = shared;
    const additive = { transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending };

    // nebula backdrop: the fbm clouds are expensive and static, so they are
    // rendered once into a cubemap and the visible sphere just samples it
    const skyGeo = track(new THREE.SphereGeometry(1500, 48, 24));
    const bakeScene = new THREE.Scene();
    const bakeMat = new THREE.ShaderMaterial({
      vertexShader: skyVert,
      fragmentShader: noiseGLSL + skyFrag,
      uniforms: { uTime: { value: 0 }, uBass: { value: 0 } },
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
    });
    bakeScene.add(new THREE.Mesh(skyGeo, bakeMat));
    this.skyCube = track(new THREE.WebGLCubeRenderTarget(512, { type: THREE.HalfFloatType, generateMipmaps: false }));
    new THREE.CubeCamera(1, 3000, this.skyCube).update(renderer, bakeScene);
    bakeMat.dispose();

    const sky = new THREE.Mesh(
      skyGeo,
      track(
        new THREE.ShaderMaterial({
          vertexShader: skyVert,
          fragmentShader: skyCubeFrag,
          uniforms: { tSky: { value: this.skyCube.texture }, uBass: shared.uBass },
          side: THREE.BackSide,
          depthTest: false,
          depthWrite: false,
        }),
      ),
    );
    sky.renderOrder = 0;
    scene.add(sky);

    // three starfield layers at different depths -> parallax as the camera drifts
    const starMat = track(
      new THREE.ShaderMaterial({
        vertexShader: starsVert,
        fragmentShader: starsFrag,
        uniforms: { uTime: shared.uTime, uTreble: shared.uTreble, uScale: shared.uScale },
        ...additive,
      }),
    );
    for (const [count, rMin, rMax, sMin, sMax, b] of [
      [9000, 700, 1300, 1.0, 2.0, 0.9],
      [3500, 220, 450, 1.2, 2.4, 1.1],
      [700, 60, 160, 1.6, 3.2, 1.3],
    ]) {
      const pts = new THREE.Points(track(buildStarLayer(count, rMin, rMax, sMin, sMax, b)), starMat);
      pts.frustumCulled = false;
      pts.renderOrder = 1;
      scene.add(pts);
    }

    // a few distant galaxies
    for (let i = 0; i < 7; i++) {
      const mat = track(
        new THREE.ShaderMaterial({
          vertexShader: glowVert,
          fragmentShader: farGalaxyFrag,
          uniforms: {
            uColor: { value: new THREE.Color().setHSL(rand(0.05, 0.12) + (i % 3 === 0 ? 0.5 : 0), 0.5, 0.6).multiplyScalar(rand(0.3, 0.7)) },
            uTilt: { value: rand(0.25, 0.9) },
            uSpin: { value: rand(0, Math.PI) },
          },
          ...additive,
        }),
      );
      const q = new THREE.Mesh(track(new THREE.PlaneGeometry(1, 1)), mat);
      const dir = new THREE.Vector3(gauss(), gauss() * 0.6, gauss()).normalize();
      if (Math.abs(dir.y) < 0.15) dir.y += 0.3 * Math.sign(dir.y || 1);
      q.position.copy(dir.normalize().multiplyScalar(rand(500, 800)));
      q.scale.setScalar(rand(14, 30));
      q.renderOrder = 2;
      q.userData.billboard = true;
      scene.add(q);
    }

    // the galaxy itself
    this.galaxyUniforms = {
      ...shared,
      uRotation: { value: 0 },
      uRadius: { value: GALAXY_RADIUS },
      uWaves: { value: Array.from({ length: 4 }, () => new THREE.Vector4()) },
    };
    this.stars = new THREE.Points(
      track(buildGalaxy()),
      track(new THREE.ShaderMaterial({ vertexShader: galaxyVert, fragmentShader: galaxyFrag, uniforms: this.galaxyUniforms, ...additive })),
    );
    this.stars.frustumCulled = false;
    this.stars.renderOrder = 3;
    scene.add(this.stars);

    // dust lanes: dst *= (1 - src) absorbs the light already drawn
    this.dust = new THREE.Points(
      track(buildDust()),
      track(
        new THREE.ShaderMaterial({
          vertexShader: galaxyVert,
          fragmentShader: galaxyFrag,
          uniforms: this.galaxyUniforms,
          defines: { DUST: 1 },
          transparent: true,
          depthTest: false,
          depthWrite: false,
          blending: THREE.CustomBlending,
          blendEquation: THREE.AddEquation,
          blendSrc: THREE.ZeroFactor,
          blendDst: THREE.OneMinusSrcColorFactor,
        }),
      ),
    );
    this.dust.frustumCulled = false;
    this.dust.renderOrder = 4;
    scene.add(this.dust);

    // shockwave rings in the galactic plane
    const ringSize = GALAXY_RADIUS * 2.8;
    this.rings = new THREE.Mesh(
      track(new THREE.PlaneGeometry(ringSize, ringSize)),
      track(
        new THREE.ShaderMaterial({
          vertexShader: glowVert,
          fragmentShader: ringsFrag,
          uniforms: { uWaves: this.galaxyUniforms.uWaves, uRadiusScale: { value: ringSize / 2 / GALAXY_RADIUS } },
          ...additive,
          side: THREE.DoubleSide,
        }),
      ),
    );
    this.rings.rotation.x = -Math.PI / 2;
    this.rings.renderOrder = 5;
    scene.add(this.rings);

    // core glow, always facing the camera
    this.coreUniforms = { uIntensity: { value: 1 } };
    this.core = new THREE.Mesh(
      track(new THREE.PlaneGeometry(GALAXY_RADIUS * 0.9, GALAXY_RADIUS * 0.9)),
      track(new THREE.ShaderMaterial({ vertexShader: glowVert, fragmentShader: coreFrag, uniforms: this.coreUniforms, ...additive })),
    );
    this.core.renderOrder = 6;
    scene.add(this.core);

    this.bloom = new Bloom({ levels: 6, threshold: 0.95, knee: 0.5, strength: 0.75 });
    this.tune = createTunePanel({ title: 'Galaxy · Interstellar', storageKey: 'resonance.tune.galaxy', params: configParams(PROFILE, TUNE), onChange: bindConfig(PROFILE) });
    this._applyQuality();
    this.camera.position.set(0, 6, 16);
    this.camera.lookAt(0, 0, 0);
    await precompile(renderer, scene, this.camera);
  }

  _applyQuality() {
    const f = QUALITY_FRACTION[this.quality] ?? 1;
    // the music lights a share of the stars (starShare); quality caps the total
    this.stars?.geometry.setDrawRange(0, Math.floor(MAX_STARS * f * this.starShare));
    this.dust?.geometry.setDrawRange(0, Math.floor(MAX_DUST * Math.max(0.6, f)));
  }

  setQuality(level) {
    super.setQuality(level);
    this._applyQuality();
  }

  resize(width, height) {
    super.resize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    // pull the camera back on narrow/portrait screens so the disk still fits
    this.distScale = Math.min(2.2, Math.max(1, 1.35 / this.camera.aspect));
    this.shared.uScale.value = height / 900;
    if (!this.sceneTarget) this.sceneTarget = createTarget(width, height);
    else this.sceneTarget.setSize(width, height);
    this.bloom.setSize(width, height);
  }

  update(dt, audio) {
    const P = PROFILE;
    const perf = audio.perf;
    const presence = audio.presence;
    const follow = (v, to, tau) => v + (to - v) * (1 - Math.exp(-dt / tau));
    const lerp = (a, b, x) => a + (b - a) * x;
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

    // --- build: the drive, slowly smoothed; the one value behind the whole galaxy
    const B = P.BUILD;
    const buildTarget = presence * Math.pow(perf.drive, B.CURVE);
    this.build = jumped ? buildTarget : follow(this.build, buildTarget, buildTarget > this.build ? B.ATTACK : B.RELEASE);
    this.climax = jumped ? perf.climax * presence : follow(this.climax, perf.climax * presence, 0.8);
    const build = this.build;
    const open = Math.max(st.pull * build, this.climax); // how far the view opens

    // --- the clock: nearly still in quiet parts; with nothing playing, the old gentle idle
    const speedTarget = lerp(0.4 + 1.3 * audio.energy, lerp(P.SPEED.STILL, P.SPEED.FULL, build) * st.speed, presence);
    this.speed = jumped ? speedTarget : follow(this.speed, speedTarget, P.SPEED.SMOOTHING / 2);
    const sdt = dt * this.speed;
    this.time += sdt;
    const t = this.time;
    const s = this.shared;
    s.uTime.value = t;
    s.uBass.value = audio.bass;
    s.uMid.value = audio.mid;
    s.uTreble.value = audio.treble;

    // negative rotation keeps the logarithmic arms trailing
    this.rotation -= sdt * 0.045;
    this.galaxyUniforms.uRotation.value = this.rotation;

    // beats (the repeating pattern) launch shockwave rings from the core, none in the stillness
    const R = P.RINGS;
    if (perf.beatId !== this.lastBeat) {
      this.lastBeat = perf.beatId;
      const amp = lerp(0.7 + 0.5 * audio.energy, st.rings * lerp(R.STRENGTH[0], R.STRENGTH[1], build) * Math.min(1, Math.max(0, (perf.drive - R.MIN_DRIVE) / (1 - R.MIN_DRIVE)) * 2), presence);
      if (amp > 0.05) {
        if (this.waves.length >= 4) this.waves.shift();
        this.waves.push({ r: 0.03, s: amp });
      }
    }
    const ringSpeed = lerp(0.32 + 0.3 * audio.energy, lerp(R.SPEED[0], R.SPEED[1], build), presence);
    for (const w of this.waves) {
      w.r += dt * ringSpeed;
      w.s *= Math.exp(-dt * 0.8);
    }
    this.waves = this.waves.filter((w) => w.r < 1.4 && w.s > 0.02);
    const wu = this.galaxyUniforms.uWaves.value;
    for (let i = 0; i < 4; i++) {
      const w = this.waves[i];
      wu[i].set(w ? w.r : 10, w ? w.s : 0, 0, 0);
    }

    // --- light: core glow, bloom, exposure and star density follow the build; the climax flares
    const C = P.CORE;
    const core = (lerp(C.QUIET, C.FULL, build) * st.core + C.CLIMAX * this.climax + C.BASS * audio.bass * presence) * (1 + 0.25 * audio.beat * presence);
    this.coreUniforms.uIntensity.value = lerp(0.45 + audio.bass * 0.8 + audio.beat * 0.25, core, presence);
    this.bloom.strength = lerp(0.75, lerp(P.BLOOM.QUIET, P.BLOOM.FULL, build) + P.BLOOM.CLIMAX * this.climax, presence);
    this.exposure = lerp(1, lerp(P.EXPOSURE.QUIET, P.EXPOSURE.FULL, build) + P.EXPOSURE.CLIMAX * this.climax, presence);
    const share = lerp(1, lerp(P.STARS.QUIET, P.STARS.FULL, Math.max(build, this.climax)), presence);
    if (Math.abs(share - this.starShare) > 0.002) {
      this.starShare = share;
      this._applyQuality();
    }

    // --- camera: a slow orbit; the music pulls it back and up, opening the view at the climax
    const Cam = P.CAMERA;
    this.pull = jumped ? open * presence : follow(this.pull, open * presence, Cam.SMOOTHING);
    const az = t * 0.05 + 0.6;
    const el = 0.4 + 0.13 * Math.sin(t * 0.043) + Cam.RISE * this.pull;
    const dist = (17 + 2.2 * Math.sin(t * 0.031)) * (this.distScale ?? 1) * (1 + Cam.PULL * this.pull);
    const cam = this.camera;
    cam.position.set(Math.sin(az) * Math.cos(el) * dist, Math.sin(el) * dist, Math.cos(az) * Math.cos(el) * dist);

    // mouse parallax, smoothed
    const k = 1 - Math.exp(-dt * 2.5);
    this.parallax.x += (pointer.nx - this.parallax.x) * k;
    this.parallax.y += (pointer.ny - this.parallax.y) * k;
    cam.lookAt(0, 0, 0);
    cam.translateX(this.parallax.x * 1.6);
    cam.translateY(this.parallax.y * 1.0);
    cam.lookAt(0, 0.4 * Math.sin(t * 0.07), 0);

    for (const o of this.scene.children) if (o.userData.billboard) o.quaternion.copy(cam.quaternion);
    this.core.quaternion.copy(cam.quaternion);
  }

  render(target) {
    const r = this.renderer;
    r.setRenderTarget(this.sceneTarget);
    r.setClearColor(0x000000, 1);
    r.clear(true, false, false);
    r.render(this.scene, this.camera);
    this.bloom.render(r, this.sceneTarget.texture, target);
  }

  /** Live values for the debug overlay (D). */
  get debug() {
    const st = this.stage;
    return {
      'speed ×': this.speed.toFixed(2),
      build: `${this.build.toFixed(2)} · climax ${this.climax.toFixed(2)} · pull ${this.pull.toFixed(2)}`,
      light: `core ${this.coreUniforms.uIntensity.value.toFixed(2)} · bloom ${this.bloom.strength.toFixed(2)} · exposure ${this.exposure.toFixed(2)}`,
      stars: `${(this.starShare * 100).toFixed(0)} %`,
      state: `speed ${st.speed.toFixed(2)} · core ${st.core.toFixed(2)} · rings ${st.rings.toFixed(2)}`,
    };
  }

  dispose() {
    this.tune?.dispose();
    for (const d of this.disposables ?? []) d.dispose();
    this.sceneTarget?.dispose();
    this.bloom?.dispose();
  }
}
