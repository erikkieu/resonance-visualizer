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
 * Breathing with the strings (the swirls never twitch):
 *   - the piece-normalised drive (with its 1.5 s look-ahead) and its momentum
 *     set the flow speed, the vortices' turn and the stroke drift: nearly
 *     still in the hush, about 3x at the main climax; fast attack, ~2.6 s release
 *   - the low strings (60-350 Hz) widen the great spiral and sway the cypress;
 *     the violins (1-5 kHz) brighten the halos, light fine highlights on the
 *     strokes and twinkle the stars gently
 *   - sustained melody notes swell a star's halo and hold it while the note
 *     sings; every phrase breath sends a wave of light from the moon across
 *     the stars
 *   - cool to gold: quiet passages are deep night blue with dim stars; the
 *     climaxes open into golden light, the main one (~3:44) fully, the first
 *     (~1:38) to about 60 % (CLIMAXES); keys bias the colour a little
 *   - section energy states (hush ... fade) set movement, the glow ceiling and
 *     warmth; the last bars settle to near stillness and calm blue
 *   - only the strongest bow attacks (top 15 %) throw gentle ripples
 *   - REACTIVITY widens every [quiet, loud] range ([ ] keys, slider in D)
 *
 * The painting paints itself (REVEAL): from a black canvas, stroke by stroke,
 * finished at the main climax (3:44). Coverage (0..1) is the integral of
 * (MIN_RATE + loudness^EXPONENT) over the piece, so quiet bars add a few
 * strokes and swells sweep many in; the strongest bow attacks add a bold
 * gesture. Each stroke has a rank in the painter's order (primer, sky,
 * swirls, hills and cypress, star halos ring by ring, the moon, the village
 * and its windows) and draws on when the coverage passes it.
 *
 * Every constant is here; the ones in TUNE are live sliders (T).
 */
