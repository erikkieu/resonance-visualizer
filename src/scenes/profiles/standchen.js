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

    // noise reduction: the aurora reads as smooth, silky light (N toggles the previous look)
    NOISE: {
      CLEAN: true, // false = the previous look (N in the scene)
      OCTAVES: 2, // ray noise octaves along the curtains (previous: 1 at full contrast)
      FREQUENCY: 0.55, // × each layer's STRIATION: longer, softer rays
      RAY_CONTRAST: 0.32, // 0 = plain sheet, 1 = deep ray gaps (previous: 0.55 + 0.25 × treble)
      EDGE: 1.35, // curtain edge softness (× sheet thickness)
      BLUR: 4.5, // px, 3×3 tent blur of the aurora layer before compositing (previous: 2.5 px, 5 taps)
      // every audio value feeding the aurora (bass, mid, treble, energy, surge) follows with
      // attack / release (s) through a soft dead-band; row hues follow HUE (s) instead of jumping per note
      SMOOTH: { ATTACK: 0.25, RELEASE: 0.9, DEADBAND: 0.04, HUE: 0.6, SURGE_ATTACK: 0.08 }, // (the accent surge decays smoothly by itself: it only needs a soft rise)
      SPAWN: { MIN_GAP: 0.1, STEP: 0.3 }, // s between packets per layer (at least); max strength change from one packet to the next
      SHIMMER: { AMP: 0.12, TIME: 1.5 }, // treble -> ray contrast: gentle, slow (s)
      GAIN: 1, // × aurora brightness in the clean look (its softer rays let ~10 % more light through; 0.88 matches the previous level)
      DITHER: 0.4, // final dither amplitude in 1/255 steps, fixed pattern (previous: 1, re-seeded every frame)
    },
  },

  // ------------------------------------------------------- the night progression
  // Across the piece the night moves from late dusk through deepest night (the
  // 4:50 climax) toward the first light of dawn. `night` 0..1 (0 = twilight,
  // 1 = deepest night) and `dawn` 0..1 (the pre-dawn glow) follow KEYS, a
  // hand-authored timeline sampled at the score playhead with monotone cubic
  // interpolation (no overshoot between keys). Without a score (mic, unknown
  // file, demo) they ping-pong over LOOP s instead. landscape.frag turns them
  // into the sky gradient, the horizon glow, the star field, the Milky Way, the
  // water and the aurora's strength. Colours are linear RGB.
  NIGHT: {
    // [time s, night, dawn]
    KEYS: [
      [0, 0.15, 0], // late twilight: deep blue sky, a warm band on the horizon, only bright stars
      [90, 0.4, 0], // twilight ending: the glow shrinks and cools to teal, more stars
      [180, 0.75, 0], // full night: black-blue sky, the full star field
      [290, 1.0, 0], // the climax: the darkest, clearest sky, faint stars and the Milky Way
      [320, 0.85, 0.1], // dawn begins to stir at the far horizon
      [365, 0.35, 0.7], // pre-dawn: a pale blue to rose glow, stars thinning from the horizon up
    ],
    LOOP: 360, // s, the fallback cycle (dusk -> night -> dawn -> back)
    SMOOTHING: 1.5, // s (seeks jump at once)
    SKY: {
      // [horizon, zenith] at night 0 and at night 1 (mixed by night)
      DUSK: [[0.02, 0.05, 0.11], [0.012, 0.03, 0.1]],
      NIGHT: [[0.002, 0.009, 0.012], [0.007, 0.004, 0.016]],
    },
    // the low glow at dusk: warm (night 0) cooling to teal-blue, gone by night FADE
    DUSK_GLOW: { WARM: [0.34, 0.12, 0.07], COOL: [0.03, 0.09, 0.12], COOL_AT: [0.15, 0.45], FADE: 0.62, HEIGHT: 0.09, STRENGTH: 1 },
    // the pre-dawn glow (× dawn): rose at the horizon, pale blue above it
    DAWN_GLOW: { LOW: [0.34, 0.14, 0.17], HIGH: [0.08, 0.14, 0.24], HEIGHT: 0.24, STRENGTH: 2.2 },
    STARS: {
      GAIN: [0.45, 1.25], // star brightness [night 0, night 1]
      SHOWN: [0.05, 1], // share of the star field visible (brightest first) [night 0, night 1]
      DAWN_REACH: 1.3, // at dawn 1 the stars are gone up to this share of the sky
    },
    MILKY_WAY: [0, 2.2], // band strength [night 0.55, night 1] (only a hint, at the darkest)
    // the aurora: pale and faint at dusk, vivid at night, giving way to dawn
    AURORA: { GAIN: [0.55, 1.0], SATURATION: [0.4, 1.0], DAWN_FADE: 0.45 },
    WATER: [0.006, 0.014, 0.024], // base water colour at night 0 (night 1: almost black)
    SNOW: 0.6, // how much the dusk / dawn glow lights the snow
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
  ['AURORA.NOISE.BLUR', 'noise: blur (px)', 0, 8, 0.25],
  ['AURORA.NOISE.RAY_CONTRAST', 'noise: ray contrast', 0, 1, 0.01],
  ['AURORA.NOISE.FREQUENCY', 'noise: ray frequency', 0.2, 1.5, 0.05],
  ['AURORA.NOISE.EDGE', 'noise: edge softness', 1, 2.5, 0.05],
  ['AURORA.NOISE.SMOOTH.RELEASE', 'noise: audio release (s)', 0.1, 3, 0.05],
  { group: 'night' },
  ['NIGHT.DUSK_GLOW.STRENGTH', 'dusk glow', 0, 3, 0.05],
  ['NIGHT.DAWN_GLOW.STRENGTH', 'dawn glow', 0, 3, 0.05],
  ['NIGHT.MILKY_WAY.1', 'Milky Way (deepest night)', 0, 5, 0.1],
  ['NIGHT.STARS.GAIN.1', 'stars (deepest night)', 0, 3, 0.05],
  ['NIGHT.AURORA.DAWN_FADE', 'aurora fade at dawn', 0, 1, 0.05],
];
