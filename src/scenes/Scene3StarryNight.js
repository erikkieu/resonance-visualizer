import * as THREE from 'three';
import plates from 'virtual:texture-plates';
import { SceneBase } from './SceneBase.js';
import { FullscreenPass, passMaterial, precompile } from '../gl/FullscreenPass.js';
import { createTarget } from '../gl/targets.js';
import { pointer } from '../input.js';
import { createTunePanel, configParams, bindConfig } from '../tune.js';
import { SCORE_CONFIG } from '../scoreMap.js';
import { PROFILE, TUNE } from './profiles/andanteFestivo.js';

import noiseGLSL from '../shaders/common/noise.glsl?raw';
import paintGLSL from '../shaders/starry/paint.glsl?raw';
import layoutGLSL from '../shaders/starry/layout.glsl?raw';
import fieldFrag from '../shaders/starry/field.frag?raw';
import maskFrag from '../shaders/starry/mask.frag?raw';
import flowFrag from '../shaders/starry/flow.frag?raw';
import stateFrag from '../shaders/starry/state.frag?raw';
import strokeVert from '../shaders/starry/stroke.vert?raw';
import burstVert from '../shaders/starry/burst.vert?raw';
import strokeFrag from '../shaders/starry/stroke.frag?raw';
import canvasFrag from '../shaders/starry/canvas.frag?raw';
import finalFrag from '../shaders/starry/final.frag?raw';

/**
 * Scene 3: The Starry Night as a living oil painting, performing Sibelius'
 * "Andante Festivo" (string orchestra: noble legato lines that keep
 * building, a first climax around 1:34-2:03, a radiant final climax).
 * (It first performed the Ständchen as scene 2; the user swapped the visuals
 * of scenes 2 and 3, keeping the pieces on their keys.)
 *
 * Van Gogh's painting (public domain, /public/textures/starry-night.jpg) is
 * the colour and composition guide, never shown directly:
 *   1. A flow field shaped like the painting: the double spiral, waving wind
 *      bands, circular halos around the 11 stars and the moon, slow hills and
 *      a rising, swaying cypress (flow.frag).
 *   2. ~60k instanced brush strokes simulated on the GPU (state.frag) drift
 *      along that flow and are reborn near home; each takes its colour from
 *      the painting at its home (stroke.vert / stroke.frag).
 *   3. The strokes paint into a persistent wet canvas that smears along the
 *      flow and relaxes toward a blurred underpainting (canvas.frag), so
 *      motion leaves painterly trails.
 *   4. The final pass adds impasto light, canvas weave, glows, the note tint
 *      and a vignette (final.frag).
 *
 * The music arrives through audio.perf (scoreMap.js): with the Andante Festivo
 * analysis loaded it knows the sections, the climax ahead and every note;
 * with any other source it runs on the live analyser. How the piece is
 * painted (section states, melody light and lift, star blooms on melody
 * notes, ripples on the accompaniment) lives in profiles/andanteFestivo.js and is
 * tunable live with T. Bass makes the moon and the spiral breathe, treble
 * twinkles, energy sways the cypress.
 */

