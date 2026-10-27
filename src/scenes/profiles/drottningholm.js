/**
 * Scene 1 profile: Johan Helmich Roman, Drottningholmsmusiken
 * (Allegro con spirito / Andante; baroque orchestra, ~7:14).
 *
 * Stately, terraced dynamics (a narrow ~20 dB range: forte and piano blocks
 * rather than long crescendos), keys moving between D major, B minor,
 * F# minor and A major, quiet passages around 2:23, 2:44-2:55 and 5:05-5:36,
 * swells around 0:37, 2:20, 4:05 and 5:45, and a long rising finale
 * (~6:38-7:07). How it is poured:
 *   - the simulation clock follows the score's anticipating drive like a tide:
 *     it starts to rise ahead of each forte block and ebbs slowly after it
 *   - sections set the state: calm drift in hush passages (few pours, little
 *     swirl, small blooms), full pours and swirl in swells and climaxes
 *   - every onset in the score blooms a note (the scene's jellyfish), coloured
 *     and placed by the note's own pitch height
 *   - a key change throws a colour burst in the new key's colour (D azure,
 *     F# violet-blue, A gold, B purple, E white) and turns the paint's hue
 *   - the final rising climax opens a big, expansive pour from below
 *
 * On top of that runs the JOURNEY: one slow value, 0 = dawn (pale, airy,
 * high-key) to 1 = deep night, read from hand-set keyframes at the playhead.
 * It blends the PALETTES (pitch ramp, ground, note lightness window, family
 * weights, exposure, lacing ...), sets the fluid's FEEL (thin and fast early,
 * heavy and swirling late), turns the dominant FLOW from a diagonal drift into
 * slow spirals, sweeps WASHes of the new palette across the canvas, and
 * slowly zooms in (VIEW). Climaxes lift it back toward the light for a moment;
 * deep in the night a climax flares blue-white instead (FLARE). Each section
 * also gets its own seeded choreography for the pours (CHOREO).
 *
 * Every constant is here; the ones in TUNE are live sliders (T, together
 * with the scene's own bloom sliders).
 */
