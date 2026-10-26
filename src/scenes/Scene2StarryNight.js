import * as THREE from 'three';
import { SceneBase } from './SceneBase.js';
import { FullscreenPass, passMaterial } from '../gl/FullscreenPass.js';
import { createTarget } from '../gl/targets.js';

import noiseGLSL from '../shaders/common/noise.glsl?raw';
import layoutGLSL from '../shaders/starry/layout.glsl?raw';
import fieldFrag from '../shaders/starry/field.frag?raw';
import strokesFrag from '../shaders/starry/strokes.frag?raw';

/**
 * Scene 2: a living painting inspired by Van Gogh's "The Starry Night".
 *
 * Pass 1 (field.frag, ~1/3 resolution) paints the underpainting: colour plus
 * a brush direction derived from a stream function of swirling vortices.
 * Pass 2 (strokes.frag) lays thick, oriented brush strokes over it with
 * impasto lighting, then adds crisp star cores and glowing windows.
 *
 * Audio: energy -> swirl and flow speed (scene clock), bass -> star halos
 * and moon glow, mid -> stroke turbulence, treble -> star twinkle,
 * volume -> cypress sway.
 */

const FIELD_DIVISOR = [3, 3, 3.5, 4];

export default class Scene2StarryNight extends SceneBase {
  constructor() {
    super({ baseSpeed: 0.45, speedGain: 1.4 });
    this.renderScale = 0.8;
    this.toneMapped = false;
  }

  async init(renderer) {
    await super.init(renderer);
    this.pass = new FullscreenPass();

    // uniforms shared by both passes (layout.glsl)
    this.shared = {
      uAspect: { value: 16 / 9 },
      uLayout: { value: 16 / 9 },
      uOffsetX: { value: 0 },
      uTime: { value: 0 },
      uBass: { value: 0 },
      uMid: { value: 0 },
      uTreble: { value: 0 },
      uEnergy: { value: 0 },
      uBeat: { value: 0 },
      uSway: { value: 0.02 },
    };

    const prefix = noiseGLSL + layoutGLSL;
    this.fieldMat = passMaterial({ fragmentShader: prefix + fieldFrag, uniforms: { ...this.shared } });
    this.strokeMat = passMaterial({
      fragmentShader: prefix + strokesFrag,
      uniforms: {
        ...this.shared,
        tField: { value: null },
        uFieldSize: { value: new THREE.Vector2(1, 1) },
        uResolution: { value: new THREE.Vector2(1, 1) },
      },
    });
    await this.pass.compile(renderer, [this.fieldMat, this.strokeMat]);
  }

  resize(width, height) {
    super.resize(width, height);
    const aspect = width / height;
    const layout = Math.max(aspect, 1.25);
    this.shared.uAspect.value = aspect;
    this.shared.uLayout.value = layout;
    this.shared.uOffsetX.value = (layout - aspect) * 0.5;
    const div = FIELD_DIVISOR[this.quality] ?? 3;
    const fw = Math.max(64, Math.round(width / div));
    const fh = Math.max(36, Math.round(height / div));
    if (!this.field) this.field = createTarget(fw, fh);
    else this.field.setSize(fw, fh);
    this.strokeMat.uniforms.tField.value = this.field.texture;
    this.strokeMat.uniforms.uFieldSize.value.set(fw, fh);
    this.strokeMat.uniforms.uResolution.value.set(width, height);
  }

  setQuality(level) {
    super.setQuality(level);
    if (this.width > 1) this.resize(this.width, this.height);
  }

  update(dt, audio) {
    this.tick(dt, audio);
    const s = this.shared;
    s.uTime.value = this.time;
    s.uBass.value = audio.bass;
    s.uMid.value = audio.mid;
    s.uTreble.value = audio.treble;
    s.uEnergy.value = audio.energy;
    s.uBeat.value = audio.beat;
    // the cypress leans further into the wind as the volume rises
    const sway = 0.012 + 0.05 * audio.energy;
    s.uSway.value += (sway - s.uSway.value) * (1 - Math.exp(-dt * 2));
  }

  render(target) {
    this.pass.render(this.renderer, this.fieldMat, this.field);
    this.pass.render(this.renderer, this.strokeMat, target);
  }

  dispose() {
    this.field?.dispose();
    this.fieldMat?.dispose();
    this.strokeMat?.dispose();
  }
}
