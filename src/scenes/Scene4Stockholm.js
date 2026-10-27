import * as THREE from 'three';
import { SceneBase } from './SceneBase.js';
import { FullscreenPass, passMaterial } from '../gl/FullscreenPass.js';
import { createTunePanel, configParams, bindConfig } from '../tune.js';
import { createSepiaStreet } from './stockholm/sepiaStreet.js';

/**
 * Scene 4: "Stockholm i sepia", the user's own design (2026-10-27).
 *
 * A Stockholm street opening onto Riddarfjärden and Stadshuset as an old
 * sepia film: walkers, the No. 7 tram, a steamboat, gulls, the water's
 * reflection, flicker, jitter, scratches, dust and grain, in a 2:1 frame in
 * a dark projection room. The drawing is the user's Canvas 2D page, kept as
 * it was in stockholm/sepiaStreet.js; this scene draws it into an offscreen
 * canvas every frame and shows that as a texture (it replaced the earlier
 * procedural street shader).
 *
 * Audio (live analysis; the Mozart score is not mapped yet), all gentle so
 * the film keeps its calm: the music's loudness (perf.drive) -> how fast the
 * people walk (WALK: slow when soft, brisk when strong), and now and then, at
 * its strongest, one or two people cross the street toward Stadshuset from
 * left to right, at a pace even more sensitive to the music (CROSS); when it
 * is very strong a person with a dog crosses close to the viewer (DOG); energy -> how fast
 * the tram, boat, gulls and water move; bass -> stronger light flicker and a little more projector
 * jitter; treble -> more dust and scratches, heavier grain; beat -> a brief
 * brightening of the frame. With nothing playing it looks like the page.
 *
 * Every constant is in CONFIG; the important ones are live sliders (T).
 */
const CONFIG = {
  FILM_TICK: 20, // Hz: new flicker / jitter / dust / scratches (as on the page)
  SPEED: { QUIET: 0.8, FULL: 1.5, SMOOTHING: 1.5 }, // energy -> speed of the tram, boat, gulls, water (s)
  // the people walk faster when the music is strong and slower when it is soft
  // (user, 2026-10-27): perf.drive (the score's loudness with anticipation, or
  // the live level), x the page's walking pace; 1.0 with nothing playing
  // a big contrast (user): very slow when soft, brisk only when really strong
  WALK: { SOFT: 0.12, STRONG: 2.6, CURVE: 1.8, SMOOTHING: 0.8 },
  // when the music is at its strongest, people cross the street toward
  // Stadshuset from left to right (user, 2026-10-27), but only now and then
  // and only a few (the first version sent a steady stream): once perf.drive
  // reaches THRESHOLD a small group of GROUP people sets off, STAGGER s apart;
  // then nothing for COOLDOWN s. They are more sensitive to the music than
  // the other walkers: their own PACE reacts faster and harder, so they
  // nearly stop mid-street when it softens and hurry on when it swells.
  CROSS: {
    THRESHOLD: 0.9,
    GROUP: [1, 2],
    MAX: 2, // never more on the street at once
    STAGGER: 1.4, // s between the people of a group
    COOLDOWN: [20, 40], // s after a group set off before the next may
    PACE: { SOFT: 0.04, STRONG: 3.2, CURVE: 2.6, SMOOTHING: 0.35 },
  },
  // a person with a dog crosses the street close to the viewer, only when
  // the music is very strong (user, 2026-10-27); at the crossers' pace
  DOG: { THRESHOLD: 0.95, COOLDOWN: [40, 80], Z: [4.5, 5.2] },
  FLICKER: { BASS: 1.5 }, // x the page's flicker at full bass
  SHAKE: { BASS: 1.2, BEAT: 1.0 }, // extra projector jitter (frame units)
  DUST: { TREBLE: 1.5 }, // extra dust and scratches at full treble
  GRAIN: { TREBLE: 0.6 }, // extra grain at full treble
  FLASH: { BEAT: 0.07, DECAY: 7 }, // a beat brightens the frame briefly (alpha, 1/s)
  MAX_WIDTH: 2560, // px: the canvas is capped here (drawing is CPU work)
};