// ====================================================================== config
const CONFIG = {
  REFERENCE: 'starry-night.jpg', // in /public/textures (public domain)
  TRIM: [0.006, 0.01], // unpainted border of the scan (fraction of width / height)

  // Composition, read off the reference: u, v in 0..1 (v = 0 at the bottom),
  // radii in painting heights
  SPIRALS: [
    { u: 0.477, v: 0.67, r: 0.168, strength: 1.6 }, // the great spiral, counter-clockwise
    { u: 0.684, v: 0.517, r: 0.108, strength: -1.2 }, // its smaller partner, clockwise
  ],
  STARS: [
    [0.105, 0.956, 0.049],
    [0.232, 0.968, 0.032],
    [0.344, 0.961, 0.044],
    [0.414, 0.938, 0.035],
    [0.605, 0.916, 0.054],
    [0.233, 0.829, 0.044],
    [0.703, 0.768, 0.049],
    [0.324, 0.675, 0.035],
    [0.047, 0.551, 0.03],
    [0.127, 0.522, 0.039],
    [0.352, 0.472, 0.074],
  ],
  MOON: [0.906, 0.842, 0.084],
  HORIZON: [0.32, 0.3, 0.29, 0.28, 0.29, 0.36, 0.36, 0.41, 0.45, 0.48, 0.47], // v at u = 0, 0.1 ... 1

  // Fitting the painting to the screen
  FIT_STRETCH: 1.2, // max horizontal stretch on wide screens (the rest is a vertical crop)
  CROP_TOP_SHARE: 0.2, // share of that crop taken from the top (keeps the top row of stars)

  STROKES: {
    MAX: 60000,
    BASE: 0.8, // fraction always shown; the rest joins at the climax
    LIFE: [4, 9], // scene seconds before a stroke is reborn near its home
    OPACITY: 0.55,
    SEGMENTS: 6, // curve resolution of each stroke
  },
  FLOW: {
    GAIN: 0.03, // painting heights per second at 1x
    TURBULENCE: 0.035, // curl-noise share of the flow
    STAR_SWIRL: 0.9, // halo swirl strength around each star
    MOON_SWIRL: 0.6, // ... and around the moon (low, so the crescent keeps its shape)
    SMEAR: 0.4, // how much the wet paint itself follows the flow
    FADE: 0.35, // relaxation of the canvas toward the underpainting, per scene second
    RESOLUTION: 256, // flow texture width
  },
  CANVAS_MAX: 1300, // canvas height cap in texels
  QUALITY: [
    { strokes: 1, canvas: 1 },
    { strokes: 0.75, canvas: 0.85 },
    { strokes: 0.55, canvas: 0.72 },
    { strokes: 0.4, canvas: 0.6 },
  ],

  BURSTS: { COUNT: 24, STROKES: 96, LIFE: 2.5, PULSE_DECAY: 2.5 }, // onset bloom capacity
  IDLE_SPEED: 0.4, // flow speed with nothing playing
  MOON_GLOW: 0.22,
  BASS: { SPIRAL: 0.08 }, // breathing of the spiral (the moon glow breathes in the shader)
  SWAY: { MIN: 0.004, GAIN: 0.02, SMOOTHING: 1.0 }, // cypress sway amplitude from energy
  POINTER: { RADIUS: 0.06, MAX_MOVE: 0.03 },
};
// ============================================================================

