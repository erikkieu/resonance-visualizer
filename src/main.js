import * as THREE from 'three';
import { audio } from './audio.js';
import { SceneManager, SCENES } from './SceneManager.js';
import { createUI } from './ui.js';
import { createDebugOverlay } from './debug.js';
import { pointer, resetPointerDeltas } from './input.js';
import { supportsHalfFloatTargets } from './gl/targets.js';
import { Performance } from './scoreMap.js';
import { connectLibrary } from './library.js';

/**
 * main.js: renderer, frame loop, keyboard/pointer input and adaptive quality.
 */

const MAX_DPR = 2;
const FPS_FLOOR = 40; // below this (sustained) the current scene drops a quality level
const FPS_WINDOW = 1.5; // seconds per measurement
const SETTLE_TIME = 2.0; // ignore measurements right after switches / resizes

function showFallback(title, detail) {
  const el = document.getElementById('fallback');
  el.innerHTML = `<div><h2>${title}</h2><p>${detail}</p></div>`;
  el.hidden = false;
  document.getElementById('ui').hidden = true;
  document.getElementById('start').hidden = true;
}

function hasWebGL2() {
  try {
    return !!document.createElement('canvas').getContext('webgl2');
  } catch {
    return false;
  }
}

function boot() {
  if (!hasWebGL2()) {
    showFallback('WebGL 2 is not available', 'Resonance needs a browser and GPU with WebGL 2 support. Try a recent Chrome, Edge, Firefox or Safari, and make sure hardware acceleration is enabled.');
    return;
  }

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
  } catch (err) {
    showFallback('Could not start WebGL', String(err?.message || err));
    return;
  }

  if (!supportsHalfFloatTargets(renderer)) {
    renderer.dispose();
    showFallback('Half-float rendering is not supported', 'This GPU cannot render to half-float textures, which the fluid simulation and HDR pipeline require.');
    return;
  }

  renderer.autoClear = false;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_DPR));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x05070d, 1);
  document.getElementById('app').appendChild(renderer.domElement);

  const canvas = renderer.domElement;
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    showFallback('The GPU context was lost', 'Reload the page to restart the visualizer.');
  });

  // the score follower: scenes read the blended view of the music as audio.perf
  const perf = new Performance(audio);
  audio.perf = perf;
  connectLibrary(audio, perf);

  const manager = new SceneManager(renderer);
  const ui = createUI({ manager, audio, toggleFullscreen });
  const debug = createDebugOverlay({ audio, manager });

  // ------------------------------------------------------------- sizing

  const size = new THREE.Vector2();
  function resize() {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_DPR));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.getDrawingBufferSize(size);
    manager.resize(size.x, size.y);
    settle = SETTLE_TIME;
  }
  window.addEventListener('resize', resize);

  // ---------------------------------------------------------- fullscreen

  function toggleFullscreen() {
    const doc = document;
    const el = doc.documentElement;
    const active = doc.fullscreenElement || doc.webkitFullscreenElement;
    try {
      if (active) (doc.exitFullscreen || doc.webkitExitFullscreen).call(doc);
      else (el.requestFullscreen || el.webkitRequestFullscreen).call(el)?.catch?.(() => {});
    } catch {
      ui.toast('Fullscreen is not available here');
    }
  }

  // ------------------------------------------------------------ keyboard

  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target instanceof HTMLInputElement && e.target.type !== 'range') return;
    audio.ensureContext().catch(() => {}); // any gesture may unlock audio

    const k = e.key.toLowerCase();
    if (debug.visible && e.shiftKey && /^Digit\d$/.test(e.code)) {
      // scrub: with the debug overlay open, Shift+0..9 jumps to 0 %, 10 % ... 90 % of the piece
      const d = audio.perf?.map?.duration;
      if (d) audio.seekTo((Number(e.code.slice(5)) / 10) * d);
    } else if (k >= '1' && k <= String(SCENES.length)) {
      ui.begin();
      ui.activity();
      manager.switchTo(Number(k) - 1);
    } else if (k === 'f') {
      toggleFullscreen();
    } else if (k === 'h') {
      ui.toggleHidden();
    } else if (k === 'd') {
      debug.toggle();
    } else if (k === 'p' && !e.shiftKey) {
      ui.playScenePiece(); // (Shift+P is the scene's own: Scene 3 replays its painting)
    } else if (k === ' ') {
      e.preventDefault();
      ui.togglePlay();
      ui.activity();
    } else {
      ui.activity();
    }
  });

  // ------------------------------------------------------------- pointer

  function setPointer(e) {
    const r = canvas.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = 1 - (e.clientY - r.top) / r.height;
    if (pointer.active) {
      pointer.dx += x - pointer.x;
      pointer.dy += y - pointer.y;
    }
    pointer.x = x;
    pointer.y = y;
    pointer.nx = x * 2 - 1;
    pointer.ny = y * 2 - 1;
    pointer.active = true;
  }

  window.addEventListener('pointermove', (e) => {
    setPointer(e);
    ui.activity();
  });
  canvas.addEventListener('pointerdown', (e) => {
    setPointer(e);
    pointer.down = true;
    pointer.pressId++;
    canvas.setPointerCapture?.(e.pointerId);
    audio.ensureContext().catch(() => {});
    ui.activity();
  });
  const release = () => (pointer.down = false);
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  window.addEventListener('blur', release);

  // ---------------------------------------------------------------- loop

  let last = performance.now();
  let fpsFrames = 0;
  let fpsTime = 0;
  let settle = SETTLE_TIME;
  let fps = 60;

  manager.on(() => {
    settle = SETTLE_TIME; // loading, switching and settling all disturb frame timing
  });

  document.addEventListener('visibilitychange', () => {
    last = performance.now();
    settle = SETTLE_TIME;
  });

  function frame(now) {
    requestAnimationFrame(frame);
    const rawDt = (now - last) / 1000;
    last = now;
    const dt = Math.min(Math.max(rawDt, 0), 1 / 15); // clamp hitches so sims stay stable

    audio.update(dt);
    perf.update(dt);
    manager.update(dt, audio);
    resetPointerDeltas();
    manager.render();
    ui.update(now);
    debug.update(now);

    // Adaptive quality: measure FPS over short windows, ignoring transitions.
    if (settle > 0 || manager.busy) {
      settle -= rawDt;
      fpsFrames = 0;
      fpsTime = 0;
    } else {
      fpsFrames++;
      fpsTime += rawDt;
      if (fpsTime >= FPS_WINDOW) {
        fps = fpsFrames / fpsTime;
        fpsFrames = 0;
        fpsTime = 0;
        if (fps < FPS_FLOOR && manager.degradeQuality()) {
          settle = SETTLE_TIME;
          if (import.meta.env.DEV) console.info(`[resonance] scene ${manager.index + 1}: ${fps.toFixed(1)} fps -> quality level ${manager.qualityLevel}`);
        }
      }
    }
  }

  resize();
  manager.switchTo(0);
  requestAnimationFrame(frame);

  // dev builds, or any build opened with ?debug, expose internals for tuning and tests
  if (import.meta.env.DEV || new URLSearchParams(location.search).has('debug')) {
    window.__resonance = {
      manager,
      audio,
      perf,
      renderer,
      get fps() {
        return fps;
      },
    };
  }
}

boot();
