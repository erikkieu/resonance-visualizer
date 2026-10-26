import * as THREE from 'three';
import { SceneBase } from './SceneBase.js';
import { FullscreenPass, passMaterial } from '../gl/FullscreenPass.js';
import { createTarget } from '../gl/targets.js';
import { Bloom } from '../gl/Bloom.js';

import noiseGLSL from '../shaders/common/noise.glsl?raw';
import commonGLSL from '../shaders/aurora/common.glsl?raw';
import auroraFrag from '../shaders/aurora/aurora.frag?raw';
import landscapeFrag from '../shaders/aurora/landscape.frag?raw';
import terrainFrag from '../shaders/aurora/terrain.frag?raw';
import ambientFrag from '../shaders/aurora/ambient.frag?raw';
import curtainsFrag from '../shaders/aurora/curtains.frag?raw';

/**
 * Scene 3: Aurora borealis over a fjord.
 *
 *   terrain.frag    static mountains + Milky Way, baked once per resize
 *   curtains.frag   per-frame lookup table of curtain shapes (4096 x 3)
 *   aurora.frag     low-res sliced volume of curtain sheets (HDR)
 *   ambient.frag    1x1 average of the aurora, used as scene lighting
 *   landscape.frag  sky, stars, snowy mountains, rippled reflection, rocks
 *   Bloom           soft glow on the curtains and their reflection
 *
 * Audio: energy -> wave speed (scene clock) and brightness, bass -> curtains
 * swell upward, mid -> fold frequency, treble -> fine rays and star twinkle,
 * beat -> brief green-to-pink colour surge.
 */

// aurora pass resolution (fraction of the scene target) and slice count
const AURORA = [
  { scale: 0.4, steps: 34 },
  { scale: 0.36, steps: 30 },
  { scale: 0.32, steps: 26 },
  { scale: 0.28, steps: 22 },
];

export default class Scene3Aurora extends SceneBase {
  constructor() {
    super({ baseSpeed: 0.35, speedGain: 1.5 });
    this.renderScale = 0.8;
    this.toneMapped = true;
    this.exposure = 1.15;
    this.surge = 0;
    this.lastBeat = -1;
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
    this.tick(dt, audio);
    if (audio.beatId !== this.lastBeat) {
      this.lastBeat = audio.beatId;
      this.surge = Math.min(1, this.surge + 0.55 + 0.4 * audio.energy);
    }
    this.surge *= Math.exp(-dt * 2.2);

    const s = this.shared;
    s.uTime.value = this.time;
    s.uBass.value = audio.bass;
    s.uMid.value = audio.mid;
    s.uTreble.value = audio.treble;
    s.uEnergy.value = audio.energy;
    s.uSurge.value = this.surge;
  }

  render(target) {
    this.pass.render(this.renderer, this.curtainMat, this.curtainTarget);
    this.pass.render(this.renderer, this.auroraMat, this.auroraTarget);
    this.pass.render(this.renderer, this.ambientMat, this.ambientTarget);
    this.pass.render(this.renderer, this.landMat, this.sceneTarget);
    this.bloom.render(this.renderer, this.sceneTarget.texture, target);
  }

  dispose() {
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