export const PROFILE = {
  piece: 'drottningholm',

  // ------------------------------------------------------------ the journey
  // [time s, journey] keyframes, interpolated with a monotone cubic (never
  // overshoots, never turns back between two keyframes)
  JOURNEY: {
    KEYS: [
      [0, 0.0], // pale dawn: white, pale aqua, soft sky blue, mint and cream hints
      [90, 0.15], // bright day: light blues, turquoise, white lacing
      [140, 0.25], // first big climax (~2:17): the most luminous moment (with the lift)
      [210, 0.45], // ocean blues deepen: teal and cobalt
      [270, 0.6], // dusk: royal blue, indigo, first violet
      [310, 0.7], // the quiet passage 5:05-5:36: deep navy, calm
      [347, 0.75], // second climax: a blue-white flare against the dark (FLARE)
      [390, 0.9], // night: near-black navy, deep purple, small cyan / white accents
      [434.5, 1.0], // final fade: deep midnight, the last glow
    ],
    CLIMAX_LIFT: 0.15, // the climax envelope lifts the journey back toward the light by up to this
    LIFT_RISE: 1.5, // s
    LIFT_FALL: 5,
    SMOOTHING: 1.5, // s (snaps on a seek)
    IDLE: 0.4, // nothing played yet: about the scene's original look
    DRIFT_SECONDS: 434.5, // live input / unknown file: the same arc, paced by elapsed music time, then back
    FORCE: -0.01, // >= 0 pins the journey there (T slider, for tuning a palette); < 0 follows the music
  },

  // palette stops along the journey, blended between the two nearest:
  //   ramp      pitch height -> paint colour (sRGB), the scene's COLOUR.RAMP for this stop
  //   ground    [deep, light] colour of the bare canvas (mottled between the two)
  //   L         lightness window note colours are squeezed into (low notes -> lo, high -> hi)
  //   chroma    × note colour saturation
  //   families  × weights of the note colour families [blue, purple, yellow, white]
  //   exposure  × the scene's exposure (high-key early, low-key late)
  //   lace      0 = dark ultramarine lacing veins, 1 = white lacing
  //   vignette  corner darkening
  //   gold      × gold accents
  //   glow      × note glows
  PALETTES: [
    {
      at: 0,
      name: 'dawn',
      ramp: [[0, '#80b4de'], [0.3, '#a6d4ee'], [0.5, '#c4ecf2'], [0.7, '#e2f6ee'], [0.85, '#f5faff'], [1, '#fff5de']],
      ground: ['#b9d9e6', '#eef9fb'],
      L: [0.76, 0.98], chroma: 0.55, families: [1, 0.35, 0.6, 1.8],
      exposure: 1.04, lace: 1, vignette: 0.1, gold: 0.5, glow: 0.5,
    },
    {
      at: 0.2,
      name: 'day',
      ramp: [[0, '#3f86c8'], [0.3, '#5cb0e6'], [0.5, '#5fd0ee'], [0.7, '#a8e4f6'], [0.85, '#e4f6ff'], [1, '#fffaf0']],
      ground: ['#86c0e0', '#d6effa'],
      L: [0.6, 0.98], chroma: 0.9, families: [1.3, 0.5, 0.8, 1.1],
      exposure: 1.06, lace: 0.8, vignette: 0.14, gold: 1, glow: 0.8,
    },
    {
      at: 0.45,
      name: 'ocean',
      ramp: [[0, '#10216a'], [0.25, '#123c9e'], [0.45, '#1468c8'], [0.6, '#18a2e0'], [0.8, '#7cc8f2'], [1, '#dcefff']],
      ground: ['#05214c', '#0d4a80'],
      L: [0.4, 0.9], chroma: 1, families: [1.5, 0.7, 0.5, 0.6],
      exposure: 1, lace: 0.15, vignette: 0.32, gold: 1, glow: 1,
    },
    {
      at: 0.65,
      name: 'dusk',
      ramp: [[0, '#140c3e'], [0.3, '#1c1f7a'], [0.5, '#2a3aa8'], [0.7, '#4a3fae'], [0.85, '#5a74d0'], [1, '#a8c4f4']],
      ground: ['#070b30', '#161a5c'],
      L: [0.28, 0.76], chroma: 1, families: [1, 1.6, 0.3, 0.4],
      exposure: 0.92, lace: 0, vignette: 0.42, gold: 0.7, glow: 1.1,
    },
    {
      at: 1,
      name: 'night',
      ramp: [[0, '#03040c'], [0.3, '#081030'], [0.55, '#0e1a4c'], [0.75, '#22195e'], [0.9, '#24489a'], [1, '#86d0fa']],
      ground: ['#010207', '#050a22'],
      L: [0.14, 0.5], chroma: 0.85, families: [1.4, 0.9, 0.1, 0.35],
      exposure: 0.86, lace: 0, vignette: 0.5, gold: 0.35, glow: 1.2,
    },
  ],
  // share of notes that ignore the lightness window (bright accents), by journey [dawn, night]
  // they are cyan / ice white whatever their family
  ACCENT: { CHANCE: [0, 0.2], L: [0.66, 0.95], HUE: [218, 245], CHROMA: [0.04, 0.1] },

  // fluid character by journey, [dawn, night], linearly interpolated:
  // early thin, fast-spreading and airy; late thick, slow, heavy and swirling
  FEEL: {
    DYE_FADE: [1.3, 0.85], // × paint dissipation (thin paint turns over faster)
    DAMPING: [0.8, 1.35], // × velocity dissipation (viscous late)
    SPEED: [1.1, 0.82], // × simulation clock
    SWIRL: [0.7, 1.2], // × vorticity confinement (more makes fine wrinkles, not big vortices: FLOW adds those)
    RADIUS: [1.45, 0.85], // × pour splat radius (large soft splats early)
    FORCE: [1.1, 0.8], // × pour push
    BLOOM: [1.2, 0.9], // × note bloom size
    CELLS: [1.6, 0.6], // × cell openings
    LACE: [1.3, 0.75], // × lacing vein strength
    EXPOSURE_RANGE: [0.45, 1], // share of the quiet-dims exposure curve applied (a dawn canvas stays high-key)
  },

  // dominant flow: a gentle diagonal drift early, slow spirals late
  FLOW: {
    ANGLE: 35, // degrees (0 = right, 90 = up) at the start ...
    TURN: 0.55, // ... turning this many degrees per second of music (~240° over the piece)
    EVERY: 1.1, // simulated s between current pushes
    PUSH: 95, // diagonal current strength
    RADIUS: 0.03,
    SPIRAL: [0.25, 0.9], // journey range over which the spiral takes over from the diagonal
    SPIRAL_PUSH: 150,
    SPIRAL_RADIUS: 0.012,
  },

  // washes: large, slow sweeps of the current palette, so the canvas visibly
  // turns over (not only the new paint changes colour)
  WASH: { EVERY: [6, 10], RADIUS: [0.018, 0.032], PUSH: [60, 120], PAINT: [0.5, 0.9], DURATION: 3.5 },

  // deep in the journey a climax flares blue-white against the dark
  FLARE: { FROM: [0.45, 0.7], RATE: 2.5, PUSH: [180, 320], RADIUS: [0.002, 0.005], PAINT: 0.9, L: 0.93, HUE: 238, CHROMA: 0.07, GLOW: 0.7, GLOW_SIZE: 0.25 },

  // slow camera: zoom in as the journey goes deeper, with a faint drift
  VIEW: { ZOOM: [1, 1.1], DRIFT: 0.015, PERIOD: 80 },

  // per-section pour choreography, seeded by the section index (the same
  // section always dances the same way); never one of the last AVOID patterns
  CHOREO: { TYPES: ['orbit', 'streams', 'scatter', 'spiral', 'drift'], AVOID: 2, LIVE_EVERY: 30, SEED: 1714 },

  // after a seek the canvas is repainted in the new palette right away
  REPAINT: { MIN_CHANGE: 0.06, KEEP: 0.3, SPLATS: 16 },

  // section stage -> multipliers on the scene's motion and paint
  STAGES: {
    calm: { speed: 0.55, pours: 0.3, swirl: 0.5, paint: 0.7, size: 0.75, exposure: 0.8 },
    building: { speed: 1.0, pours: 1.0, swirl: 1.0, paint: 1.0, size: 1.0, exposure: 1.0 },
    climax: { speed: 1.25, pours: 1.6, swirl: 1.35, paint: 1.15, size: 1.2, exposure: 1.06 },
    resolving: { speed: 0.8, pours: 0.6, swirl: 0.75, paint: 0.85, size: 0.9, exposure: 0.92 },
  },
  STAGE_BLEND: 3, // s: the tide turns slowly

  // drive -> simulation clock: a tide (rises ahead of a forte, ebbs slowly)
  DRIVE: {
    FROM_LEVEL: 0.8, // share of drive from the score's anticipating loudness
    FROM_DENSITY: 0.2, // ...and from note density (busy passages swirl more)
    RISE: 1.2, // s per smoothing stage (x2): fast enough to stay ahead of the music
    FALL: 4.0,
    CURVE: 1.25, // >1 keeps quiet passages truly slow
  },
  EXPOSURE: { QUIET: 0.62, LOUD: 1.0, CLIMAX: 1.06, ATTACK: 0.6, RELEASE: 2.5 },

  // onsets -> note blooms (the scene's own bloom; these only gate and scale it)
  NOTES: { MIN_DRIVE: 0.05, MAX_PER_SECOND: 7, PITCH_HOLD: 0.35 },

  // key -> colour burst and hue turn
  KEYS: {
    // tonic -> palette family, hue (Oklab degrees) and the ramp's hue turn
    D: { family: 0, hue: 245, turn: 0 }, // azure
    'F#': { family: 1, hue: 292, turn: 10 }, // violet-blue
    A: { family: 2, hue: 90, turn: -8, gold: 1.4 }, // gold
    B: { family: 1, hue: 305, turn: 14 }, // purple
    E: { family: 3, hue: 255, turn: -4 }, // white
    DEFAULT: { family: 0, hue: 235, turn: 0 },
  },
  BURST: {
    SPOKES: 6, // pours radiating from the burst centre
    PUSH: [260, 380],
    RADIUS: [0.006, 0.01],
    PAINT: 1.6,
    DURATION: 1.2,
    TURN_SMOOTHING: 4, // s for the hue to turn to the new key
    PALETTE_PULL: 0.45, // how far the key's colour is pulled toward the journey palette (keeps the arc coherent)
  },

  // the final rising climax: an expansive pour from below, growing with the music
  FINALE: { RATE: 2.2, PUSH: [380, 560], RADIUS: [0.008, 0.014], PAINT: 1.4, GOLD: 0.8 },
};