export const PROFILE = {
  piece: 'andante-festivo',

  // Section stage -> stroke state. Each is multiplied into the loudness-driven
  // value, and the scene blends between stages over STAGE_BLEND seconds,
  // starting LOOKAHEAD seconds before the section change. (Movement, glow and
  // warmth follow the finer SECTIONS below.)
  STAGES: {
    calm: { strokes: 0.74, bright: 0.9, spiral: 0.55, events: 0.6, exposure: 0.85 },
    building: { strokes: 0.84, bright: 1.0, spiral: 1.0, events: 1.0, exposure: 1.0 },
    climax: { strokes: 1.0, bright: 1.1, spiral: 1.4, events: 1.3, exposure: 1.06 },
    resolving: { strokes: 0.8, bright: 0.95, spiral: 0.8, events: 0.8, exposure: 0.94 },
  },
  STAGE_BLEND: 2.5, // s

  // the whole painting darkens in quiet passages, so loud ones feel big
  EXPOSURE: { QUIET: 0.5, LOUD: 1.0, CURVE: 0.8, CLIMAX: 1.1, ATTACK: 0.5, RELEASE: 2.0 },
  CLIMAX: { STROKE_BOOST: 1, BRIGHT: 1.12 },

  // ---- breathing with the strings
  REACTIVITY: 1.5, // widens every [quiet, loud] range in log space ([ ] keys, D overlay slider)
  // drive -> intensity x (0..1): between these percentiles of the piece's level, soft knee, ^CURVE
  LEVEL: { QUIET: 0.3, LOUD: 0.97, KNEE: 0.1, CURVE: 1.3, LIVE: [0.25, 0.9] },
  // flow speed (stroke drift, vortex turn, smear): RANGE at x 0..1, x the section's MOVE,
  // x (1 + MOMENTUM x the coming crescendo) x (1 + CLIMAX x the weighted climax), soft
  // ceiling from LIMIT[0] toward LIMIT[1]; SPIRAL scales the vortices' strength with x
  SWIRL: { RANGE: [0.3, 1.45], MOMENTUM: 0.5, CLIMAX: 0.3, ATTACK: 0.5, RELEASE: 2.6, LIMIT: [2.4, 3.6], IDLE: 0.4, SPIRAL: [0.8, 1.3] },
  // star and moon glow: RANGE at x, x the section's GLOW, x (1 + CLIMAX x climax) x (1 + UPPER x violins),
  // soft ceiling LIMIT; IDLE with nothing playing. The moon is the main light: its core
  // MOON x glow (soft ceiling MOON_LIMIT) x (1 + MOON_SWELL x warmth), and it lights the
  // paint around it: MOON_LIGHT [strength x glow (more when warm), radius in painting heights]
  GLOW: { RANGE: [0.12, 0.75], CLIMAX: 0.8, UPPER: 0.45, LIMIT: [2.2, 3.2], ATTACK: 0.5, RELEASE: 2.5, IDLE: 0.6, MOON: 0.24, MOON_LIMIT: [0.9, 1.5], MOON_SWELL: 0.4, MOON_LIGHT: [0.12, 0.5] },
  // the low strings (60-350 Hz) and the violins (1-5 kHz), smoothed [attack, release] s
  LOWER: { SPIRAL: 0.22, SWAY: 0.024, SWAY_MIN: 0.003, MOON: 0.3, SMOOTH: [0.5, 1.6] },
  UPPER: { HIGHLIGHT: 0.35, TWINKLE: 0.35, TWINKLE_RATE: 1.6, SMOOTH: [0.3, 1.2] },
  // cool -> gold. Each climax section ramps in from LEAD s before it to its peak, holds
  // up to HOLD s (not past the section), then decays (DECAY s); CLIMAXES weights them in order
  CLIMAXES: [0.5, 1], // any further climax sections take the first weight (with the section and key terms the first peaks ~60 %)
  ARC: { LEAD: 18, HOLD: 25, DECAY: 9, LIVE: 1 },
  WARMTH: {
    LEVEL_FLOOR: 0.45, // the climax arc's share at x = 0 (full at x = 1)
    KEYS: { major: 0.03, minor: -0.12, TIME: 8 }, // s: key regions bias the colour slowly
    ATTACK: 1.5,
    RELEASE: 3.5,
    COOL: [0.78, 0.9, 1.14], // grade of the quiet painting: deep night blue
    COOL_AMOUNT: 0.55,
    COOL_HALO: '#bcd2ff', // halo colour when cool ...
    GOLD_HALO: '#ffc860', // ... and golden (whiter at the very top)
    GRADE: 0.75, // warm grade on the bright paint at full warmth
  },
  // per-section energy: MOVE (x flow speed), GLOW (x glow), WARMTH (added, x x)
  SECTIONS: {
    hush: { MOVE: 0.4, GLOW: 0.6, WARMTH: 0 },
    build: { MOVE: 0.85, GLOW: 0.9, WARMTH: 0.04 },
    swell: { MOVE: 1.0, GLOW: 1.0, WARMTH: 0.06 },
    climax: { MOVE: 1.15, GLOW: 1.15, WARMTH: 0.08 },
    release: { MOVE: 0.5, GLOW: 0.6, WARMTH: 0 },
    fade: { MOVE: 0.08, GLOW: 0.35, WARMTH: 0 },
  },
  SECTION_BLEND: 3, // s
  OPENING: 5, // s the piece opens from the hush state
  ENDING: { TIME: 10, RELEASE: 1, exposure: 0.85 }, // s before the music ends: blend into the fade state (glow and warmth release in RELEASE s, darker a little)
  // sustained melody notes swell a star's halo and hold it while the note sings
  HALO: { ATTACK: 0.45, HOLD: 5, DECAY: 1.6, MAX: 1.2 },
  // phrase breaths (dips in the level) send a wave of light from the moon across the stars
  PHRASE: { DIP: 0.18, WINDOW: 2.5, MIN_GAP: 6, SPEED: 0.55, WIDTH: 0.35, AMP: 0.45 },

  // ---- the painting paints itself: coverage(t) and the painter's order
  REVEAL: {
    COMPLETE_AT: null, // s the painting is finished; null = the main climax's peak from the analysis (3:44.2)
    MIN_RATE: 0.12, // painting rate in silence, against loudness^EXPONENT (0..1): never stalls once the music has begun (black until its first note)
    EXPONENT: 1.3,
    SMOOTH: 2, // s: the loudness rate is smoothed over this, so the painting never jumps
    GESTURE: { AMP: 0.5, WIDTH: 0.35, GAP: 2.5 }, // the strongest bow attacks (top RIPPLE_SHARE): a burst of rate (Gaussian, s), at most one per GAP s
    FALLBACK: 180, // s: without the analysis (mic, demo, other files) the live loudness paints it in about this long
    LIVE_LEVEL: 0.5, // typical live drive the FALLBACK is reckoned with
    // the painter's order, in coverage: when each part of the painting is painted
    STAGES: {
      PRIMER: [0, 0.02], // a faint dark-blue primer wash, under the first strokes
      SKY: [0, 0.3], // broad dark-blue sky strokes, in patches across the canvas: the first ones with the first note
      SWIRLS: [0.3, 0.55], // the pale strokes: the great spiral and its partner growing outward, the wind bands
      HILLS: [0.15, 0.5], // the lower part: far hills first, from ~0:30 (coverage 0.15 with this piece) to ~1:57
      CYPRESS: [0.48, 0.65], // from its base upward, like a flame
      STARS: [0.55, 0.8], // halos ring by ring (outer to inner), a few stars at a time, golden centres last
      MOON: [0.8, 0.92], // the moon, ring by ring, brightening
      VILLAGE: [0.15, 0.92], // the houses and the church: the lower part too, built up slowly from ~0:30
      WINDOWS: [0.95, 1], // the warm windows light up one by one, arriving with the climax
    },
    STAR_WINDOW: 0.3, // share of the STARS stage each star takes (they overlap: a few at a time)
    RINGS: 4, // halo rings per star (and per moon: MOON_RINGS)
    MOON_RINGS: 5,
    HALO_SIZE: 2.2, // star halo extent in star radii (moon: MOON_SIZE)
    MOON_SIZE: 2.4,
    PALE: 0.55, // sky brighter than this share of the sky is pale paint (swirls, wind bands, halos)
    PATCH: [0.16, 0.05], // painting heights: patch sizes the painter works across (coarse, fine)
    JITTER: 0.025, // per-stroke rank jitter (rings and windows get a quarter of it)
    GROW: [0.4, 1.2], // s a stroke takes to draw on (short ... long strokes)
    WET: [3, 0.45], // fresh paint: seconds its sheen takes to settle, extra brightness
    SOFT: 0.03, // coverage over which the underpainting settles in behind the strokes ...
    LAG: 0.02, // ... starting this much coverage after them
    PRIMER_COLOR: '#0f1a3a',
    SKY_GROUND: '#22397a', // the ground laid under the sky's later layers (swirls, halos, moon, cypress)
    LAND_GROUND: '#162229',
    BUILD: { GLOW: 0.2, WARMTH: 0.25, EXPOSURE: 0.8 }, // glow / warmth / exposure share at coverage 0 (full at 1)
    BLOOM: { RISE: 0.6, DECAY: 5, GLOW: 1.2, WARMTH: 0.35, EXPOSURE: 0.18 }, // golden light when the painting is finished
    FADE_TO_BLACK: false, // the last bars dissolve the painting back toward black (in reverse order)
  },

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
    MELODY_AMP: 0.45, // bloom strokes are soft (the halo swell carries the note)
    RIPPLE_RADIUS: [0.03, 0.06],
    RIPPLE_AMP: 0.3, // ripples are faint
    RIPPLE_COLOR: '#8fb8e8',
    RIPPLE_BAND: [0.52, 0.9], // painting heights the ripples appear in
    RIPPLE_SHARE: 0.15, // only the strongest bow attacks (this share of the piece's onsets) ripple
    RIPPLE_GAP: 0.8, // s between ripples at least
    RIPPLE_LIVE: 0.8, // live input: onset strength threshold
    FADE_IN: 0.35, // s: blooms and ripples fade in (never flash)
    MIN_DRIVE: 0.04, // no events below this (true silence)
    QUIET_AMP: 0.35, // event strength at zero drive (full at drive 1)
  },
};

