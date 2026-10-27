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
 *   - AURORA: two layers of aurora waves travel across the sky, one per
 *     voice of the music. Every low note or chord change (left hand) sends
 *     a broad, slow, green swell left -> right along the far curtains; every
 *     melody note a narrower, brighter, faster swell right -> left along the
 *     near ones, higher in the sky for higher notes, coloured by its pitch
 *     (teal / blue -> violet -> pink-white). The layers cross and their
 *     light adds. Amplitude follows the anticipating drive and the climax,
 *     so the waves are fullest and fastest at ~4:50, clearly smaller in the
 *     5:10 release, and slow, faint drifts when quiet. Rendered as glowing
 *     brush strokes (PAINT).
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

  // ------------------------------------------------------- the two-layer wave aurora
  // Two layers of travelling wave packets, one per voice of the music
  // (src/voices.js, audio.perf.voices): every note spawns a soft aurora swell
  // that runs along its layer's curtains across the sky, widening and fading,
  // then leaves off the far side. Curtains: 0 = nearest (spans the upper sky)
  // ... 3 = farthest (low, near the horizon). Positions and widths are in
  // screen widths. Packets are evaluated in one pass from a fixed uniform
  // array (MAX_PACKETS = 12 per layer in curtains.frag), so the cost never
  // grows with the note count.
  AURORA: {
    // amplitude 0..1 (overall size, brightness and speed of the waves):
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
    // quiet / loud scaling by the amplitude, [quiet, loud]
    SCALE: {
      SPEED: [0.55, 1.6], // × each layer's SPEED: slow drifting waves when quiet, fast at the climax
      SIZE: [0.75, 1.15], // × packet width and lift
      BRIGHT: [0.6, 1.0], // × packet brightness
      HEIGHT: [0.7, 1.05], // × curtain height (also the profile's HEIGHT)
      FOLD: [0.35, 1.0], // ripple amplitude of the curtains
    },
    GLOW: 0.18, // faint light along every curtain without packets (× amplitude): never empty
    BLEND: 'add', // how crossing layers combine: 'add' or 'screen' (softer where both are bright)
    CAP: 0.95, // per-pixel brightness cap (HDR, soft knee): the aurora never washes out the scene
    KEY_BIAS: { minor: 0.08, major: -0.08 }, // ramp shift: minor cooler (bluer), major greener
    KEY_SMOOTHING: 5, // s
    CREST: 0.18, // the curtain crown sits this far further along its layer's ramp

    // the low register (bass notes, low chord tones): broad, slow, heavy waves, left -> right
    LOW: {
      POOL: 10, // live packets (max 12)
      MIN_STRENGTH: 0.2, // weaker notes spawn nothing (note strength 0..1)
      MIN_GAP: 0.4, // s between two packets of this layer
      CURTAINS: [3, 2], // [low note, high note]: the curtain a packet rides (fractional = between two)
      DIRECTION: 1, // +1 = left -> right
      START: [-0.12, 0.25], // screen x where packets enter (random within)
      SPEED: 0.07, // screen widths per second (× SCALE.SPEED)
      PITCH_SPEED: 0, // higher notes travel this much faster (share)
      WIDTH: [0.16, 0.32], // packet width at birth -> at the end of its life (it widens as it travels)
      FRONT: 0.85, // leading edge width (× WIDTH): < 1 = a crisper front
      LIFE: 9, // s
      FADE_IN: 0.3, // s (raised cosine), peaking on the note
      DECAY: 4.5, // s, exponential fade after the peak
      FADE_OUT: 2.5, // s, the last part of the life fades to 0
      HEIGHT: 0.45, // base height of its curtains (× the scene's curtain height)
      LIFT: 0.2, // extra height at a packet's centre (× strength)
      BRIGHT: 0.85, // brightness at a packet's centre (× strength)
      BEND: 1.6, // how far a packet bows its curtain toward the viewer (map units): the swell
      CURVE: 3, // the curtain path bends into a long arc (map units at the screen edges)
      STRIATION: 1.1, // vertical ray frequency (gentle)
      SHEET: 1.9, // curtain thickness (wide)
      // colour: deep green -> teal, the packet's place set by the low note's height,
      // the dominant low note twisting it by up to +/- HUE_DEG
      RAMP: [
        [0.0, '#0a7a45'],
        [0.5, '#0fa36f'],
        [1.0, '#17bfa6'],
      ],
      HUE_RANGE: [0.1, 0.9],
      HUE_DEG: 15,
    },

    // the melody (the singing top line): narrower, brighter, faster waves, right -> left
    MELODY: {
      POOL: 12,
      MIN_STRENGTH: 0.05,
      MIN_GAP: 0.08,
      CURTAINS: [1, 0], // [low note, high note]: high notes ride the near curtain, higher in the sky
      DIRECTION: -1, // right -> left: crosses the low layer
      START: [0.8, 1.1],
      SPEED: 0.16,
      PITCH_SPEED: 0.35, // the highest notes travel 35 % faster than the lowest
      WIDTH: [0.08, 0.18],
      FRONT: 0.45, // a crisp leading edge
      LIFE: 5,
      FADE_IN: 0.15,
      DECAY: 2.2,
      FADE_OUT: 1.2,
      HEIGHT: 0.75, // [× the scene's curtain height]; the note's height adds HEIGHT_PITCH
      HEIGHT_PITCH: 0.35, // high notes reach higher into the sky
      LIFT: 0.4,
      BRIGHT: 2.2,
      BEND: 0.9,
      CURVE: 2,
      STRIATION: 4.2, // finer rays
      SHEET: 1.0,
      // colour: teal / blue -> violet -> a hint of pink-white at the top, by the note's height
      RAMP: [
        [0.0, '#16b9b0'],
        [0.3, '#2b8cff'],
        [0.62, '#7650ff'],
        [0.84, '#b14ae6'],
        [1.0, '#ffd8f0'],
      ],
      HUE_RANGE: [0.04, 0.97],
      HUE_DEG: 15, // the note's pitch class twists its hue by up to +/- this
    },

    // painterly rendering of the aurora (landscape.frag): short directional brush strokes
    // along long arcs that sweep around a centre above the sky, with impasto highlights
    PAINT: {
      STROKE: 0, // 0 = smooth, continuous light (user: no individual strokes), 1 = fully broken into strokes
      LENGTH: 0.075, // stroke length (screen heights)
      WIDTH: 0.012, // stroke width (screen heights)
      SMEAR: 0, // the light is dragged this far along the stroke (screen heights)
      IMPASTO: 0, // whitish highlight on the ridge of bright strokes
      SKY: 0, // the bare sky gets a faint stroke texture too
      CENTRE: [0.5, 1.5], // swirl centre the strokes curve around (screen x, height)
    },
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
  { group: 'wave aurora' },
  ['AURORA.AMP.FLOOR', 'quiet floor', 0, 0.4, 0.01],
  ['AURORA.AMP.CLIMAX', 'climax amplitude', 0, 1, 0.05],
  ['AURORA.GLOW', 'curtain glow', 0, 0.5, 0.01],
  ['AURORA.CAP', 'brightness cap', 0.4, 3, 0.05],
  ['AURORA.LOW.BRIGHT', 'low: brightness', 0, 4, 0.05],
  ['AURORA.LOW.SPEED', 'low: speed', 0.01, 0.3, 0.005],
  ['AURORA.LOW.MIN_GAP', 'low: min gap (s)', 0, 2, 0.05],
  ['AURORA.LOW.MIN_STRENGTH', 'low: min strength', 0, 1, 0.01],
  ['AURORA.MELODY.BRIGHT', 'melody: brightness', 0, 5, 0.05],
  ['AURORA.MELODY.SPEED', 'melody: speed', 0.02, 0.6, 0.01],
  ['AURORA.MELODY.LIFT', 'melody: lift', 0, 1.2, 0.05],
  ['AURORA.MELODY.HUE_DEG', 'melody: pitch-class twist (°)', 0, 30, 1],
  ['AURORA.PAINT.STROKE', 'paint: strokes', 0, 1, 0.05],
  ['AURORA.PAINT.IMPASTO', 'paint: impasto', 0, 1, 0.05],
  ['AURORA.PAINT.SMEAR', 'paint: smear', 0, 0.04, 0.001],
];
