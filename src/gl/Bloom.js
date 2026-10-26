import * as THREE from 'three';
import { FullscreenPass, passMaterial } from './FullscreenPass.js';
import { createTarget } from './targets.js';

/**
 * Small HDR bloom (dual-Kawase style):
 *   1. prefilter: soft-knee threshold + 2x downsample
 *   2. N downsample passes (5-tap)
 *   3. N upsample passes (8-tap tent), each adding the matching down level
 *   4. composite: source + bloom * strength into the output target
 * Total cost is a handful of tiny passes; owned by the scenes that want glow.
 */

const prefilterFrag = /* glsl */ `
  uniform sampler2D tSrc;
  uniform vec2 uTexel;      // source texel size
  uniform float uThreshold;
  uniform float uKnee;
  varying vec2 vUv;
  vec3 fetch(vec2 o) { return texture2D(tSrc, vUv + o * uTexel).rgb; }
  void main() {
    // 4 bilinear taps = 16 texel box, avoids fireflies better than one tap
    vec3 c = (fetch(vec2(-1.0, -1.0)) + fetch(vec2(1.0, -1.0)) + fetch(vec2(-1.0, 1.0)) + fetch(vec2(1.0, 1.0))) * 0.25;
    float br = max(c.r, max(c.g, c.b));
    // soft knee curve (as in Unity/Unreal bloom)
    float soft = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
    soft = soft * soft / (4.0 * uKnee + 1e-4);
    float contrib = max(soft, br - uThreshold) / max(br, 1e-4);
    gl_FragColor = vec4(c * contrib, 1.0);
  }
`;

const downFrag = /* glsl */ `
  uniform sampler2D tSrc;
  uniform vec2 uTexel;
  varying vec2 vUv;
  void main() {
    vec3 s = texture2D(tSrc, vUv).rgb * 4.0;
    s += texture2D(tSrc, vUv + vec2(-1.0, -1.0) * uTexel).rgb;
    s += texture2D(tSrc, vUv + vec2( 1.0, -1.0) * uTexel).rgb;
    s += texture2D(tSrc, vUv + vec2(-1.0,  1.0) * uTexel).rgb;
    s += texture2D(tSrc, vUv + vec2( 1.0,  1.0) * uTexel).rgb;
    gl_FragColor = vec4(s / 8.0, 1.0);
  }
`;

const upFrag = /* glsl */ `
  uniform sampler2D tSrc;   // smaller (blurrier) level
  uniform sampler2D tAdd;   // matching down level
  uniform vec2 uTexel;      // texel of tSrc
  uniform float uRadius;
  varying vec2 vUv;
  void main() {
    vec2 o = uTexel * uRadius;
    vec3 s = texture2D(tSrc, vUv + vec2(-2.0, 0.0) * o).rgb;
    s += texture2D(tSrc, vUv + vec2(-1.0, 1.0) * o).rgb * 2.0;
    s += texture2D(tSrc, vUv + vec2(0.0, 2.0) * o).rgb;
    s += texture2D(tSrc, vUv + vec2(1.0, 1.0) * o).rgb * 2.0;
    s += texture2D(tSrc, vUv + vec2(2.0, 0.0) * o).rgb;
    s += texture2D(tSrc, vUv + vec2(1.0, -1.0) * o).rgb * 2.0;
    s += texture2D(tSrc, vUv + vec2(0.0, -2.0) * o).rgb;
    s += texture2D(tSrc, vUv + vec2(-1.0, -1.0) * o).rgb * 2.0;
    gl_FragColor = vec4(s / 12.0 + texture2D(tAdd, vUv).rgb, 1.0);
  }
`;

const compositeFrag = /* glsl */ `
  uniform sampler2D tSrc;
  uniform sampler2D tBloom;
  uniform float uStrength;
  uniform vec3 uTint;
  varying vec2 vUv;
  void main() {
    vec3 c = texture2D(tSrc, vUv).rgb + texture2D(tBloom, vUv).rgb * uStrength * uTint;
    gl_FragColor = vec4(c, 1.0);
  }
`;

export class Bloom {
  constructor({ levels = 5, threshold = 0.8, knee = 0.4, strength = 0.6, radius = 1.0 } = {}) {
    this.levels = levels;
    this.strength = strength;
    this.pass = new FullscreenPass();
    this.down = [];
    this.up = [];
    this.prefilter = passMaterial({
      fragmentShader: prefilterFrag,
      uniforms: {
        tSrc: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uThreshold: { value: threshold },
        uKnee: { value: knee },
      },
    });
    this.downMat = passMaterial({
      fragmentShader: downFrag,
      uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } },
    });
    this.upMat = passMaterial({
      fragmentShader: upFrag,
      uniforms: {
        tSrc: { value: null },
        tAdd: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uRadius: { value: radius },
      },
    });
    this.compositeMat = passMaterial({
      fragmentShader: compositeFrag,
      uniforms: {
        tSrc: { value: null },
        tBloom: { value: null },
        uStrength: { value: strength },
        uTint: { value: new THREE.Vector3(1, 1, 1) },
      },
    });
  }

  get threshold() {
    return this.prefilter.uniforms.uThreshold.value;
  }

  set threshold(v) {
    this.prefilter.uniforms.uThreshold.value = v;
  }

  setSize(width, height) {
    this._disposeTargets();
    let w = Math.max(1, Math.round(width / 2));
    let h = Math.max(1, Math.round(height / 2));
    for (let i = 0; i < this.levels; i++) {
      this.down.push(createTarget(w, h));
      if (i < this.levels - 1) this.up.push(createTarget(w, h));
      w = Math.max(1, Math.round(w / 2));
      h = Math.max(1, Math.round(h / 2));
    }
    this.srcWidth = width;
    this.srcHeight = height;
  }

  /** Reads `srcTexture` (HDR) and writes source + bloom into `output`. */
  render(renderer, srcTexture, output) {
    const n = this.levels;
    const p = this.prefilter.uniforms;
    p.tSrc.value = srcTexture;
    p.uTexel.value.set(1 / this.srcWidth, 1 / this.srcHeight);
    this.pass.render(renderer, this.prefilter, this.down[0]);

    const d = this.downMat.uniforms;
    for (let i = 1; i < n; i++) {
      d.tSrc.value = this.down[i - 1].texture;
      d.uTexel.value.set(1 / this.down[i - 1].width, 1 / this.down[i - 1].height);
      this.pass.render(renderer, this.downMat, this.down[i]);
    }

    const u = this.upMat.uniforms;
    let src = this.down[n - 1];
    for (let i = n - 2; i >= 0; i--) {
      u.tSrc.value = src.texture;
      u.tAdd.value = this.down[i].texture;
      u.uTexel.value.set(1 / src.width, 1 / src.height);
      this.pass.render(renderer, this.upMat, this.up[i]);
      src = this.up[i];
    }

    const c = this.compositeMat.uniforms;
    c.tSrc.value = srcTexture;
    c.tBloom.value = src.texture;
    c.uStrength.value = this.strength / n;
    this.pass.render(renderer, this.compositeMat, output);
  }

  _disposeTargets() {
    for (const t of this.down) t.dispose();
    for (const t of this.up) t.dispose();
    this.down = [];
    this.up = [];
  }

  dispose() {
    this._disposeTargets();
    this.prefilter.dispose();
    this.downMat.dispose();
    this.upMat.dispose();
    this.compositeMat.dispose();
  }
}
