/**
 * Scene 2 profile: Schubert / Liszt, "Ständchen" (solo piano, ~6:05),
 * performed by the aurora.
 *
 * A lyrical single melody over a rolling accompaniment, D minor turning to
 * D major, a near-silent opening, swells around 1:08 and 3:01, one big
 * climax (~4:32-4:56, peak ~4:52), a smaller swell (~5:13) and a long fade
 * from ~5:27. (This profile was first written for the Andante Festivo on
 * this scene; the user swapped the visuals of scenes 2 and 3.) How the
 * aurora performs it:
 *   - `build` (the score's anticipating drive, smoothed nobly) grows the
 *     curtains in height, width, coverage and brightness
 *   - quiet passages: low, narrow curtains with slow, wide ripples
 *   - sections set the state; the climax flares the curtains (taller,
 *     brighter, the green body warming toward gold, a pink-white crown)
 *   - accented piano attacks send a soft shimmer through the rays and a
 *     gentle colour surge, never on every note
 *   - AURORA: the curtains move like an audio wave. The live spectrum runs
 *     along them as an equaliser (low notes left, high right), every onset
 *     sends a pulse travelling along the ribbon its pitch belongs to (high
 *     notes the upper ribbon), and the melody sets the hue (low = deep green,
 *     middle = teal / blue, high = violet / purple, top = a touch of pink),
 *     each ribbon gliding toward the colour of the notes it receives; minor
 *     passages lean bluer, major ones greener. Amplitude follows the
 *     anticipating drive and the climax, so the aurora is fullest at ~4:50,
 *     clearly smaller in the 5:10 release, and a faint shimmer when quiet.
 *
 * Every constant is here; the ones in TUNE are live sliders (T).
 */
export const PROFILE = {
  piece: 'standchen',

  STAGES: {
    calm: { speed: 0.55, height: 0.75, width: 0.8, cover: 0.6, bright: 0.7, fold: 0.6 },
    building: { speed: 1.0, height: 1.0, width: 1.0, cover: 1.0, bright: 1.0, fold: 1.0 },
    climax: { speed: 1.15, height: 1.15, width: 1.1, cover: 1.15, bright: 1.15, fold: 1.1 },
    resolving: { speed: 0.75, height: 0.9, width: 0.9, cover: 0.85, bright: 0.85, fold: 0.85 },
  },
  STAGE_BLEND: 4, // s

  BUILD: { ATTACK: 1.2, RELEASE: 3.5, CURVE: 1.6 }, // drive -> build (curve > 1: mid levels stay modest)
  SPEED: { QUIET: 0.25, FULL: 1.3, SMOOTHING: 2.5 }, // scene clock: slow ripples when quiet

  // each = lerp(QUIET, FULL, build) * stage + CLIMAX * climax (shader multipliers, 1 = the original look)
  // (the shader's own energy and bass gain come on top, so the climax stays well under 2x: radiant, not washed out)
  HEIGHT: { QUIET: 0.55, FULL: 1.1, CLIMAX: 0.4 },
  WIDTH: { QUIET: 0.7, FULL: 1.05, CLIMAX: 0.15 },
  COVER: { QUIET: 0.15, FULL: 0.55, CLIMAX: 0.2 }, // share of the curtain length that is lit
  BRIGHT: { QUIET: 0.35, FULL: 0.85, CLIMAX: 0.25 },
  FOLD: { QUIET: 0.45, FULL: 1.0, CLIMAX: 0.25 }, // ripple amplitude
  WARM: { QUIET: 0.0, FULL: 0.0, CLIMAX: 0.0 }, // (gold warming: off, the AURORA colour ramp sets the colours)
  EXPOSURE: { QUIET: 0.8, FULL: 1.05, CLIMAX: 0.05 },

  // accented onsets -> a soft shimmer and colour surge (decaying slowly)
  ACCENT: { SHIMMER: 0.5, SURGE: 0.15, DECAY: 1.4, MIN_STRENGTH: 0.55 },

  // ------------------------------------------------------- the audio-wave aurora
  AURORA: {
    // ribbon k = the scene's curtain k: 0 is the nearest (spans the upper sky), 2 the farthest (low, near the horizon)
    RIBBONS: 3,
    // amplitude 0..1: wave size, brightness and speed.
    //   FLOOR + BUILD × build + CLIMAX × climax^CLIMAX_CURVE, × the section stage, smoothed
    // (build is the score's anticipating drive: it rises ahead of a crescendo)
    AMP: {
      FLOOR: 0.12, // never blank while music plays
      BUILD: 0.55,
      CLIMAX: 0.45,
      CLIMAX_CURVE: 1.5,
      STAGE: { calm: 0.35, building: 1, climax: 1, resolving: 0.65 },
      ATTACK: 0.8, // s
      RELEASE: 2.5,
    },
    // amplitude -> curtain shape and motion, [quiet, full]
    WAVE: {
      HEIGHT: [0.5, 1.0], // curtain height (× the profile's HEIGHT)
      FOLD: [0.35, 1.3], // ripple amplitude
      SPEED: [0.45, 1.25], // × the scene clock
      BRIGHT: [0.75, 1.2],
    },
    // live spectrum along the curtains: an equaliser, low notes left, high right
    SPECTRUM: {
      BANDS: 48, // must match SPEC_BANDS in curtains.frag
      HZ: [55, 4200], // log-spaced band edges
      GATE: 0.32, // analyser level (0..1) below which a band counts as silent
      CURVE: 1.5,
      ATTACK: 0.05, // s: fast attack ...
      RELEASE: 0.6, // ... slow release
      HEIGHT: 0.45, // extra curtain height at a full band (× amplitude)
      BRIGHT: 0.9, // extra brightness at a full band (× amplitude)
    },
    // note onsets -> pulses travelling along a ribbon
    PULSE: {
      MAX: 12, // must match MAX_PULSES in curtains.frag
      MAX_PER_SECOND: 8, // accompaniment notes beyond this are skipped
      LIFE: 1.8, // s
      ATTACK: 0.08, // s
      DECAY: 0.6, // s (exponential, after the attack)
      SPEED: [0.06, 0.22], // screen widths per second, [quiet, full]
      WIDTH: [0.035, 0.07], // screen widths, grows as it travels
      BRIGHT: 2.0, // brightness added at the pulse's centre (× strength)
      LIFT: 0.45, // curtain height added (× strength)
      ACCOMPANIMENT: 0.45, // strength of non-melody onsets (melody = 1)
      X: [0.1, 0.9], // pitch height -> starting position across the screen (low left, high right)
    },
    // colour: a ramp the melody's pitch height moves along (OKLab-ish, sRGB stops)
    RAMP: [
      [0.0, '#0d8a4c'], // deep green
      [0.28, '#17c49a'], // teal
      [0.48, '#2b8cff'], // blue
      [0.68, '#7650ff'], // violet
      [0.86, '#b14ae6'], // purple
      [1.0, '#ffd2ef'], // pink-white accent
    ],
    HUE: {
      RANGE: [0.04, 0.96], // melody height 0..1 -> ramp position
      MELODY_SMOOTHING: 1.2, // s, the global (base) hue following the melody
      ATTACK: 0.6, // s, a ribbon gliding to a note's hue
      RELEASE: 1.5, // s, ...and back to the base hue
      HOLD: 0.6, // s a note's hue is held as the ribbon's target
      PULL: 0.7, // how far a note pulls its ribbon from the base hue toward its own (1 = all the way)
      CHROMA_DEG: 15, // pitch class -> +/- hue twist
      KEY_BIAS: { minor: 0.08, major: -0.08 }, // minor cooler / bluer, major greener / warmer (ramp units)
      KEY_SMOOTHING: 5, // s
      SPREAD: [0.03, 0.12], // ribbons fan out along the ramp, [quiet, full]: multi-coloured at the climax
      CREST: 0.22, // the crown sits this far further up the ramp (toward violet / pink)
    },
    CAP: 0.95, // per-pixel brightness cap (HDR, soft knee): the aurora never washes out the scene
  },
};