const TUNE = [
  { group: 'Stockholm' },
  ['WALK.SOFT', 'walking pace, soft music', 0.1, 1.5, 0.05],
  ['WALK.STRONG', 'walking pace, strong music', 0.5, 4, 0.05],
  ['WALK.SMOOTHING', 'walking pace change (s)', 0.1, 4, 0.05],
  ['CROSS.THRESHOLD', 'crossing: from loudness', 0, 1, 0.01],
  ['CROSS.MAX', 'crossing: at most at once', 1, 8, 1],
  ['CROSS.COOLDOWN.0', 'crossing: min wait between (s)', 0, 120, 1],
  ['CROSS.COOLDOWN.1', 'crossing: max wait between (s)', 0, 180, 1],
  ['CROSS.PACE.SOFT', 'crossing: pace when it softens', 0, 1, 0.01],
  ['CROSS.PACE.STRONG', 'crossing: pace when strong', 0.5, 6, 0.05],
  ['DOG.THRESHOLD', 'dog walker: from loudness', 0, 1, 0.01],
  ['DOG.COOLDOWN.0', 'dog walker: min wait between (s)', 0, 180, 1],
  ['SPEED.QUIET', 'tram/boat speed when quiet', 0.2, 1.5, 0.05],
  ['SPEED.FULL', 'tram/boat speed when loud', 0.5, 3, 0.05],
  ['FLICKER.BASS', 'bass flicker', 0, 4, 0.05],
  ['SHAKE.BASS', 'bass jitter', 0, 4, 0.05],
  ['DUST.TREBLE', 'treble dust', 0, 4, 0.05],
  ['GRAIN.TREBLE', 'treble grain', 0, 2, 0.05],
  ['FLASH.BEAT', 'beat flash', 0, 0.3, 0.005],
];

export default class Scene4Stockholm extends SceneBase {
  constructor() {
    super();
    this.renderScale = 1; // crisp lines and lettering
    this.toneMapped = false;
    this.speed = CONFIG.SPEED.QUIET;
    this.flash = 0;
    this.lastBeat = -1;
    this.tickClock = 0;
    this.mod = { flicker: 1, shake: 0, dust: 1, grain: 1, flash: 0 };
  }

  async init(renderer) {
    await super.init(renderer);
    this.canvas = document.createElement('canvas');
    this.street = createSepiaStreet(this.canvas);
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace; // canvas pixels are sRGB; the composite works in linear
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    this.pass = new FullscreenPass();
    this.mat = passMaterial({
      fragmentShader: /* glsl */ `
        uniform sampler2D tFrame;
        varying vec2 vUv;
        void main() { gl_FragColor = vec4(texture2D(tFrame, vUv).rgb, 1.0); }
      `,
      uniforms: { tFrame: { value: this.texture } },
    });
    await this.pass.compile(renderer, [this.mat]);
    this.tune = createTunePanel({ title: 'Stockholm i sepia', storageKey: 'resonance.tune.stockholm', params: configParams(CONFIG, TUNE), onChange: bindConfig(CONFIG) });
  }

  resize(width, height) {
    super.resize(width, height);
    const k = Math.min(1, CONFIG.MAX_WIDTH / width);
    this.street.build(width * k, height * k); // also resizes the canvas
    this.texture.dispose(); // a new size needs a new GPU texture
  }