/** Live sliders (T): [path, label, min, max, step]. */
export const TUNE = [
  { group: 'breathing (REACTIVITY: D overlay, [ ])' },
  ['SWIRL.RANGE.0', 'quiet flow speed', 0.05, 1, 0.01],
  ['SWIRL.RANGE.1', 'loud flow speed', 0.5, 3, 0.05],
  ['SWIRL.RELEASE', 'speed release (s)', 0.5, 6, 0.1],
  ['SWIRL.MOMENTUM', 'crescendo momentum', 0, 2, 0.05],
  ['SECTION_BLEND', 'section blend (s)', 0.5, 8, 0.1],
  ['LOWER.SPIRAL', 'low strings: spiral', 0, 0.6, 0.01],
  ['LOWER.SWAY', 'low strings: cypress', 0, 0.06, 0.001],
  ['UPPER.HIGHLIGHT', 'violins: highlights', 0, 1, 0.01],
  ['UPPER.TWINKLE', 'violins: twinkle', 0, 1, 0.01],
  { group: 'cool to gold' },
  ['CLIMAXES.0', 'first climax weight', 0, 1, 0.01],
  ['CLIMAXES.1', 'main climax weight', 0, 1, 0.01],
  ['WARMTH.COOL_AMOUNT', 'quiet blue', 0, 1, 0.01],
  ['WARMTH.GRADE', 'golden grade', 0, 1.5, 0.01],
  { group: 'light' },
  ['GLOW.RANGE.0', 'quiet glow', 0, 1, 0.01],
  ['GLOW.RANGE.1', 'loud glow', 0.3, 2, 0.01],
  ['GLOW.CLIMAX', 'climax glow', 0, 3, 0.05],
  ['HALO.HOLD', 'halo hold (s)', 0.5, 10, 0.1],
  ['PHRASE.AMP', 'phrase wave', 0, 1, 0.01],
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
  { group: 'painting itself (Shift+P replay, K finish)' },
  ['REVEAL.MIN_RATE', 'quiet painting rate', 0, 1, 0.01],
  ['REVEAL.EXPONENT', 'loudness exponent', 0.5, 3, 0.05],
  ['REVEAL.GESTURE.AMP', 'bold gestures', 0, 2, 0.05],
  ['REVEAL.GROW.0', 'draw-on short (s)', 0.1, 2, 0.05],
  ['REVEAL.GROW.1', 'draw-on long (s)', 0.2, 3, 0.05],
  ['REVEAL.WET.0', 'wet sheen (s)', 0.5, 8, 0.1],
  ['REVEAL.WET.1', 'wet brightness', 0, 1, 0.01],
  ['REVEAL.BLOOM.GLOW', 'finish bloom', 0, 3, 0.05],
];