/** Live sliders (T): [path, label, min, max, step]. */
export const TUNE = [
  { group: 'Ständchen' },
  ['BUILD.ATTACK', 'build attack (s)', 0.2, 5, 0.1],
  ['BUILD.RELEASE', 'build release (s)', 0.5, 10, 0.1],
  ['BUILD.CURVE', 'build curve', 0.5, 3, 0.05],
  ['SPEED.QUIET', 'quiet ripple speed', 0.05, 1, 0.01],
  ['HEIGHT.CLIMAX', 'climax height', 0, 1.5, 0.05],
  ['BRIGHT.CLIMAX', 'climax flare', 0, 2, 0.05],
  ['WARM.CLIMAX', 'climax warmth', 0, 1, 0.05],
  ['BRIGHT.QUIET', 'quiet brightness', 0, 1, 0.01],
  ['ACCENT.SHIMMER', 'accent shimmer', 0, 1.5, 0.05],
  { group: 'audio-wave aurora' },
  ['AURORA.AMP.FLOOR', 'quiet floor', 0, 0.4, 0.01],
  ['AURORA.AMP.CLIMAX', 'climax amplitude', 0, 1, 0.05],
  ['AURORA.SPECTRUM.HEIGHT', 'spectrum height', 0, 1.2, 0.05],
  ['AURORA.SPECTRUM.BRIGHT', 'spectrum brightness', 0, 2, 0.05],
  ['AURORA.SPECTRUM.GATE', 'spectrum gate', 0, 0.8, 0.01],
  ['AURORA.PULSE.BRIGHT', 'pulse brightness', 0, 4, 0.05],
  ['AURORA.PULSE.LIFT', 'pulse lift', 0, 1.2, 0.05],
  ['AURORA.PULSE.DECAY', 'pulse decay (s)', 0.1, 2, 0.05],
  ['AURORA.HUE.ATTACK', 'hue glide (s)', 0.1, 1.5, 0.05],
  ['AURORA.HUE.CHROMA_DEG', 'pitch-class hue twist (°)', 0, 30, 1],
  ['AURORA.CAP', 'brightness cap', 0.4, 3, 0.05],
];
