import { FullscreenPass, passMaterial } from './gl/FullscreenPass.js';
import { createTarget } from './gl/targets.js';
import noiseGLSL from './shaders/common/noise.glsl?raw';
import compositeFrag from './shaders/composite.frag?raw';
import * as THREE from 'three';

/** Scene registry. Modules are imported lazily the first time they are needed. */
export const SCENES = [
  { name: 'Liquid Paint', sub: 'acrylic fluid pour', load: () => import('./scenes/Scene1Fluid.js') },
  { name: 'Aurora', sub: 'borealis over the fjord', load: () => import('./scenes/Scene2Aurora.js') },
  { name: 'Starry Night', sub: 'after Van Gogh, 1889', load: () => import('./scenes/Scene3StarryNight.js') },
  { name: 'Stockholm', sub: 'silent film, 1930s', load: () => import('./scenes/Scene4Stockholm.js') },
  { name: 'Galaxy', sub: 'deep space', load: () => import('./scenes/Scene5Galaxy.js') },
];

/** Resolution multipliers for adaptive quality levels 0 (best) .. 3 (lowest). */
export const QUALITY_SCALES = [1, 0.82, 0.68, 0.55];
export const MAX_QUALITY_LEVEL = QUALITY_SCALES.length - 1;

/**
 * Scenes render internally at no more than ~this many pixels (before their
 * own renderScale); the canvas itself keeps the full device pixel ratio so
 * the final composite and dithering stay crisp on retina screens.
 */
const PIXEL_BUDGET = 3.4e6;

/**
 * Owns the active scene (and the outgoing one during a crossfade).
 * Each scene renders into its own HDR target; a final composite pass grades,
 * mixes and outputs to the canvas. The outgoing scene is disposed as soon as
 * its fade completes, so at most two scenes hold GPU memory at once.
 */
export class SceneManager {
  constructor(renderer) {
    this.renderer = renderer;
    this.current = null;
    this.previous = null;
    this.fade = 1;
    this.fadeDuration = 1.2;
    this.width = 1;
    this.height = 1;
    this.budgetScale = 1;
    this.time = 0;
    this.levels = new Map(); // remembered quality level per scene index
    this._requested = -1;
    this._loading = false;
    this._listeners = new Set();

    this.pass = new FullscreenPass();
    this.composite = passMaterial({
      fragmentShader: noiseGLSL + compositeFrag,
      uniforms: {
        tCur: { value: null },
        tPrev: { value: null },
        uMix: { value: 1 },
        uHasPrev: { value: 0 },
        uCurGrade: { value: new THREE.Vector2(1, 0) },
        uPrevGrade: { value: new THREE.Vector2(1, 0) },
        uTime: { value: 0 },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uDither: { value: new THREE.Vector2(1, 1) },
      },
    });
  }

  on(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _emit(type, index) {
    for (const fn of this._listeners) fn(type, index);
  }

  get index() {
    return this.current?.index ?? -1;
  }

  get fading() {
    return !!this.previous;
  }

  /** True while a scene is loading or a crossfade runs (FPS samples are unrepresentative). */
  get busy() {
    return this._loading || !!this.previous;
  }

  /**
   * Switch to scene `index`. Rapid key presses are coalesced: only the most
   * recent request is honoured once the in-flight load finishes.
   */
  async switchTo(index) {
    if (index < 0 || index >= SCENES.length) return;
    this._requested = index;
    if (this._loading) return;
    this._loading = true;
    try {
      while (this._requested !== -1 && this._requested !== this.index) {
        const idx = this._requested;
        this._emit('loading', idx);
        let slot;
        try {
          slot = await this._createSlot(idx);
        } catch (err) {
          console.warn(`Scene ${idx + 1} failed to initialise`, err);
          this._emit('error', idx);
          if (this._requested === idx) this._requested = -1;
          continue;
        }
        if (this._requested !== idx) {
          this._disposeSlot(slot); // superseded while loading
          continue;
        }
        if (this.previous) this._disposeSlot(this.previous);
        this.previous = this.current;
        this.current = slot;
        this.fade = this.previous ? 0 : 1;
        this._emit('switch', idx);
      }
    } finally {
      this._requested = -1;
      this._loading = false;
    }
  }

  async _createSlot(index) {
    const mod = await SCENES[index].load();
    const scene = new mod.default();
    const level = this.levels.get(index) ?? 0;
    scene.quality = level;
    await scene.init(this.renderer);
    const slot = { index, scene, level, target: null };
    this._sizeSlot(slot);
    return slot;
  }

  _sizeSlot(slot) {
    const s = slot.scene.renderScale * QUALITY_SCALES[slot.level] * this.budgetScale;
    const w = Math.max(2, Math.round(this.width * s));
    const h = Math.max(2, Math.round(this.height * s));
    if (!slot.target) slot.target = createTarget(w, h, { depth: !!slot.scene.needsDepth });
    else if (slot.target.width !== w || slot.target.height !== h) slot.target.setSize(w, h);
    slot.scene.resize(w, h);
  }

  _disposeSlot(slot) {
    if (!slot) return;
    try {
      slot.scene.dispose();
    } catch (err) {
      console.warn('Scene dispose failed', err);
    }
    slot.target?.dispose();
  }

  /** Lower the current scene's quality one step. Returns false if already at the floor. */
  degradeQuality() {
    const slot = this.current;
    if (!slot || slot.level >= MAX_QUALITY_LEVEL) return false;
    slot.level++;
    this.levels.set(slot.index, slot.level);
    slot.scene.setQuality(slot.level);
    this._sizeSlot(slot);
    return true;
  }

  get qualityLevel() {
    return this.current?.level ?? 0;
  }

  resize(width, height) {
    this.width = width;
    this.height = height;
    this.budgetScale = Math.min(1, Math.sqrt(PIXEL_BUDGET / (width * height)));
    this.composite.uniforms.uResolution.value.set(width, height);
    if (this.current) this._sizeSlot(this.current);
    if (this.previous) this._sizeSlot(this.previous);
  }

  update(dt, audio) {
    this.time += dt;
    if (this.previous) {
      this.fade += dt / this.fadeDuration;
      if (this.fade >= 1) {
        this.fade = 1;
        this._disposeSlot(this.previous);
        this.previous = null;
        this._emit('settled', this.index);
      }
    }
    this.current?.scene.update(dt, audio);
    this.previous?.scene.update(dt, audio);
  }

  render() {
    const r = this.renderer;
    const cur = this.current;
    const prev = this.previous;
    const u = this.composite.uniforms;

    if (!cur) {
      r.setRenderTarget(null);
      r.setClearColor(0x05070d, 1);
      r.clear();
      return;
    }

    cur.scene.render(cur.target);
    if (prev) prev.scene.render(prev.target);

    u.tCur.value = cur.target.texture;
    u.uCurGrade.value.set(cur.scene.exposure, cur.scene.toneMapped ? 1 : 0);
    u.uHasPrev.value = prev ? 1 : 0;
    u.tPrev.value = prev ? prev.target.texture : cur.target.texture;
    if (prev) u.uPrevGrade.value.set(prev.scene.exposure, prev.scene.toneMapped ? 1 : 0);
    u.uDither.value.set(cur.scene.dither ?? 1, cur.scene.ditherAnimated === false ? 0 : 1);
    u.uMix.value = this.fade;
    u.uTime.value = this.time;
    this.pass.render(r, this.composite, null);
  }
}
