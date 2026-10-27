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
import resonantVert from '../shaders/galaxy/resonant.vert?raw';
import resonantFrag from '../shaders/galaxy/resonant.frag?raw';
import meteorFrag from '../shaders/galaxy/meteor.frag?raw';
import occludeGLSL from '../shaders/galaxy/occlude.glsl?raw';
import lightVert from '../shaders/galaxy/light.vert?raw';
import lightFrag from '../shaders/galaxy/light.frag?raw';

/**
 * Scene 5: a spiral galaxy of ~240k GPU particles in a nebula-filled sky.
 *
 * Particles store orbits (radius, angle, height) on logarithmic spiral arms;
 * galaxy.vert spins, breathes and ripples them. Dark dust lanes are a second
 * particle set drawn with multiplicative blending so they absorb starlight.
 * A nebula sphere, three parallax starfield layers and a few distant
 * galaxies fill the background; bloom adds the glow. A resonant starfield
 * spreads stars over every depth, and a share of them are tuned to one of
 * eight frequency bands: they swell and glow when their band rises above
 * its own recent average (low bands warm, high bands ice blue).
 *
 * Audio arrives through audio.perf (scoreMap.js), performed by
 * profiles/interstellar.js: one slowly smoothed `build` (the score's
 * anticipating drive, or the live one) sets rotation, core glow, bloom,
 * star density and how far the camera pulls back; sections set the state
 * (stillness in quiet parts, a vast opening-up at the climax); every beat
 * sends a faint shockwave ring from the core. The camera and the sky stay
 * still: the galaxy's body (stars, dust, rings) instead tilts toward the
 * viewer, leans and grows with the music on slow damped springs
 * (_moveBody). Beat-level pulsing (bass breathing, mid ripples, core
 * flicker) is scaled down by PROFILE.PULSE; treble makes the stars sparkle.
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

/**
 * Fine far stardust: tiny faint points in the galaxy's own palette, part of
 * them gathered in a soft band across the sky (a great circle, tilted).
 */
function buildStardust(D) {
  const count = D.COUNT;
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const seedArr = new Float32Array(count);
  const tints = [new THREE.Color(1.0, 0.9, 0.78), new THREE.Color(0.85, 0.88, 1.0), new THREE.Color(0.6, 0.74, 1.0), new THREE.Color(0.95, 0.55, 0.8), new THREE.Color(0.65, 0.45, 0.95)];
  const weights = [0.34, 0.3, 0.18, 0.1, 0.08];
  const pick = () => {
    let u = Math.random();
    for (let k = 0; k < weights.length; k++) if ((u -= weights[k]) < 0) return tints[k];
    return tints[0];
  };
  const v = new THREE.Vector3();
  const tilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.5, 0.3, 0.9));
  for (let i = 0; i < count; i++) {
    if (Math.random() < D.BAND) {
      const a = Math.random() * Math.PI * 2;
      const lat = gauss() * D.BAND_WIDTH;
      v.set(Math.cos(a) * Math.cos(lat), Math.sin(lat), Math.sin(a) * Math.cos(lat)).applyQuaternion(tilt);
    } else v.set(gauss(), gauss(), gauss()).normalize();
    v.multiplyScalar(rand(D.DEPTH[0], D.DEPTH[1]));
    pos.set([v.x, v.y, v.z], i * 3);
    const c = pick();
    const b = D.BRIGHT * (0.25 + 0.75 * Math.pow(Math.random(), 1.8));
    col.set([c.r * b, c.g * b, c.b * b], i * 3);
    size[i] = rand(D.SIZE[0], D.SIZE[1]);
    seedArr[i] = Math.random();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seedArr, 1));
  return geo;
}

const BAND_COUNT = 8; // matches uBands[8] in resonant.vert