const STATE_WIDTH = Math.ceil(Math.sqrt(CONFIG.STROKES.MAX));
const rand = (a, b) => a + Math.random() * (b - a);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/** A strip of 2 * (segments + 1) vertices: x along the stroke, y across it. */
function strokeGeometry(segments, instances) {
  const geo = new THREE.InstancedBufferGeometry();
  const pos = [];
  const index = [];
  for (let i = 0; i <= segments; i++) {
    const u = (i / segments) * 2 - 1;
    pos.push(u, -1, 0, u, 1, 0);
    if (i < segments) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(index);
  geo.instanceCount = instances;
  return geo;
}

/** Melody height 0..1 -> light colour, from the profile's palette. */
const PALETTE = PROFILE.PALETTE.map(([h, hex]) => [h, new THREE.Color(hex)]);
function heightColor(h, out) {
  for (let i = 1; i < PALETTE.length; i++) {
    const [h1, c1] = PALETTE[i];
    if (h <= h1 || i === PALETTE.length - 1) {
      const [h0, c0] = PALETTE[i - 1];
      return out.lerpColors(c0, c1, clamp01((h - h0) / (h1 - h0)));
    }
  }
  return out.copy(PALETTE[0][1]);
}
const STAGE_KEYS = Object.keys(PROFILE.STAGES.calm);

export default class Scene3StarryNight extends SceneBase {
  constructor() {
    super({ baseSpeed: CONFIG.IDLE_SPEED, speedGain: 0 });
    this.renderScale = 1;
    this.toneMapped = false;
    this.realTime = 0;
    this.sdt = 0;
    // section state (blended stage presets) and the loudness tide
    this.state = { ...PROFILE.STAGES.calm };
    this.swell = false;
    this.speedTarget = CONFIG.IDLE_SPEED;
    this.speedStage = CONFIG.IDLE_SPEED;
    this.speedMult = CONFIG.IDLE_SPEED;
    this.climax = 0;
    this.glow = PROFILE.GLOW.BASE;
    this.jumpId = -1;
    // melody light and lift, mode colour, sway, pulses, bursts
    this.height = 0.5;
    this.tint = new THREE.Color(1, 1, 1);
    this.modeTint = new THREE.Color(1, 1, 1);
    this._color = new THREE.Color();
    this.tintAmount = 0;
    this.lift = 0;
    this.sway = CONFIG.SWAY.MIN;
    this.pulses = new Float32Array(12);
    this.burstIndex = 0;
    this.lastStar = -1;
    this.rippleBudget = 0;
    this.eventAmp = 1;
    this.events = { blooms: 0, ripples: 0 };
    this.map = { w: 1, h: 1, u0: 0, v0: 0 };
  }

  // ------------------------------------------------------------- setup

  async init(renderer) {
    await super.init(renderer);
    this.pass = new FullscreenPass();
    this.floatType = renderer.extensions.has('EXT_color_buffer_float') ? THREE.FloatType : THREE.HalfFloatType;
    await this._loadReference();

    const C = CONFIG;
    const P = this.paintAspect;
    const paintUniforms = () => ({ uAspect: { value: P }, uTrim: { value: this.trim.clone() } });
    const prefix = noiseGLSL + paintGLSL;
    this.stars = C.STARS.map(([u, v, r]) => new THREE.Vector3(u * P, v, r)).concat([new THREE.Vector3(C.MOON[0] * P, C.MOON[1], C.MOON[2])]);

    // --- reference analysis (cypress / landscape / light), mipmapped for soft glows
    const maskH = 512;
    this.maskRT = new THREE.WebGLRenderTarget(Math.round(maskH * P), maskH, {
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    });
    const maskMat = passMaterial({ fragmentShader: prefix + maskFrag, uniforms: { ...paintUniforms(), tRef: { value: this.ref }, uHorizon: { value: C.HORIZON } } });
    this.pass.render(renderer, maskMat, this.maskRT);
    maskMat.dispose();
    renderer.setRenderTarget(null); // makes three refresh the mask's mipmaps

    // --- flow field
    const fw = C.FLOW.RESOLUTION;
    this.flowRT = createTarget(fw, Math.round(fw / P));
    this.flowMat = passMaterial({
      fragmentShader: prefix + flowFrag,
      uniforms: {
        ...paintUniforms(),
        tMask: { value: this.maskRT.texture },
        uTime: { value: 0 },
        uSpirals: { value: C.SPIRALS.map((s) => new THREE.Vector4(s.u * P, s.v, s.r, s.strength)) },
        uStars: { value: this.stars.map((s) => s.clone()) },
        uTurbulence: { value: C.FLOW.TURBULENCE },
        uStarSwirl: { value: C.FLOW.STAR_SWIRL },
        uMoonSwirl: { value: C.FLOW.MOON_SWIRL },
        uFlowGain: { value: C.FLOW.GAIN },
      },
    });

    // --- stroke homes (shuffled jittered grid, so any prefix of strokes covers the canvas)
    const n = STATE_WIDTH * STATE_WIDTH;
    const home = new Float32Array(n * 4);
    const cols = Math.ceil(Math.sqrt(C.STROKES.MAX * P));
    const rows = Math.ceil(C.STROKES.MAX / cols);
    const cells = [];
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) cells.push([x, y]);
    for (let i = cells.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [cells[i], cells[j]] = [cells[j], cells[i]];
    }
    for (let i = 0; i < n; i++) {
      const [x, y] = cells[i % cells.length];
      home[i * 4] = ((x + Math.random()) / cols) * P;
      home[i * 4 + 1] = (y + Math.random()) / rows;
      home[i * 4 + 2] = Math.random();
      home[i * 4 + 3] = Math.random();
    }
    this.homeTex = new THREE.DataTexture(home, STATE_WIDTH, STATE_WIDTH, THREE.RGBAFormat, THREE.FloatType);
    this.homeTex.needsUpdate = true;

    // --- stroke state (ping-pong), initialised at home with random life phases
    const stateOpts = { type: this.floatType, filter: THREE.NearestFilter };
    this.stateA = createTarget(STATE_WIDTH, STATE_WIDTH, stateOpts);
    this.stateB = createTarget(STATE_WIDTH, STATE_WIDTH, stateOpts);
    const initMat = passMaterial({
      fragmentShader: noiseGLSL + `uniform sampler2D tHome; varying vec2 vUv;
        void main() { vec4 h = texelFetch(tHome, ivec2(gl_FragCoord.xy), 0); gl_FragColor = vec4(h.xy, hash12(gl_FragCoord.xy), 1.0); }`,
      uniforms: { tHome: { value: this.homeTex } },
    });
    this.pass.render(renderer, initMat, this.stateA);
    initMat.dispose();
    this.stateMat = passMaterial({
      fragmentShader: prefix + stateFrag,
      uniforms: {
        ...paintUniforms(),
        tState: { value: null },
        tHome: { value: this.homeTex },
        tFlow: { value: this.flowRT.texture },
        uDt: { value: 0 },
        uLife: { value: new THREE.Vector2(...C.STROKES.LIFE) },
        uSeed: { value: 0 },
        uPointer: { value: new THREE.Vector2(-10, -10) },
        uPointerMove: { value: new THREE.Vector2() },
        uPointerRadius: { value: C.POINTER.RADIUS },
      },
    });

    // --- strokes and onset bursts, drawn into the canvas
    const blend = {
      side: THREE.DoubleSide, // strokes turn with the flow, so either winding must draw
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.SrcAlphaFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    };
    this.strokeMat = new THREE.ShaderMaterial({
      vertexShader: prefix + strokeVert,
      fragmentShader: noiseGLSL + strokeFrag,
      uniforms: {
        ...paintUniforms(),
        tState: { value: this.stateA.texture },
        tHome: { value: this.homeTex },
        tFlow: { value: this.flowRT.texture },
        tRef: { value: this.ref },
        tMask: { value: this.maskRT.texture },
        uStateWidth: { value: STATE_WIDTH },
        uVisible: { value: C.STROKES.BASE },
        uOpacity: { value: C.STROKES.OPACITY },
        uBright: { value: 1 },
        uSway: { value: C.SWAY.MIN },
        uTime: { value: 0 },
      },
      ...blend,
    });
    const q = C.QUALITY[this.quality] ?? C.QUALITY[0];
    this.strokes = new THREE.Mesh(strokeGeometry(C.STROKES.SEGMENTS, Math.floor(C.STROKES.MAX * q.strokes)), this.strokeMat);
    this.strokes.frustumCulled = false;

    const B = C.BURSTS;
    this.burstMat = new THREE.ShaderMaterial({
      vertexShader: prefix + burstVert,
      fragmentShader: noiseGLSL + strokeFrag,
      defines: { BURSTS: B.COUNT, BURST_STROKES: B.STROKES, BURST_LIFE: B.LIFE.toFixed(2) },
      uniforms: {
        ...paintUniforms(),
        uBursts: { value: Array.from({ length: B.COUNT }, () => new THREE.Vector4(0, 0, 0, -100)) },
        uBurstColors: { value: Array.from({ length: B.COUNT }, () => new THREE.Color()) },
        uBurstAmp: { value: new Float32Array(B.COUNT) },
        uRealTime: { value: 0 },
      },
      ...blend,
    });
    this.bursts = new THREE.Mesh(strokeGeometry(4, B.COUNT * B.STROKES), this.burstMat);
    this.bursts.frustumCulled = false;
    this.paintScene = new THREE.Scene();
    this.paintScene.add(this.strokes, this.bursts);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    // --- canvas feedback and the final pass
    this.canvasMat = passMaterial({
      fragmentShader: prefix + canvasFrag,
      uniforms: {
        ...paintUniforms(),
        tCanvas: { value: null },
        tFlow: { value: this.flowRT.texture },
        tRef: { value: this.ref },
        uDt: { value: 0 },
        uSmear: { value: C.FLOW.SMEAR },
        uFade: { value: C.FLOW.FADE },
        uPointer: { value: new THREE.Vector2(-10, -10) },
        uPointerMove: { value: new THREE.Vector2() },
        uPointerRadius: { value: C.POINTER.RADIUS },
      },
    });
    this.copyMat = passMaterial({
      fragmentShader: `uniform sampler2D tSrc; varying vec2 vUv; void main() { gl_FragColor = texture2D(tSrc, vUv); }`,
      uniforms: { tSrc: { value: null } },
    });
    this.finalMat = passMaterial({
      fragmentShader: prefix + finalFrag,
      uniforms: {
        ...paintUniforms(),
        tCanvas: { value: null },
        tMask: { value: this.maskRT.texture },
        uMap: { value: new THREE.Vector4(1, 1, 0, 0) },
        uCanvasTexel: { value: new THREE.Vector2() },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uTime: { value: 0 },
        uTreble: { value: 0 },
        uBass: { value: 0 },
        uGlow: { value: PROFILE.GLOW.BASE },
        uMoonGlow: { value: C.MOON_GLOW },
        uClimax: { value: 0 },
        uTint: { value: new THREE.Color(1, 1, 1) },
        uTintAmount: { value: 0 },
        uStars: { value: this.stars.map((s) => s.clone()) },
        uPulse: { value: new Float32Array(12) },
        uMoon: { value: new THREE.Vector2(this.stars[11].x, this.stars[11].y) },
      },
    });

    await this.pass.compile(renderer, [this.flowMat, this.stateMat, this.canvasMat, this.copyMat, this.finalMat]);
    await precompile(renderer, this.paintScene, this.camera);
    this.tune = createTunePanel({ title: 'Starry Night · Andante Festivo', storageKey: 'resonance.tune.starry', params: configParams(PROFILE, TUNE), onChange: bindConfig(PROFILE) });
  }

  /** The reference painting, or a procedural stand-in when the image is missing. */
  async _loadReference() {
    const C = CONFIG;
    if (plates.includes(C.REFERENCE)) {
      try {
        const tex = await new THREE.TextureLoader().loadAsync(`${import.meta.env.BASE_URL}textures/${C.REFERENCE}`);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.generateMipmaps = true;
        tex.needsUpdate = true;
        const { width, height } = tex.image;
        this.ref = tex;
        this.ownsRefTexture = true;
        this.trim = new THREE.Vector4(C.TRIM[0], C.TRIM[1], 1 - 2 * C.TRIM[0], 1 - 2 * C.TRIM[1]);
        this.paintAspect = (width * this.trim.z) / (height * this.trim.w);
        return;
      } catch {
        /* fall through to the procedural reference */
      }
    }
    const P = 1.262;
    this.paintAspect = P;
    this.trim = new THREE.Vector4(0, 0, 1, 1);
    this.refRT = new THREE.WebGLRenderTarget(1024, Math.round(1024 / P), {
      type: THREE.HalfFloatType,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    });
    const mat = passMaterial({
      fragmentShader: noiseGLSL + layoutGLSL + fieldFrag,
      uniforms: {
        uAspect: { value: P },
        uLayout: { value: P },
        uOffsetX: { value: 0 },
        uTime: { value: 0 },
        uBass: { value: 0 },
        uMid: { value: 0 },
        uTreble: { value: 0 },
        uEnergy: { value: 0 },
        uBeat: { value: 0 },
        uSway: { value: 0 },
      },
    });
    this.pass.render(this.renderer, mat, this.refRT);
    mat.dispose();
    this.renderer.setRenderTarget(null);
    this.ref = this.refRT.texture;
  }

  // ------------------------------------------------------------ sizing

  resize(width, height) {
    super.resize(width, height);
    const C = CONFIG;
    const A = width / height;
    const P = this.paintAspect;
    // fit: full painting width with a little stretch on wide screens, the
    // rest cropped (mostly from the bottom); narrow screens crop the sides
    let w = 1;
    let h = 1;
    if (A >= P) h = Math.min(1, (P * Math.min(A / P, C.FIT_STRETCH)) / A);
    else w = A / P;
    this.map = { w, h, u0: (1 - w) * 0.5, v0: (1 - h) * (1 - C.CROP_TOP_SHARE) };
    this.finalMat.uniforms.uMap.value.set(w, h, this.map.u0, this.map.v0);
    this.finalMat.uniforms.uResolution.value.set(width, height);
    this._sizeCanvas();
  }

  setQuality(level) {
    super.setQuality(level);
    const q = CONFIG.QUALITY[level] ?? CONFIG.QUALITY[0];
    this.strokes.geometry.instanceCount = Math.floor(CONFIG.STROKES.MAX * q.strokes);
    if (this.height > 1) this._sizeCanvas();
  }

  /** About one canvas texel per screen pixel of the visible painting, capped. */
  _sizeCanvas() {
    const q = CONFIG.QUALITY[this.quality] ?? CONFIG.QUALITY[0];
    const ch = Math.max(256, Math.round(Math.min(CONFIG.CANVAS_MAX, this.height / this.map.h) * q.canvas));
    const cw = Math.round(ch * this.paintAspect);
    if (this.canvasA && this.canvasA.width === cw && this.canvasA.height === ch) return;
    const next = [createTarget(cw, ch), createTarget(cw, ch)];
    if (this.canvasA) {
      // keep the wet paint across resizes
      this.copyMat.uniforms.tSrc.value = this.canvasA.texture;
      this.pass.render(this.renderer, this.copyMat, next[0]);
      this.canvasA.dispose();
      this.canvasB.dispose();
    } else {
      // first frame: start from the soft underpainting
      const u = this.canvasMat.uniforms;
      u.tCanvas.value = next[1].texture;
      u.uDt.value = 1;
      u.uFade.value = 50;
      this.pass.render(this.renderer, this.canvasMat, next[0]);
      u.uFade.value = CONFIG.FLOW.FADE;
    }
    [this.canvasA, this.canvasB] = next;
    this.finalMat.uniforms.uCanvasTexel.value.set(1 / cw, 1 / ch);
  }

  // ------------------------------------------------------------ update

  /**
   * Flow speed for the anticipating drive: almost frozen at the very bottom,
   * QUIET in soft passages, 1x in the middle; in the swell (entered at
   * SWELL_ENTER, left below SWELL_EXIT) from 1x up to MAX.
   */
  _speedForDrive(drive) {
    const S = PROFILE.SPEED;
    if (!this.swell && drive >= S.SWELL_ENTER) this.swell = true;
    else if (this.swell && drive < S.SWELL_EXIT) this.swell = false;
    if (this.swell) return lerp(S.MID, S.MAX, clamp01((drive - S.SWELL_EXIT) / (1 - S.SWELL_EXIT)));
    if (drive < S.DRIVE_QUIET) return lerp(S.FREEZE, S.QUIET, smoothstep(S.DRIVE_FREEZE, S.DRIVE_QUIET, drive));
    return lerp(S.QUIET, S.MID, smoothstep(S.DRIVE_QUIET, S.DRIVE_MID, drive));
  }

  update(dt, audio) {
    const C = CONFIG;
    const P = PROFILE;
    const perf = audio.perf;
    this.realTime += dt;
    const follow = (v, to, tau) => v + (to - v) * (1 - Math.exp(-dt / tau));
    const presence = audio.presence;
    const drive = perf.drive;
    const jumped = perf.jumpId !== this.jumpId; // a seek: settle into the new moment at once
    this.jumpId = perf.jumpId;

    // --- section state: the current stage, blending into the next one ahead of the change
    const now = P.STAGES[perf.stage] ?? P.STAGES.calm;
    const next = perf.next ? P.STAGES[perf.next.stage] ?? now : now;
    const cross = perf.next ? smoothstep(SCORE_CONFIG.LOOKAHEAD, 0, perf.timeToNext) : 0;
    for (const k of STAGE_KEYS) {
      let target = lerp(now[k], next[k], cross);
      if (perf.ending && P.ENDING[k] !== undefined) target *= P.ENDING[k];
      if (presence < 1) target = lerp(P.STAGES.building[k], target, presence); // idle: neutral
      this.state[k] = jumped ? target : follow(this.state[k], target, P.STAGE_BLEND / 3);
    }
    const st8 = this.state;

    // --- climax: the score's envelope already rises during the build
    this.climax = jumped ? perf.climax : follow(this.climax, perf.climax * presence, 0.35);

    // --- the tide: drive -> speed, scaled by the section, two smoothing stages so it never jerks
    const musical = this._speedForDrive(drive) * st8.speed * (1 + (P.CLIMAX.SPEED - 1) * this.climax);
    this.speedTarget = lerp(C.IDLE_SPEED, Math.min(musical, P.SPEED.MAX), presence);
    if (jumped) this.speedStage = this.speedMult = this.speedTarget;
    this.speedStage = follow(this.speedStage, this.speedTarget, P.SPEED.SMOOTHING / 2);
    this.speedMult = follow(this.speedMult, this.speedStage, P.SPEED.SMOOTHING / 2);
    this.speed = this.speedMult;
    this.sdt = dt * this.speedMult;
    this.time += this.sdt;

    // --- exposure: quiet passages look truly quiet (fast to brighten, slow to darken)
    const X = P.EXPOSURE;
    const expTarget = lerp(1, lerp(X.QUIET, X.LOUD, Math.pow(drive, X.CURVE)) * st8.exposure * lerp(1, X.CLIMAX, this.climax), presence);
    this.exposure = jumped ? expTarget : follow(this.exposure, expTarget, expTarget > this.exposure ? X.ATTACK : X.RELEASE);

    // --- light: stars dim in the quietest passages and bloom at the climax
    const dim = lerp(P.GLOW.DIM, P.GLOW.BASE, smoothstep(P.SPEED.DRIVE_FREEZE, P.SPEED.DRIVE_MID, drive));
    const glowTarget = lerp(P.GLOW.BASE, dim * st8.glow, presence) * lerp(1, P.GLOW.CLIMAX, this.climax);
    this.glow = jumped ? glowTarget : follow(this.glow, glowTarget, P.GLOW.SMOOTHING);

    // --- melody: height lifts the spiral and the moon and colours the light
    const M = P.MELODY;
    const clear = smoothstep(M.MIN_CONF, M.MIN_CONF + 0.3, perf.heightConf);
    const heightTarget = lerp(0.5, perf.height, clear * presence);
    this.height = jumped ? heightTarget : follow(this.height, heightTarget, heightTarget > this.height ? M.ATTACK : M.RELEASE);
    this.lift = (this.height - 0.5) * M.LIFT;
    const modeColor = P.MODE[perf.key.mode];
    if (modeColor) this.modeTint.lerp(this._color.set(modeColor), jumped ? 1 : 1 - Math.exp(-dt / P.MODE.SMOOTHING));
    heightColor(this.height, this._color).lerp(this.modeTint, P.MODE.AMOUNT);
    this.tint.lerp(this._color, jumped ? 1 : 1 - Math.exp(-dt / 0.4));
    this.tintAmount = (P.TINT.BASE + P.TINT.MELODY * clear) * presence;

    // --- the spirals: strength by section, breathing with the bass
    const breathe = 1 + C.BASS.SPIRAL * audio.bass * presence;
    const fu = this.flowMat.uniforms;
    C.SPIRALS.forEach((s, i) => fu.uSpirals.value[i].set(s.u * this.paintAspect, s.v + this.lift, s.r * breathe, s.strength * st8.spiral));
    fu.uStars.value[11].set(this.stars[11].x, this.stars[11].y + this.lift, this.stars[11].z);
    fu.uTime.value = this.time;

    // --- energy sways the cypress
    this.sway = follow(this.sway, C.SWAY.MIN + C.SWAY.GAIN * audio.energy * presence, C.SWAY.SMOOTHING);

    // --- notes: melody notes bloom a star, the accompaniment ripples the wind
    const E = P.EVENTS;
    this.eventAmp = st8.events * lerp(E.QUIET_AMP, 1, Math.sqrt(drive));
    this.rippleBudget = Math.min(E.MAX_PER_SECOND, this.rippleBudget + dt * E.MAX_PER_SECOND);
    if (presence > 0.3 && drive >= E.MIN_DRIVE) {
      for (const o of perf.onsets) {
        // land exactly on the note: the bloom is born at the onset time, not at this frame
        const birth = this.realTime - Math.max(0, Math.min(0.1, perf.t - o.t));
        if (o.melody) this._melodyBloom(o, birth);
        else if (this.rippleBudget >= 1) {
          this.rippleBudget -= 1;
          this._ripple(o, birth);
        }
      }
    }
    for (let i = 0; i < 12; i++) this.pulses[i] *= Math.exp(-dt * C.BURSTS.PULSE_DECAY);

    // --- pointer: a finger in wet paint
    const PA = this.paintAspect;
    const m = this.map;
    const su = this.stateMat.uniforms;
    const cu = this.canvasMat.uniforms;
    if (pointer.active) {
      const px = (pointer.x * m.w + m.u0) * PA;
      const py = pointer.y * m.h + m.v0;
      let mx = pointer.dx * m.w * PA;
      let my = pointer.dy * m.h;
      const ml = Math.hypot(mx, my);
      if (ml > C.POINTER.MAX_MOVE) {
        mx *= C.POINTER.MAX_MOVE / ml;
        my *= C.POINTER.MAX_MOVE / ml;
      }
      su.uPointer.value.set(px, py);
      su.uPointerMove.value.set(mx, my);
      cu.uPointer.value.set(px, py);
      cu.uPointerMove.value.set(mx, my);
    }

    // --- uniforms for this frame
    su.uDt.value = this.sdt;
    su.uSeed.value = (su.uSeed.value + 17.13) % 1000;
    cu.uDt.value = this.sdt;
    const sk = this.strokeMat.uniforms;
    sk.uVisible.value = lerp(st8.strokes, 1, this.climax * P.CLIMAX.STROKE_BOOST);
    sk.uBright.value = st8.bright * lerp(1, P.CLIMAX.BRIGHT, this.climax) * (1 + M.BRIGHTEN * (this.height - 0.5) * 2 * clear);
    sk.uSway.value = this.sway;
    sk.uTime.value = this.time;
    this.burstMat.uniforms.uRealTime.value = this.realTime;
    const f = this.finalMat.uniforms;
    f.uTime.value = this.time;
    f.uTreble.value = audio.treble * presence;
    f.uBass.value = audio.bass * presence;
    f.uGlow.value = this.glow;
    f.uMoonGlow.value = C.MOON_GLOW * this.glow * (0.8 + 0.4 * audio.bass * presence);
    f.uClimax.value = this.climax;
    f.uTint.value.copy(this.tint);
    f.uTintAmount.value = this.tintAmount;
    f.uPulse.value.set(this.pulses);
    f.uMoon.value.set(this.stars[11].x, this.stars[11].y + this.lift);
  }

  _nextBurst() {
    return this.burstIndex++ % CONFIG.BURSTS.COUNT;
  }

  /** A melody note: bright strokes and a halo around the star at the note's height. */
  _melodyBloom(o, birth) {
    const E = PROFILE.EVENTS;
    const amp = this.eventAmp;
    let i;
    if (o.height > E.MOON_ABOVE && Math.random() < 0.35 && this.lastStar !== 11) i = 11;
    else {
      const y = lerp(E.STAR_Y[0], E.STAR_Y[1], o.height);
      const near = this.stars
        .slice(0, 11)
        .map((s, k) => [k, Math.abs(s.y - y)])
        .filter(([k]) => k !== this.lastStar)
        .sort((a, b) => a[1] - b[1])
        .slice(0, E.STAR_CHOICES);
      i = near[Math.floor(Math.random() * near.length)][0];
    }
    this.lastStar = i;
    const s = this.stars[i];
    const slot = this._nextBurst();
    const u = this.burstMat.uniforms;
    u.uBursts.value[slot].set(s.x, i === 11 ? s.y + this.lift : s.y, s.z * lerp(...E.MELODY_RADIUS, o.strength), birth);
    // warm yellow-white, coloured by the note's own height (high notes pale, low notes blue-violet)
    heightColor(o.height, this._color);
    u.uBurstColors.value[slot].setRGB(1.0, 0.86, 0.52).lerp(this._color, 0.55).multiplyScalar(rand(0.9, 1.1));
    u.uBurstAmp.value[slot] = Math.min(1, 0.3 + 0.55 * amp * (0.6 + 0.4 * o.strength));
    this.pulses[i] = Math.max(this.pulses[i], lerp(...E.MELODY_PULSE, o.strength) * amp);
    this.events.blooms++;
  }

  /** An accompaniment note: a faint ripple of sky strokes somewhere along the wind. */
  _ripple(o, birth) {
    const E = PROFILE.EVENTS;
    const slot = this._nextBurst();
    const u = this.burstMat.uniforms;
    // the wind band, with the note's height nudging it up or down
    const v = lerp(E.RIPPLE_BAND[0], E.RIPPLE_BAND[1], clamp01(0.5 * Math.random() + 0.5 * o.height));
    u.uBursts.value[slot].set(rand(0.04, 0.96) * this.paintAspect, v, rand(...E.RIPPLE_RADIUS), birth);
    heightColor(o.height, this._color);
    u.uBurstColors.value[slot].set(E.RIPPLE_COLOR).lerp(this._color, 0.3).multiplyScalar(rand(0.9, 1.1));
    u.uBurstAmp.value[slot] = E.RIPPLE_AMP * this.eventAmp * (0.5 + 0.5 * o.strength);
    this.events.ripples++;
  }

  // ------------------------------------------------------------ render

  render(target) {
    const r = this.renderer;
    // 1. flow field
    this.pass.render(r, this.flowMat, this.flowRT);
    // 2. move the strokes
    this.stateMat.uniforms.tState.value = this.stateA.texture;
    this.pass.render(r, this.stateMat, this.stateB);
    [this.stateA, this.stateB] = [this.stateB, this.stateA];
    this.strokeMat.uniforms.tState.value = this.stateA.texture;
    // 3. smear and relax the wet canvas
    this.canvasMat.uniforms.tCanvas.value = this.canvasA.texture;
    this.pass.render(r, this.canvasMat, this.canvasB);
    // 4. paint this frame's strokes on top
    r.setRenderTarget(this.canvasB);
    r.render(this.paintScene, this.camera);
    [this.canvasA, this.canvasB] = [this.canvasB, this.canvasA];
    // 5. show it
    this.finalMat.uniforms.tCanvas.value = this.canvasA.texture;
    this.pass.render(r, this.finalMat, target);
    this.stateMat.uniforms.uPointerMove.value.set(0, 0);
    this.canvasMat.uniforms.uPointerMove.value.set(0, 0);
  }

  /** Live values for the debug overlay (D). */
  get debug() {
    const hex = '#' + this.tint.getHexString(THREE.SRGBColorSpace);
    const st = this.state;
    return {
      'speed ×': `${this.speedMult.toFixed(2)}  → ${this.speedTarget.toFixed(2)}${this.swell ? '  SWELL' : ''}`,
      state: `speed ${st.speed.toFixed(2)} · glow ${st.glow.toFixed(2)} · spiral ${st.spiral.toFixed(2)}`,
      climax: `${this.climax.toFixed(2)} · exposure ${this.exposure.toFixed(2)}`,
      light: { swatch: hex, text: `height ${this.height.toFixed(2)} · tint ${this.tintAmount.toFixed(2)}` },
      events: `${this.events.blooms} blooms · ${this.events.ripples} ripples`,
      strokes: `${Math.round(this.strokes.geometry.instanceCount * this.strokeMat.uniforms.uVisible.value)}`,
    };
  }

  dispose() {
    this.tune?.dispose();
    for (const t of [this.maskRT, this.flowRT, this.stateA, this.stateB, this.canvasA, this.canvasB, this.refRT]) t?.dispose();
    for (const m of [this.flowMat, this.stateMat, this.canvasMat, this.copyMat, this.finalMat, this.strokeMat, this.burstMat]) m?.dispose();
    this.strokes?.geometry.dispose();
    this.bursts?.geometry.dispose();
    this.homeTex?.dispose();
    if (this.ownsRefTexture) this.ref?.dispose();
  }
}