  update(dt, audio) {
    const C = CONFIG;
    const presence = audio.presence;
    // speed of the street follows the energy, gently
    const target = C.SPEED.QUIET + (C.SPEED.FULL - C.SPEED.QUIET) * audio.energy * presence + (1 - presence) * (1 - C.SPEED.QUIET);
    this.speed += (target - this.speed) * (1 - Math.exp(-dt / C.SPEED.SMOOTHING));
    const sdt = dt * this.speed;
    this.time += sdt;
    // walking pace from the music's loudness
    const W = C.WALK;
    const loud = Math.pow(Math.min(1, Math.max(0, audio.perf?.drive ?? audio.energy)), W.CURVE);
    const walkTarget = presence * (W.SOFT + (W.STRONG - W.SOFT) * loud) + (1 - presence);
    this.walk = (this.walk ?? 1) + (walkTarget - (this.walk ?? 1)) * (1 - Math.exp(-dt / W.SMOOTHING));

    // now and then, at the music's strongest, a small group crosses the street (left -> right)
    const X = C.CROSS;
    const drive = Math.min(1, Math.max(0, audio.perf?.drive ?? audio.energy));
    this.crossWait = Math.max(0, (this.crossWait ?? 0) - dt);
    this.crossQueue ??= [];
    if (presence > 0.5 && drive >= X.THRESHOLD && this.crossWait <= 0 && !this.crossQueue.length && this.street.crossing() === 0) {
      const n = X.GROUP[0] + Math.floor(Math.random() * (X.GROUP[1] - X.GROUP[0] + 1));
      this.crossQueue = Array.from({ length: n }, (_, i) => i * X.STAGGER * (0.7 + 0.6 * Math.random()));
      this.crossWait = X.COOLDOWN[0] + Math.random() * Math.max(0, X.COOLDOWN[1] - X.COOLDOWN[0]);
    }
    for (let i = this.crossQueue.length - 1; i >= 0; i--) {
      this.crossQueue[i] -= dt;
      if (this.crossQueue[i] <= 0) {
        if (this.street.crossing() < X.MAX) this.street.addCrosser();
        this.crossQueue.splice(i, 1);
      }
    }
    // the dog walker: only when the music is very strong, then a long wait
    const D = C.DOG;
    this.dogWait = Math.max(0, (this.dogWait ?? 0) - dt);
    if (presence > 0.5 && drive >= D.THRESHOLD && this.dogWait <= 0 && !this.street.dogWalking()) {
      this.street.addDogWalker(D.Z[0] + Math.random() * (D.Z[1] - D.Z[0]));
      this.dogWait = D.COOLDOWN[0] + Math.random() * Math.max(0, D.COOLDOWN[1] - D.COOLDOWN[0]);
    }
    // their own, more sensitive pace: fast response, a steep curve
    const P = X.PACE;
    const paceTarget = presence * (P.SOFT + (P.STRONG - P.SOFT) * Math.pow(drive, P.CURVE)) + (1 - presence);
    this.crossPace = (this.crossPace ?? 1) + (paceTarget - (this.crossPace ?? 1)) * (1 - Math.exp(-dt / P.SMOOTHING));

    if (audio.beatId !== this.lastBeat) {
      this.lastBeat = audio.beatId;
      this.flash = Math.min(1, this.flash + presence);
    }
    this.flash *= Math.exp(-dt * C.FLASH.DECAY);

    const m = this.mod;
    m.flicker = 1 + C.FLICKER.BASS * audio.bass * presence;
    m.shake = (C.SHAKE.BASS * Math.max(0, audio.bass - 0.3) + C.SHAKE.BEAT * audio.beat) * presence;
    m.dust = 1 + C.DUST.TREBLE * audio.treble * presence;
    m.grain = 1 + C.GRAIN.TREBLE * audio.treble * presence;
    m.flash = C.FLASH.BEAT * this.flash;

    // film artefacts change on their own clock, like a projector
    this.tickClock += dt;
    if (this.tickClock >= 1 / C.FILM_TICK) {
      this.tickClock %= 1 / C.FILM_TICK;
      this.street.filmTick(m);
    }
    this.street.step(sdt, dt * this.walk, dt * this.crossPace);
    this.street.draw(sdt, dt, m);
    this.texture.needsUpdate = true;
  }

  render(target) {
    this.pass.render(this.renderer, this.mat, target);
  }

  /** Live values for the debug overlay (D). */
  get debug() {
    const m = this.mod;
    return {
      'walking ×': (this.walk ?? 1).toFixed(2),
      'tram/boat ×': this.speed.toFixed(2),
      'dog walker': this.street.dogWalking() ? 'crossing' : `next possible in ${(this.dogWait ?? 0).toFixed(0)} s`,
      crossing: `${this.street.crossing()} on the street · pace ×${(this.crossPace ?? 1).toFixed(2)} · next possible in ${(this.crossWait ?? 0).toFixed(0)} s`,
      film: `flicker ×${m.flicker.toFixed(2)} · jitter +${m.shake.toFixed(2)} · dust ×${m.dust.toFixed(2)} · grain ×${m.grain.toFixed(2)} · flash ${m.flash.toFixed(3)}`,
      canvas: `${this.canvas.width}×${this.canvas.height}`,
    };
  }

  dispose() {
    this.tune?.dispose();
    this.mat?.dispose();
    this.texture?.dispose();
    this.mat = null;
  }
}