/** Live sliders (T): [path, label, min, max, step]. */
export const TUNE = [
  { group: 'Drottningholmsmusiken' },
  ['DRIVE.RISE', 'tide rise (s)', 0.2, 5, 0.1],
  ['DRIVE.FALL', 'tide fall (s)', 0.5, 10, 0.1],
  ['DRIVE.CURVE', 'quiet stays slow', 0.5, 2.5, 0.05],
  ['STAGES.calm.speed', 'hush speed ×', 0.1, 1.5, 0.05],
  ['STAGES.calm.pours', 'hush pours ×', 0, 1.5, 0.05],
  ['STAGES.climax.pours', 'climax pours ×', 0.5, 3, 0.05],
  ['EXPOSURE.QUIET', 'quiet exposure', 0.2, 1, 0.01],
  ['BURST.PAINT', 'key burst paint', 0, 4, 0.05],
  ['BURST.PUSH.1', 'key burst push', 100, 800, 10],
  ['FINALE.RATE', 'finale pours / s', 0, 6, 0.1],
  { group: 'journey (dawn → night)' },
  ['JOURNEY.FORCE', 'pin journey (<0 = follow)', -0.01, 1, 0.01, 'preview one point of the arc; below 0 the music drives it'],
  ['JOURNEY.CLIMAX_LIFT', 'climax lift', 0, 0.4, 0.01, 'how far a climax lifts the journey back toward the light'],
  ['WASH.PAINT.1', 'wash paint', 0, 2, 0.05],
  ['FLOW.PUSH', 'diagonal current', 0, 300, 5],
  ['FLOW.SPIRAL_PUSH', 'spiral current', 0, 400, 5],
  ['FLARE.RATE', 'night climax flare / s', 0, 12, 0.5],
  ['VIEW.ZOOM.1', 'night zoom', 1, 1.3, 0.01],
];