/** Stars at log-uniform depths; every 1/TUNED-th star listens to one band. */
function buildResonantField(R) {
  const count = R.COUNT;
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const seedArr = new Float32Array(count);
  const band = new Float32Array(count);
  const sens = new Float32Array(count);
  const v = new THREE.Vector3();
  const tints = [new THREE.Color(0xaec8ff), new THREE.Color(0xffffff), new THREE.Color(0xffe2b8), new THREE.Color(0xffc4a0)];
  const [near, far] = R.DEPTH;
  let tuned = 0;
  for (let i = 0; i < count; i++) {
    const f = Math.random(); // 0 = nearest, 1 = farthest
    v.set(gauss(), gauss(), gauss()).normalize().multiplyScalar(near * Math.pow(far / near, f));
    pos.set([v.x, v.y, v.z], i * 3);
    const c = tints[(Math.random() * tints.length) | 0];
    const b = THREE.MathUtils.lerp(R.BRIGHT[1], R.BRIGHT[0], f) * (0.3 + 0.7 * Math.pow(Math.random(), 1.6));
    col.set([c.r * b, c.g * b, c.b * b], i * 3);
    size[i] = THREE.MathUtils.lerp(R.SIZE[1], R.SIZE[0], f) * rand(0.8, 1.2);
    seedArr[i] = Math.random();
    // bands are dealt in turn so each one has stars near and far
    band[i] = Math.random() < R.TUNED ? tuned++ % BAND_COUNT : -1;
    sens[i] = rand(0.55, 1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seedArr, 1));
  geo.setAttribute('aBand', new THREE.BufferAttribute(band, 1));
  geo.setAttribute('aSens', new THREE.BufferAttribute(sens, 1));
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
    // the galaxy's disk hides the background stars behind it (occlude.glsl), updated in _moveBody
    this.diskUniforms = {
      uDiskNormal: { value: new THREE.Vector3(0, 1, 0) },
      uDiskRadius: { value: GALAXY_RADIUS },
      uOcclude: { value: PROFILE.OCCLUDE.AMOUNT },
    };
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
        vertexShader: occludeGLSL + starsVert,
        fragmentShader: starsFrag,
        uniforms: { uTime: shared.uTime, uTreble: shared.uTreble, uScale: shared.uScale, ...this.diskUniforms },
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

    // fine stardust far behind everything, grained like the galaxy
    this.stardust = new THREE.Points(track(buildStardust(PROFILE.STARDUST)), starMat);
    this.stardust.frustumCulled = false;
    this.stardust.renderOrder = 1;
    scene.add(this.stardust);

    // bright light points floating slowly across now and then (_lights)
    const LP = PROFILE.LIGHTS;
    this.lightClock = 0;
    this.nextLight = LP.FIRST;
    this.lightCount = 0;
    const lightGeo = track(new THREE.PlaneGeometry(1, 1));
    this.lights = Array.from({ length: LP.POOL }, () => {
      const uniforms = { ...this.diskUniforms, uColor: { value: new THREE.Color() }, uBright: { value: 1 }, uFade: { value: 0 } };
      const mesh = new THREE.Mesh(lightGeo, track(new THREE.ShaderMaterial({ vertexShader: lightVert, fragmentShader: occludeGLSL + lightFrag, uniforms, ...additive })));
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.renderOrder = 2; // with the meteors: over the starfields, under the galaxy
      scene.add(mesh);
      return { mesh, uniforms, age: 0, life: 0 };
    });

    // shooting stars: a small pool of streak quads, placed in camera space when launched
    this.meteors = Array.from({ length: 2 }, () => {
      const mesh = new THREE.Mesh(
        track(new THREE.PlaneGeometry(1, 1)),
        track(new THREE.ShaderMaterial({ vertexShader: glowVert, fragmentShader: meteorFrag, uniforms: { uAlpha: { value: 0 } }, ...additive })),
      );
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.renderOrder = 2;
      scene.add(mesh);
      return { mesh, age: 0, life: 0 };
    });
    this.meteorClock = 0;
    this.meteorCharge = 0;
    this.meteorNeed = 1;
    this.lastMeteor = -100;
    this.meteorCount = 0;
    this.loudness = 0;

    // the resonant field: stars at every depth, some tuned to a frequency band
    const RS = PROFILE.RESONANCE;
    this.bands = Array.from({ length: BAND_COUNT }, () => ({ avg: 0, peak: RS.FLOOR, level: 0 }));
    this.resonantUniforms = {
      uTime: shared.uTime,
      uScale: shared.uScale,
      ...this.diskUniforms,
      uBands: { value: new Float32Array(BAND_COUNT) },
      uTints: { value: RS.TINTS.map((c) => new THREE.Color(c)) },
      uGain: { value: RS.GAIN },
      uSizeGain: { value: RS.SIZE_GAIN },
    };
    this.resonant = new THREE.Points(
      track(buildResonantField(RS)),
      track(new THREE.ShaderMaterial({ vertexShader: occludeGLSL + resonantVert, fragmentShader: resonantFrag, uniforms: this.resonantUniforms, ...additive })),
    );
    this.resonant.frustumCulled = false;
    this.resonant.renderOrder = 1;
    scene.add(this.resonant);

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

    // the galaxy itself, in one body that tilts and grows with the music;
    // it has its own (damped) bass/mid/treble, see PROFILE.PULSE
    this.body = new THREE.Group();
    scene.add(this.body);
    this.galaxyUniforms = {
      ...shared,
      uBass: { value: 0 },
      uMid: { value: 0 },
      uTreble: { value: 0 },
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
    this.body.add(this.stars);

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
    this.body.add(this.dust);

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
    this.body.add(this.rings);

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
    this.resonant?.geometry.setDrawRange(0, Math.floor(PROFILE.RESONANCE.COUNT * Math.max(0.5, f)));
    this.stardust?.geometry.setDrawRange(0, Math.floor(PROFILE.STARDUST.COUNT * Math.max(0.4, f)));
  }

  /**
   * Eight log-spaced bands of the live spectrum, each measured against its
   * own slow average and decaying peak, so a band "speaks" when it comes
   * forward in the mix. Without a live signal the synthetic idle
   * bass/mid/treble are spread over the bands instead.
   */
  _updateBands(dt, audio, presence) {
    const R = PROFILE.RESONANCE;
    const follow = (v, to, tau) => v + (to - v) * (1 - Math.exp(-dt / tau));
    const live = audio.analyser && audio.freqData && (audio.mode === 'mic' || audio.isPlaying);
    if (live && !this.bandBins) {
      const hzPerBin = audio.ctx.sampleRate / audio.analyser.fftSize;
      const n = audio.freqData.length;
      const [lo, hi] = R.HZ;
      const edge = (i) => Math.min(n - 1, Math.max(1, Math.round((lo * Math.pow(hi / lo, i / BAND_COUNT)) / hzPerBin)));
      this.bandBins = Array.from({ length: BAND_COUNT }, (_, i) => [edge(i), Math.max(edge(i) + 1, edge(i + 1))]);
    }
    const out = this.resonantUniforms.uBands.value;
    const response = presence + (1 - presence) * R.IDLE;
    for (let i = 0; i < BAND_COUNT; i++) {
      let raw;
      if (live) {
        const [a, b] = this.bandBins[i];
        // mean and max blended: the mean alone dilutes a clear tone in the wide high bands
        let s = 0;
        let m = 0;
        for (let k = a; k < b; k++) {
          s += audio.freqData[k];
          m = Math.max(m, audio.freqData[k]);
        }
        raw = (R.PEAK_MIX * m + (1 - R.PEAK_MIX) * (s / (b - a))) / 255;
      } else {
        const p = i / (BAND_COUNT - 1);
        const base = p < 0.5 ? audio.bass + (audio.mid - audio.bass) * p * 2 : audio.mid + (audio.treble - audio.mid) * (p - 0.5) * 2;
        raw = base * (0.8 + 0.2 * Math.sin(this.time * (0.5 + i * 0.37) + i * 1.9));
      }
      const st = this.bands[i];
      st.raw = raw;
      st.avg = follow(st.avg, raw, R.AVERAGE);
      st.peak = Math.max(raw, st.peak * Math.exp(-dt / R.PEAK_DECAY), R.FLOOR);
      const base = st.avg * 0.9;
      const x = raw < R.FLOOR ? 0 : Math.min(1, Math.max(0, (raw - base) / Math.max(st.peak - base, 0.04)));
      const target = Math.pow(x, R.CURVE) * response;
      st.level = follow(st.level, target, target > st.level ? R.ATTACK : R.RELEASE);
      out[i] = st.level;
    }
    this.resonantUniforms.uGain.value = R.GAIN;
    this.resonantUniforms.uSizeGain.value = R.SIZE_GAIN;
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
    // beat-level pulsing (arm breathing, ripples, the sky's bass glow) is kept low
    const pulse = lerp(1, P.PULSE, presence);
    s.uBass.value = audio.bass * pulse;
    s.uMid.value = audio.mid * pulse;
    s.uTreble.value = audio.treble * lerp(1, P.SPARKLE, presence);
    const gu = this.galaxyUniforms;
    gu.uBass.value = s.uBass.value;
    gu.uMid.value = s.uMid.value;
    gu.uTreble.value = s.uTreble.value;

    this._updateBands(dt, audio, presence);

    // negative rotation keeps the logarithmic arms trailing
    // a steady slow spin in real time; the music only nudges it, gradually
    const spinTarget = P.SPIN.BASE + P.SPIN.MUSIC * build;
    this.spin = this.spin === undefined ? spinTarget : follow(this.spin, spinTarget, P.SPIN.SMOOTHING);
    this.rotation -= dt * this.spin;
    this.galaxyUniforms.uRotation.value = this.rotation;

    // beats (the repeating pattern) launch shockwave rings from the core, none in the stillness
    const R = P.RINGS;
    if (perf.beatId !== this.lastBeat) {
      this.lastBeat = perf.beatId;
      const amp = lerp(0.7 + 0.5 * audio.energy, st.rings * lerp(R.STRENGTH[0], R.STRENGTH[1], build) * Math.min(1, Math.max(0, (perf.drive - R.MIN_DRIVE) / (1 - R.MIN_DRIVE)) * 2) * P.PULSE, presence);
      if (amp > 0.02) {
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
    const core = (lerp(C.QUIET, C.FULL, build) * st.core + C.CLIMAX * this.climax + C.BASS * P.PULSE * audio.bass * presence) * (1 + 0.25 * P.PULSE * audio.beat * presence);
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
    // orbit and sway are accumulated / scaled so a slider change never jumps the view
    this.orbit = (this.orbit ?? 0) + sdt * Cam.ORBIT;
    const az = this.orbit + 0.6;
    const el = 0.4 + 0.13 * Cam.SWAY * Math.sin(t * 0.043) + Cam.RISE * this.pull;
    const dist = (17 + 2.2 * Cam.SWAY * Math.sin(t * 0.031)) * (this.distScale ?? 1) * (1 + Cam.PULL * this.pull);
    const cam = this.camera;
    cam.position.set(Math.sin(az) * Math.cos(el) * dist, Math.sin(el) * dist, Math.cos(az) * Math.cos(el) * dist);

    // mouse parallax, smoothed
    const k = 1 - Math.exp(-dt * 2.5);
    this.parallax.x += (pointer.nx - this.parallax.x) * k;
    this.parallax.y += (pointer.ny - this.parallax.y) * k;
    cam.lookAt(0, 0, 0);
    cam.translateX(this.parallax.x * 1.6 * Cam.PARALLAX);
    cam.translateY(this.parallax.y * 1.0 * Cam.PARALLAX);
    cam.lookAt(0, 0.4 * Cam.SWAY * Math.sin(t * 0.07), 0);

    this._moveBody(dt, audio, perf, presence, az);
    cam.updateMatrixWorld();
    this._meteors(dt, perf, presence);
    this._lights(dt);

    for (const o of this.scene.children) if (o.userData.billboard) o.quaternion.copy(cam.quaternion);
    this.core.quaternion.copy(cam.quaternion);
  }

  /**
   * Bright points of light: at most POOL at once, a new one only GAP s after
   * the last came in (wall clock); one strong at a time, the others FAINT.
   * Each enters just off screen on a random edge and drifts to another edge
   * (opposite more often) at the speed of crossing the width in CROSS s,
   * floating on the way: two slow sine wanders along and two across its path
   * (WANDER), so it eases, hurries and sways instead of following a line. It blinks: fade in, shine
   * BLINK.ON s, fade out, dark BLINK.OFF s, and again, breathing a little
   * while it shines. Camera space far behind the galaxy, so the disk hides
   * it where they overlap.
   */
  _lights(dt) {
    const L = PROFILE.LIGHTS;
    const lerp = (a, b, x) => a + (b - a) * x;
    const h = Math.min(dt, 0.1);
    this.lightClock += h;
    const cam = this.camera;
    const A = cam.aspect;
    const r = L.SIZE * 2; // halo radius in half-screen-height units (screen: x ±aspect, y ±1)
    const active = this.lights.filter((x) => x.age < x.life);
    // a new one only GAP s after the last came in, and only while fewer than POOL are out
    if (this.lightClock >= this.nextLight && active.length < L.POOL) {
      const l = this.lights.find((x) => x.age >= x.life);
      if (l) {
        this.nextLight = this.lightClock + L.GAP;
        // one strong light at a time, the others faint
        l.strong = !active.some((x) => x.strong);
        // from a random edge to another one (opposite more often), just off screen
        const m = r + 0.06;
        const onEdge = (e) =>
          e === 0 ? [-A - m, rand(-0.75, 0.75)] : e === 1 ? [A + m, rand(-0.75, 0.75)] : e === 2 ? [rand(-0.85, 0.85) * A, 1 + m] : [rand(-0.85, 0.85) * A, -1 - m];
        const pickEdge = () => {
          const u = Math.random() * 3.4; // left / right weigh 1, top / bottom 0.7
          return u < 1 ? 0 : u < 2 ? 1 : u < 2.7 ? 2 : 3;
        };
        const opposite = [1, 0, 3, 2];
        let s;
        let e;
        for (let tries = 0; tries < 12; tries++) {
          const se = pickEdge();
          let ee = Math.random() < 0.6 ? opposite[se] : pickEdge();
          if (ee === se) ee = opposite[se];
          s = onEdge(se);
          e = onEdge(ee);
          if (Math.hypot(e[0] - s[0], e[1] - s[1]) > 1.8) break; // no short corner-cuts
        }
        l.s = s;
        l.e = e;
        const len = Math.hypot(e[0] - s[0], e[1] - s[1]);
        l.t = [(e[0] - s[0]) / len, (e[1] - s[1]) / len]; // along the path
        l.n = [-l.t[1], l.t[0]]; // across it
        // the same drift speed as crossing the width in CROSS s
        l.life = (len / ((2 * A) / L.CROSS)) * rand(0.8, 1.2);
        // two slow waves per axis, own periods and phases: [angular speed, phase, share]
        const wave = (share) => [(2 * Math.PI) / rand(L.WANDER.PERIOD[0], L.WANDER.PERIOD[1]), rand(0, 2 * Math.PI), share];
        l.wx = [wave(0.65), wave(0.35)];
        l.wy = [wave(0.6), wave(0.4)];
        l.age = 0;
        l.seed = rand(0, 100);
        l.uniforms.uColor.value.set(L.TINTS[(Math.random() * L.TINTS.length) | 0]);
        this.lightCount++;
      }
    }
    const DEPTH = 800;
    const unit = DEPTH * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)); // half screen height in world units
    for (const l of this.lights) {
      if (l.age >= l.life) {
        l.mesh.visible = false;
        continue;
      }
      l.age += h;
      const p = Math.min(1, l.age / l.life);
      // drift along the path; it floats along it (eases / hurries, never turns back) and across it.
      // Waves are offset to 0 at the start so it still enters from off screen.
      const sway = (waves) => waves.reduce((s, [w, ph, share]) => s + share * (Math.sin(w * l.age + ph) - Math.sin(ph)), 0);
      const along = L.WANDER.X * sway(l.wx) * Math.sin(Math.PI * p);
      const across = L.WANDER.Y * sway(l.wy);
      const x = lerp(l.s[0], l.e[0], p) + l.t[0] * along + l.n[0] * across;
      const y = lerp(l.s[1], l.e[1], p) + l.t[1] * along + l.n[1] * across;
      const side = 2 * r * unit * (l.strong ? 1 : L.FAINT.SIZE);
      l.mesh.matrix.makeScale(side, side, 1).setPosition(x * unit, y * unit, -DEPTH);
      l.mesh.matrix.premultiply(cam.matrixWorld);
      l.mesh.matrixWorldNeedsUpdate = true; // matrixAutoUpdate is off
      l.mesh.visible = true;
      const breathe = 0.85 + 0.15 * Math.sin(this.lightClock * 0.9 + l.seed);
      // blink: fade in, on, fade out, off (smoothstep fades)
      const B = L.BLINK;
      const cycle = B.ON + B.OFF + 2 * B.FADE;
      const c = l.age % cycle;
      const ss = (v) => v * v * (3 - 2 * v);
      const blink = c < B.FADE ? ss(c / B.FADE) : c < B.FADE + B.ON ? 1 : c < 2 * B.FADE + B.ON ? 1 - ss((c - B.FADE - B.ON) / B.FADE) : 0;
      l.blink = blink;
      l.uniforms.uBright.value = L.BRIGHT * breathe * (l.strong ? 1 : L.FAINT.BRIGHT);
      l.uniforms.uFade.value = blink * Math.min(1, p / 0.03, (1 - p) / 0.03); // edge fade only while still off screen
    }
  }

  /**
   * Shooting stars when the music plays strongly. `loudness` (how far the
   * build / climax is above THRESHOLD, 0..1) charges a counter at a rate of
   * 1 / gap, the gap shrinking from GAP[0] to GAP[1] as it gets louder; a
   * full charge (randomised a little) launches one. In a loud passage a
   * strong accent may launch one right on the note. Louder = brighter and
   * longer. Start point, direction and length are chosen in screen terms and
   * placed on a plane in front of the camera, so they look the same at any
   * aspect ratio; the head eases out along the path while the tail
   * stretches and then thins away.
   */
  _meteors(dt, perf, presence) {
    const M = PROFILE.METEORS;
    const h = Math.min(dt, 0.1);
    this.meteorClock += h;
    const strong = Math.max(this.build, this.climax) * presence;
    const x = Math.min(1, Math.max(0, (strong - M.THRESHOLD) / Math.max(1 - M.THRESHOLD, 0.01)));
    this.loudness = x;
    if (x > 0) this.meteorCharge += h / (M.GAP[0] + (M.GAP[1] - M.GAP[0]) * x);
    const since = this.meteorClock - this.lastMeteor;
    const accent = x >= M.ACCENT && perf.onsets?.some((o) => o.accent || o.strength >= 0.7);
    if (since >= M.MIN_GAP && (this.meteorCharge >= this.meteorNeed || accent)) {
      const m = this.meteors.find((y) => y.age >= y.life);
      if (m) {
        this.meteorCharge = 0;
        this.meteorNeed = rand(0.6, 1.4); // irregular, never a metronome
        this.lastMeteor = this.meteorClock;
        m.power = 0.7 + 0.5 * x;
        // mostly falling: 200-340° in screen terms (down-left .. down-right), random side
        const ang = THREE.MathUtils.degToRad(rand(205, 335));
        m.dir = [Math.cos(ang), Math.sin(ang)];
        m.start = [rand(-0.85, 0.85) * this.camera.aspect, rand(-0.2, 0.9)]; // in screen-height units, centre = 0
        m.length = rand(M.LENGTH[0], M.LENGTH[1]) * (0.8 + 0.3 * x);
        m.travel = rand(M.TRAVEL[0], M.TRAVEL[1]);
        m.life = rand(M.DURATION[0], M.DURATION[1]);
        m.age = 0;
        m.mesh.visible = true;
        this.meteorCount++;
      }
    }
    const DEPTH = 300;
    const unit = DEPTH * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)); // half screen height in world units
    const pxWorld = (2 * unit) / Math.max(this.height, 1);
    const Z = this._zAxis ?? (this._zAxis = new THREE.Vector3(0, 0, 1));
    const at = this._mPos ?? (this._mPos = new THREE.Vector3());
    const size = this._mSize ?? (this._mSize = new THREE.Vector3());
    const q = this._mq ?? (this._mq = new THREE.Quaternion());
    for (const m of this.meteors) {
      if (m.age >= m.life) continue;
      m.age += h;
      const p = Math.min(1, m.age / m.life);
      if (p >= 1) {
        m.mesh.visible = false;
        continue;
      }
      const go = 1 - Math.pow(1 - p, 2); // ease out: fast start, gliding finish
      const tail = m.length * Math.min(1, p * 3) * (1 - 0.5 * p);
      const alpha = Math.min(1, p / 0.12) * (1 - THREE.MathUtils.smoothstep(p, 0.55, 1)) * M.BRIGHT * m.power;
      const hx = m.start[0] + m.dir[0] * m.travel * go;
      const hy = m.start[1] + m.dir[1] * m.travel * go;
      // quad centre half a tail behind the head, in camera space
      const cx = (hx - (m.dir[0] * tail) / 2) * unit;
      const cy = (hy - (m.dir[1] * tail) / 2) * unit;
      q.setFromAxisAngle(Z, Math.atan2(m.dir[1], m.dir[0]));
      m.mesh.matrix.compose(at.set(cx, cy, -DEPTH), q, size.set(Math.max(tail * unit, 0.01), M.WIDTH * pxWorld, 1));
      m.mesh.matrix.premultiply(this.camera.matrixWorld);
      m.mesh.matrixWorldNeedsUpdate = true; // matrixAutoUpdate is off, so three won't flag it itself
      m.mesh.material.uniforms.uAlpha.value = alpha;
    }
  }

  /**
   * The galaxy's slow body language: it tips toward the viewer and grows as
   * the music builds, leans with the bass/treble balance, lifts with the
   * melody and drifts a little on its own. Every target is reached through a
   * critically damped spring, so moves ease in and out and never overshoot,
   * even after a seek. Tilts are taken about the viewer's axes (az = camera
   * azimuth), so "toward the viewer" means the same from any viewpoint.
   */
  _moveBody(dt, audio, perf, presence, az) {
    const M = PROFILE.MOTION;
    const h = Math.min(dt, 0.1);
    if (!this.springs) {
      const at = (x) => ({ x, v: 0 });
      this.springs = { pitch: at(0), roll: at(0), size: at(1) };
      this.balance = 0;
      this.drift = 0;
    }
    const spring = (s, target, period) => {
      const w = (2 * Math.PI) / period;
      s.v += (w * w * (target - s.x) - 2 * w * s.v) * h;
      s.x += s.v * h;
    };
    const lerp = (a, b, x) => a + (b - a) * x;

    // wall-clock drift: keeps a little life even when the scene clock is nearly still
    this.drift += h;
    const d = this.drift;
    const wander = M.WANDER * (Math.sin(d * 0.071) + 0.6 * Math.sin(d * 0.043 + 2.1));
    const wander2 = M.WANDER * (Math.sin(d * 0.057 + 1.3) + 0.6 * Math.sin(d * 0.031 + 0.4));

    const open = Math.max(this.build, this.climax);
    const melody = (perf.heightConf ?? 0) > 0.3 ? (perf.height - 0.5) * 2 : 0;
    // brightness of the sound: the spectral centroid over the 8 bands (0 = all bass, 1 = all treble),
    // compared with its own long average, so the lean says "brighter / darker than usual"
    let sum = 0;
    let weighted = 0;
    this.bands.forEach((b, i) => {
      sum += b.raw ?? 0;
      weighted += (b.raw ?? 0) * (i / (BAND_COUNT - 1));
    });
    const centroid = sum > 0.02 ? weighted / sum : (this.centroidAvg ?? 0.5);
    this.centroidAvg = (this.centroidAvg ?? centroid) + (centroid - (this.centroidAvg ?? centroid)) * (1 - Math.exp(-h / M.BALANCE_AVERAGE));
    const bright = (centroid - this.centroidAvg) * M.BALANCE_GAIN * presence;
    this.balance += (bright - this.balance) * (1 - Math.exp(-h / M.BALANCE_SMOOTHING));

    const pitch = presence * (lerp(M.PITCH[0], M.PITCH[1], this.build) + M.PITCH_CLIMAX * this.climax + M.MELODY * melody) + wander;
    const roll = M.ROLL * Math.tanh(this.balance) + wander2;
    const size = lerp(1, lerp(M.SIZE[0], M.SIZE[1], open) + M.SIZE_CLIMAX * this.climax, presence);
    spring(this.springs.pitch, pitch, M.PERIOD);
    spring(this.springs.roll, roll, M.PERIOD);
    spring(this.springs.size, size, M.SIZE_PERIOD);

    // viewer axes: right (pitch tips the disk's face toward us), forward (roll leans it sideways)
    const right = this._right ?? (this._right = new THREE.Vector3());
    const fwd = this._fwd ?? (this._fwd = new THREE.Vector3());
    right.set(Math.cos(az), 0, -Math.sin(az));
    fwd.set(-Math.sin(az), 0, -Math.cos(az));
    const q = this.body.quaternion.setFromAxisAngle(right, this.springs.pitch.x);
    q.premultiply((this._qRoll ?? (this._qRoll = new THREE.Quaternion())).setFromAxisAngle(fwd, this.springs.roll.x));
    this.body.scale.setScalar(this.springs.size.x);
    this.core.scale.setScalar(this.springs.size.x);
    const du = this.diskUniforms;
    du.uDiskNormal.value.set(0, 1, 0).applyQuaternion(this.body.quaternion);
    du.uDiskRadius.value = GALAXY_RADIUS * PROFILE.OCCLUDE.RADIUS * this.springs.size.x;
    du.uOcclude.value = PROFILE.OCCLUDE.AMOUNT;
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
      'light points': `${this.lights.filter((l) => l.age < l.life).map((l) => `${l.strong ? 'strong' : 'faint'} ${l.blink > 0.5 ? 'on' : 'dark'}`).join(', ') || 'none'} · ${this.lightCount} so far · next in ${Math.max(0, this.nextLight - this.lightClock).toFixed(0)} s`,
      spin: `${((this.spin ?? 0) * 57.3).toFixed(2)}°/s · meteors ${this.meteorCount} · loud ${this.loudness.toFixed(2)} · charge ${((this.meteorCharge / this.meteorNeed) * 100).toFixed(0)} %`,
      body: this.springs ? `tilt ${((this.springs.pitch.x * 180) / Math.PI).toFixed(1)}° · lean ${((this.springs.roll.x * 180) / Math.PI).toFixed(1)}° · size ${this.springs.size.x.toFixed(2)}` : '-',
      'resonant bands': Array.from(this.resonantUniforms.uBands.value, (v) => v.toFixed(2)).join(' '),
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
