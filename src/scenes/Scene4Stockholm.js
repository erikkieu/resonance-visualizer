import * as THREE from 'three';
import plates from 'virtual:texture-plates';
import { SceneBase } from './SceneBase.js';
import { FullscreenPass, passMaterial } from '../gl/FullscreenPass.js';

import noiseGLSL from '../shaders/common/noise.glsl?raw';
import streetFrag from '../shaders/stockholm/street.frag?raw';

/**
 * Scene 4: old Stockholm street footage, recreated procedurally.
 *
 * Everything is drawn by street.frag (ray-cast planes + silhouettes + film
 * treatment). The film runs at ~18 fps: the object clock and all film
 * artefacts only advance when a new film frame starts, and the scene skips
 * rendering entirely between frames, so it is very cheap.
 *
 * If an image exists in /public/textures/ (e.g. stockholm.jpg) it is used as
 * the background plate and the trams, cars and people are layered over it.
 *
 * Audio: energy -> speed of trams, cars and pedestrians (scene clock),
 * bass -> light flicker and camera shake, treble -> grain, dust and
 * scratches, beat -> exposure flash.
 */

const FILM_FPS = 18;

export default class Scene4Stockholm extends SceneBase {
  constructor() {
    super({ baseSpeed: 0.55, speedGain: 1.6 });
    this.renderScale = 0.75; // vintage film is soft anyway
    this.toneMapped = false;
    this.realTime = 0;
    this.frameIndex = -1;
    this.dirty = true;
    this.flash = 0;
    this.lastBeat = -1;
    this.lastTarget = null;
  }

  async init(renderer) {
    await super.init(renderer);
    this.pass = new FullscreenPass();
    this.mat = passMaterial({
      fragmentShader: noiseGLSL + streetFrag,
      uniforms: {
        uAspect: { value: 16 / 9 },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uTime: { value: 0 },
        uFrame: { value: 0 },
        uBass: { value: 0 },
        uTreble: { value: 0 },
        uFlash: { value: 0 },
        uShake: { value: 0 },
        uClock: { value: new THREE.Vector2() },
        tPlate: { value: null },
        uUsePlate: { value: 0 },
        uPlateAspect: { value: 1.5 },
      },
    });
    await this.pass.compile(renderer, [this.mat]);
    this._loadPlate();
  }

  /** Optional photo plate from /public/textures (discovered at build time). */
  _loadPlate() {
    const file = plates.find((f) => /stockholm/i.test(f)) ?? plates[0];
    if (!file) return;
    const url = `${import.meta.env.BASE_URL}textures/${file}`;
    new THREE.TextureLoader().load(
      url,
      (tex) => {
        if (!this.mat) return tex.dispose();
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.minFilter = THREE.LinearFilter;
        tex.generateMipmaps = false;
        this.plate = tex;
        const u = this.mat.uniforms;
        u.tPlate.value = tex;
        u.uUsePlate.value = 1;
        u.uPlateAspect.value = tex.image.width / tex.image.height;
        this.dirty = true;
      },
      undefined,
      () => {
        /* plate is optional: fall back to the procedural street */
      },
    );
  }

  resize(width, height) {
    super.resize(width, height);
    this.mat.uniforms.uAspect.value = width / height;
    this.mat.uniforms.uResolution.value.set(width, height);
    this.dirty = true;
  }

  update(dt, audio) {
    this.tick(dt, audio);
    this.realTime += dt;

    if (audio.beatId !== this.lastBeat) {
      this.lastBeat = audio.beatId;
      this.flash = Math.min(1, this.flash + 0.7);
    }
    this.flash *= Math.exp(-dt * 7);

    // Advance the film only on frame boundaries: stepped, silent-era motion.
    const frame = Math.floor(this.realTime * FILM_FPS);
    if (frame !== this.frameIndex) {
      this.frameIndex = frame;
      const u = this.mat.uniforms;
      u.uTime.value = this.time;
      u.uFrame.value = frame % 100000;
      u.uBass.value = audio.bass;
      u.uTreble.value = audio.treble;
      u.uFlash.value = this.flash;
      u.uShake.value = Math.max(0, audio.bass - 0.35) * 1.6 + audio.beat * 0.3;
      const now = new Date();
      const minutes = now.getMinutes() + now.getSeconds() / 60;
      const hours = (now.getHours() % 12) + minutes / 60;
      u.uClock.value.set((hours / 12) * Math.PI * 2, (minutes / 60) * Math.PI * 2);
      this.dirty = true;
    }
  }

  render(target) {
    if (!this.dirty && target === this.lastTarget && target) return;
    this.pass.render(this.renderer, this.mat, target);
    this.lastTarget = target;
    this.dirty = false;
  }

  dispose() {
    this.mat?.dispose();
    this.mat = null;
    this.plate?.dispose();
  }
}
