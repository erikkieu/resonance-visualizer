/**
 * Scene 3 profile: Jean Sibelius, "Andante Festivo" (string orchestra, ~4:05),
 * performed by the Starry Night painting.
 *
 * Noble and warm: long legato lines that keep building from the first bar
 * (no quiet opening: the strings start near full level), a first climax
 * around 1:34-2:03, a short release, and a radiant final climax (~3:44)
 * that holds to the end. A narrow dynamic range (~12 dB), so the painting
 * leans on the piece-normalised drive and the score's sections rather than
 * raw loudness. (This profile was first written for the Ständchen on this
 * scene; the user swapped the visuals of scenes 2 and 3.) How it is painted:
 *   - melody pitch height lifts the spiral centre and the moon and colours the
 *     light: high = pale yellow / white, low = deep blue / violet
 *   - every melody note blooms a star halo; the star is chosen by the note's
 *     height (high notes, high stars), never the same star twice in a row
 *   - the accompaniment's other notes throw small, soft ripples of sky-blue
 *     brush strokes along the wind
 *   - sections set the scene state (calm / building / climax / resolving):
 *     the paint slows in the release, flows as the lines build, and the
 *     whole sky blooms at both climaxes
 *   - minor passages cool the light toward violet; major ones warm it
 *
 * Every constant is here; the ones in TUNE are live sliders (T).
 */
export const PROFILE = {
  piece: 'andante-festivo',

  // Section stage -> scene state. Each is multiplied into the loudness-driven
  // value, and the scene blends between stages over STAGE_BLEND seconds,
  // starting LOOKAHEAD seconds before the section change.
  STAGES: {
    calm: { speed: 0.45, glow: 0.7, strokes: 0.74, bright: 0.9, spiral: 0.55, events: 0.6, exposure: 0.85 },
    building: { speed: 1.0, glow: 1.0, strokes: 0.84, bright: 1.0, spiral: 1.0, events: 1.0, exposure: 1.0 },
    climax: { speed: 1.35, glow: 1.45, strokes: 1.0, bright: 1.1, spiral: 1.4, events: 1.3, exposure: 1.06 },
    resolving: { speed: 0.75, glow: 0.85, strokes: 0.8, bright: 0.95, spiral: 0.8, events: 0.8, exposure: 0.94 },
  },
  ENDING: { speed: 0.5, glow: 0.8, exposure: 0.85 }, // extra calm in the final fade, so the paint settles to a stop
  STAGE_BLEND: 2.5, // s

  // drive (0..1, anticipating) -> flow speed, piecewise with a swell hysteresis
  SPEED: { FREEZE: 0.04, QUIET: 0.22, MID: 1.0, MAX: 2.4, SMOOTHING: 1.4, DRIVE_FREEZE: 0.08, DRIVE_QUIET: 0.28, DRIVE_MID: 0.55, SWELL_ENTER: 0.8, SWELL_EXIT: 0.62 },
  GLOW: { DIM: 0.22, BASE: 0.9, CLIMAX: 1.9, SMOOTHING: 0.8 },
  // the whole painting darkens in quiet passages, so loud ones feel big
  EXPOSURE: { QUIET: 0.5, LOUD: 1.0, CURVE: 0.8, CLIMAX: 1.1, ATTACK: 0.5, RELEASE: 2.0 },
  CLIMAX: { STROKE_BOOST: 1, BRIGHT: 1.12, SPEED: 1.15 },

  // melody pitch height
  MELODY: {
    LIFT: 0.07, // painting heights the spiral centre and moon rise between the lowest and highest note
    ATTACK: 0.25, // s, smoothing of the height when it rises...
    RELEASE: 0.9, // ...and when it falls
    MIN_CONF: 0.25, // below this confidence the height relaxes toward the middle
    BRIGHTEN: 0.12, // extra stroke brightness at the top of the range
  },
  // pitch height -> light colour (tints swirl highlights, halos and blooms)
  PALETTE: [
    [0.0, '#2a1d78'], // deep violet
    [0.3, '#2f55e0'], // cobalt
    [0.55, '#62b8ea'], // sky
    [0.8, '#fff0b8'], // pale yellow
    [1.0, '#fffaf0'], // white
  ],
  TINT: { BASE: 0.22, MELODY: 0.28 }, // tint amount, plus more while the melody is clear
  MODE: { minor: '#6a4fd0', major: '#ffd98a', AMOUNT: 0.18, SMOOTHING: 3 }, // key mode shifts the palette

  // onsets -> events
  EVENTS: {
    MELODY_RADIUS: [0.8, 1.6], // x the star radius, by note strength
    MELODY_PULSE: [0.45, 1.0], // halo pulse, by strength
    STAR_Y: [0.45, 0.97], // painting height range the melody height maps onto
    STAR_CHOICES: 3, // pick among the N stars nearest that height (variety)
    MOON_ABOVE: 0.85, // notes above this height may bloom the moon instead
    RIPPLE_RADIUS: [0.025, 0.055],
    RIPPLE_AMP: 0.35, // ripples are faint
    RIPPLE_COLOR: '#8fb8e8',
    RIPPLE_BAND: [0.52, 0.9], // painting heights the ripples appear in
    MIN_DRIVE: 0.04, // no events below this (true silence)
    QUIET_AMP: 0.35, // event strength at zero drive (full at drive 1)
    MAX_PER_SECOND: 9, // ripples beyond this rate are skipped
  },
};

/** Live sliders (T): [path, label, min, max, step]. */
export const TUNE = [
  { group: 'motion' },
  ['SPEED.MAX', 'max flow speed', 1, 4, 0.05],
  ['SPEED.FREEZE', 'frozen speed (silence)', 0, 0.3, 0.01],
  ['SPEED.SMOOTHING', 'speed smoothing (s)', 0.2, 4, 0.05],
  ['STAGE_BLEND', 'section blend (s)', 0.5, 6, 0.1],
  { group: 'light' },
  ['GLOW.CLIMAX', 'climax glow', 1, 3, 0.05],
  ['GLOW.DIM', 'quiet glow', 0, 1, 0.01],
  ['EXPOSURE.QUIET', 'quiet exposure', 0.2, 1, 0.01],
  ['EXPOSURE.CLIMAX', 'climax exposure', 1, 1.4, 0.01],
  ['TINT.BASE', 'tint amount', 0, 0.8, 0.01],
  ['TINT.MELODY', 'melody tint', 0, 0.8, 0.01],
  ['MODE.AMOUNT', 'minor/major shift', 0, 0.5, 0.01],
  { group: 'melody' },
  ['MELODY.LIFT', 'swirl lift', 0, 0.2, 0.005],
  ['MELODY.BRIGHTEN', 'high-note brightness', 0, 0.4, 0.01],
  { group: 'events' },
  ['EVENTS.RIPPLE_AMP', 'ripple strength', 0, 1, 0.01],
  ['EVENTS.MELODY_PULSE.1', 'halo bloom', 0.2, 2, 0.05],
  ['EVENTS.MELODY_RADIUS.1', 'bloom size', 0.5, 3, 0.05],
];
