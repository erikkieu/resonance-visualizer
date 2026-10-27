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
    CAP: 0.75, // per-pixel brightness cap (HDR, soft knee): the aurora never washes out the scene
    KEY_BIAS: { minor: 0.08, major: -0.08 }, // ramp shift: minor cooler (bluer), major greener
    KEY_SMOOTHING: 5, // s
    CREST: 0.06, // the curtain crown sits this far further along its layer's ramp

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
      // colour: deep green -> green, the packet's place set by the low note's height,
      // the dominant low note twisting it by up to +/- HUE_DEG
      RAMP: [
        [0.0, '#2f9a58'],
        [0.5, '#40b86a'],
        [1.0, '#58c888'],
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
      // colour (reference restyle 2): deep green -> natural green -> cyan-green, then teal and violet
      // only at the top; LOOK.RAYS.HUE_SPREAD keeps quiet notes near the green centre and lets the
      // climax open up the range
      RAMP: [
        [0.0, '#3aa860'],
        [0.3, '#56c864'],
        [0.5, '#62c890'],
        [0.7, '#4cb4ae'],
        [0.86, '#7c78cc'],
        [1.0, '#a888d4'],
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

  // ------------------------------------------------------- alive: a strong reaction to the music, more movement
  // (Scene2Aurora._updateAlive). Loudness becomes an intensity x 0..1; every [quiet, loud] RANGE
  // maps it to a multiplier. RANGEs are given at REACTIVITY 1: REACTIVITY widens each around its
  // geometric middle m (m × (v / m)^REACTIVITY: 1.5 turns a 6× range into 15×) and scales the kicks.
  ALIVE: {
    REACTIVITY: 1.5, // live: slider in the debug overlay (D), keys [ and ] (0.5 .. 3)
    // x: the score's anticipating drive (it rises up to 1.5 s before a crescendo lands), normalised to
    // this piece (QUIET / LOUD = percentiles of its level: the quieter half of the piece sits near 0),
    // a soft knee at the bottom, then ^CURVE so loud parts blaze and quiet ones calm right down;
    // fast attack, slow release (s), a small dead-band. LIVE: [quiet, loud] drive without a score.
    LEVEL: { QUIET: 0.5, LOUD: 0.97, KNEE: 0.12, CURVE: 1.6, ATTACK: 0.1, RELEASE: 0.9, DEADBAND: 0.01, LIVE: [0.3, 0.9] },
    RANGE: {
      BRIGHT: [0.3, 0.5], // × the aurora's light (quiet stays visible: calm, never empty)
      HEIGHT: [0.78, 1.1], // × ray length (the ribbons' height)
      WIDTH: [0.85, 1.15], // × the curtains' spread across the sky
      SATURATION: [0.9, 1.06], // × the palette's saturation
      HUE: [0.55, 1.1], // × the melody's hue range around the palette's centre
      MOVE: [0.6, 1.4], // × sway, billow, loop and fold amplitudes
      WAVE: [0.65, 1.45], // × the travelling waves' speed, on top of the clock
    },
    // The clock (every motion: curtains, rays, waves, sky, stars, mist): time += dt × speed, with
    // speed = RANGE at xs (x through ATTACK / RELEASE) × the section's MOVE × (1 + MOMENTUM × the
    // rise of xs per s, smoothed over MOMENTUM_TIME), above LIMIT[0] and easing softly toward LIMIT[1]. With a score it is computed
    // for the whole piece and integrated in advance, so the clocks follow the playhead (a seek lands
    // on the same sky); live it is integrated frame by frame. IDLE: the speed while paused.
    SPEED: { RANGE: [0.62, 1.9], MOMENTUM: 1.2, MOMENTUM_TIME: 2, ATTACK: 0.8, RELEASE: 2.5, LIMIT: [0.3, 3.4], IDLE: 0.35 },
    // every melody note: a quick brightness kick (fast attack, soft decay; s) peaking on the note,
    // and a bright pulse at the head of its wave as it sets off along the ribbon
    KICK: { GAIN: 0.22, ATTACK: 0.045, DECAY: 0.6, MIN_STRENGTH: 0.08, MIN_GAP: 0.09, MAX: 0.8, PULSE: 0.6, PULSE_TIME: 0.35 },
    // every strong low / chord note: the big lower ribbons swell (brighter, longer rays) and rise
    SWELL: { GAIN: 0.5, GROW: 0.2, RISE: 0.04, ATTACK: 0.12, DECAY: 1.3, MIN_STRENGTH: 0.3, MIN_GAP: 0.25 },
    // accents (the strongest SHARE of the piece's onsets): a global glow lift and a ripple on the water
    ACCENT: { SHARE: 0.2, GLOW: 0.4, ATTACK: 0.06, DECAY: 1.0, MIN_GAP: 0.3, LIVE_STRENGTH: 0.55 },
    // the melody's pitch shifts the ribbons' hue (ramp units at the extremes; the low ribbons half), glide (s)
    HUE_FOLLOW: { AMOUNT: 0.2, TIME: 0.35 },
    // each section's energy state (by its role in the analysis), cross-faded over BLEND s and into the
    // next section ahead of the change: movement, the most ribbons shown, a brightness ceiling, colour range
    SECTIONS: {
      hush: { MOVE: 0.55, RIBBONS: 3, BRIGHT: 0.6, COLOUR: 0.6 },
      release: { MOVE: 0.75, RIBBONS: 3.5, BRIGHT: 0.8, COLOUR: 0.8 },
      build: { MOVE: 1.0, RIBBONS: 5, BRIGHT: 1.0, COLOUR: 0.95 },
      swell: { MOVE: 1.1, RIBBONS: 5, BRIGHT: 1.1, COLOUR: 1.0 },
      climax: { MOVE: 1.35, RIBBONS: 6, BRIGHT: 1.25, COLOUR: 1.2 },
      fade: { MOVE: 0.6, RIBBONS: 3, BRIGHT: 0.65, COLOUR: 0.7 },
    },
    SECTION_BLEND: 3, // s
    // movement shapes (amplitudes × RANGE.MOVE; rates per clock second)
    MOTION: {
      SWAY: 0.09, // radians: each ribbon sways around the vanishing point
      SWAY_RATE: 0.07,
      ROTATE: 0.07, // radians: the whole curtain system turns slowly to and fro around the vanishing point
      ROTATE_RATE: 0.013,
      BILLOW: 0.8, // × each ribbon's billow (its folds)
      CURL: 1.2, // × the loop's sway (it forms and unravels; at most ± CURL_MAX of its twist)
      CURL_MAX: 0.45,
      CURL_RATE: 0.035,
      FOLD: 1.2, // × the curtains' ripples
      DRIFT: 2.5, // × each ribbon's SHIFT: the ribbons travel along the sky and cross
      DRIFT_PERIOD: 70, // clock s, there and back
      FAN: [0.0, 0.08], // the rays fan open with x (share of the view angle) ...
      KICK_FAN: 0.05, // ... and with each kick
    },
    STARS: { ROTATION: 0.0016, POLE: [0.62, 1.75] }, // radians per sky-clock second, around this point (screen x, height)
  },

  // ------------------------------------------------------- mist and low clouds along the horizon (landscape.frag)
  // Banks of mist hugging the horizon and the valleys, in 4 depth layers, drifting left -> right at
  // their own speeds (parallax: the nearer, the faster) on the sky clock, so they rush at the climax
  // and settle in the quiet. Their shapes roll, stretch, merge and dissolve: low-frequency simplex fbm
  // advected through a slowly changing domain warp (no popping, no boiling). The aurora above lights
  // their upper parts in its own colours, brightest under a ribbon; their feet stay dark teal.
  MIST: {
    ON: true, // M
    // BASE / TOP: the bank's foot and its billowing top (screen heights above the water line; negative =
    // over the water), OPACITY, SPEED (screen heights per sky-clock second), SCALE (noise per screen
    // height across), STRETCH (wider than tall)
    LAYERS: [
      { NAME: 'far', BASE: 0.025, TOP: 0.11, OPACITY: 0.7, SPEED: 0.008, SCALE: 2.0, STRETCH: 3.5 }, // behind every range
      { NAME: 'valleys', BASE: 0.004, TOP: 0.075, OPACITY: 0.75, SPEED: 0.014, SCALE: 2.6, STRETCH: 4 }, // in front of the far hills, behind the main range
      { NAME: 'near', BASE: -0.004, TOP: 0.05, OPACITY: 0.65, SPEED: 0.022, SCALE: 3.2, STRETCH: 4.5 }, // over the foot of the mountains
      { NAME: 'water', BASE: -0.035, TOP: 0.012, OPACITY: 0.5, SPEED: 0.034, SCALE: 4.2, STRETCH: 6 }, // a thin sheet low over the water
    ],
    COVER: 0.05, // density threshold (higher = thinner, more broken banks)
    SOFT: 0.4,
    OCTAVES: 3, // (2 at lower quality levels)
    ROLL: 0.05, // how fast the shapes evolve (warp per sky-clock second) ...
    WARP: 0.5, // ... and how far they roll and stretch; + MID × mid energy
    BASE_COLOR: '#1f3537', // dark teal, as seen
    STARLIGHT: '#0e1a20', // faint cool light from the sky on every bank
    TINT: 0.5, // the aurora's average light colours the upper parts ...
    OVERHEAD: 0.3, // ... and the ribbon directly above makes them glow
    // glow × (1 + BASS × bass + AURORA × the aurora's brightness + CLIMAX × climax + ACCENT × accent glow); MID: billow
    MUSIC: { BASS: 0.35, AURORA: 0.1, CLIMAX: 0.15, ACCENT: 0.35, MID: 0.3 },
    REFLECT: 0.75, // the mist in the water: soft glowing smears
  },

  // ------------------------------------------------------- the look (reference restyle 2)
  // public/textures/aurora-reference-2.jpg (local, not committed): a long-exposure
  // photograph looking up into a big green aurora overhead, above a calm fjord.
  // Sky and aurora fill the top two thirds of the frame, a low band of snowy
  // mountains sits under them, dark green water fills the bottom. Colours are
  // sRGB hex *as seen on screen*: the scene inverts the tone curve (ACES at
  // exposure 1) so a plain hex here comes out close to that hex in the frame
  // (additive terms only roughly). `npm run verify -- standchen --match`
  // measures the frame region by region against REFERENCE.
  LOOK: {
    // The curtains in perspective, seen from below: every ray runs along a straight line
    // toward a vanishing point near the top of the frame, so the sky is laid out around it
    // (angle = the place along a curtain, distance = the height on it).
    CURTAINS: {
      VP: [0.62, 1.12], // the vanishing point (screen x 0..1, height 0..1; just above the top edge, centre-right)
      SPREAD: 0.55, // the packets' 0..1 screen range = 0.5 + SPREAD × sin(angle around the VP)
      BEND: 0.014, // screen heights per map unit of the curtains' meander, folds and the packets' bow (curtains.frag)
      // the big loop in the upper left: the sky is twisted around this point (screen x, height); the
      // twist swells and relaxes slowly, so the loop forms and unravels
      CURL: { X: 0.3, Y: 0.8, TWIST: 2.3, RADIUS: 0.24, SWAY: 0.45, RATE: 0.017 }, // twist (radians), radius (screen heights), sway (share), Hz
      BILLOW_FREQUENCY: 2.2, // the ribbons' domain-warped folds (per screen height; amplitude and rate per ribbon)
      EDGE_ON: 0.3, // brighter where a fold is seen edge-on
      CONVERGE: 1.2, // extra glow where the rays bunch up toward the VP (× at the VP, gone by 0.75 screen heights)
      LEFT_FADE: 0.92, // the aurora fades toward the far left, below the loop (darkest there)
      LOW_GAIN: 2.6, // × the low layer's light: the far curtains glow just above the mountains
      GAIN: 2.4, // × curtain light (× PALETTE.GAIN)
      FAN: 0.22, // at the climax the ribbons fan wide (share of the view angle they gain)
      // band -> height: the low ribbons grow with the bass, the melody ribbons with mid / treble
      BAND_HEIGHT: { LOW: 0.35, MELODY: 0.3 },
    },
    // The ribbons (up to 6 in aurora.frag): each rides one row of the curtain lookup table (its
    // waves, light and colour: rows 0-1 = the melody layer, high in the sky; 2-3 = the low
    // chords, down toward the mountains) with its own lower edge (distance from the VP), tilt,
    // level (FLAT: 0 = an arc overhead, 1 = level, far), ray LENGTH, soft lower EDGE_SOFT,
    // brightness, colour offset on its ramp (HUE), travel along the sky (SHIFT: peak speed, screen
    // widths per clock s, × ALIVE.MOTION.DRIFT, there and back; the thin foreground ribbons slide past the others), billow (amplitude, rate) and the
    // aurora amplitude from which it shows (SHOW): 3 when quiet, all 6 when loud.
    RIBBONS: [
      { NAME: 'main', ROW: 2, EDGE: 0.7, TILT: 0.04, FLAT: 0.8, LENGTH: 0.45, EDGE_SOFT: 0.06, BRIGHT: 1.0, HUE: -0.18, SHIFT: 0.004, BILLOW: 0.11, RATE: 0.012, SHOW: 0 },
      { NAME: 'overhead', ROW: 0, EDGE: 0.46, TILT: 0.1, FLAT: 0.15, LENGTH: 0.5, EDGE_SOFT: 0.06, BRIGHT: 1.0, HUE: -0.12, SHIFT: -0.006, BILLOW: 0.1, RATE: 0.01, SHOW: 0 },
      { NAME: 'violet', ROW: 1, EDGE: 0.6, TILT: -0.06, FLAT: 0.45, LENGTH: 0.4, EDGE_SOFT: 0.06, BRIGHT: 1.15, HUE: 0.42, SHIFT: 0.008, BILLOW: 0.13, RATE: -0.014, SHOW: 0 },
      { NAME: 'far blue', ROW: 3, EDGE: 0.83, TILT: 0.02, FLAT: 1.0, LENGTH: 0.26, EDGE_SOFT: 0.07, BRIGHT: 1.0, HUE: 0.45, SHIFT: -0.003, BILLOW: 0.08, RATE: 0.009, SHOW: 0.25 },
      { NAME: 'thin cyan', ROW: 0, EDGE: 0.36, TILT: 0.05, FLAT: 0.1, LENGTH: 0.16, EDGE_SOFT: 0.035, BRIGHT: 0.8, HUE: 0.02, SHIFT: 0.018, BILLOW: 0.16, RATE: 0.03, SHOW: 0.35 },
      { NAME: 'thin magenta', ROW: 1, EDGE: 0.54, TILT: -0.1, FLAT: 0.3, LENGTH: 0.14, EDGE_SOFT: 0.035, BRIGHT: 0.95, HUE: 0.62, SHIFT: -0.014, BILLOW: 0.15, RATE: -0.026, SHOW: 0.5 },
    ],
    // V switches between the vivid palette and the muted one of the reference photo
    PALETTE: {
      VIVID: true,
      vivid: {
        // melody (high ribbons): emerald -> lime -> turquoise -> electric blue -> violet -> magenta
        MELODY: [
          [0.0, '#1fd46a'],
          [0.18, '#3dff8a'],
          [0.38, '#2de0e0'],
          [0.58, '#3a8cff'],
          [0.8, '#a24dff'],
          [1.0, '#ff5de0'],
        ],
        // low chords (large lower ribbons): emerald -> lime -> turquoise -> blue
        LOW: [
          [0.0, '#1fd46a'],
          [0.55, '#3dff8a'],
          [0.85, '#2de0e0'],
          [1.0, '#3a8cff'],
        ],
        HUE_CENTRE: 0.32, // melody hue around this (low notes toward green / blue, high toward violet / magenta) ...
        HUE_SPREAD: [0.75, 1.0], // ... over this share of the ramp [quiet, climax]
        SATURATION: [1.15, 1.3], // colour saturation [quiet, loud] (by amplitude)
        GAIN: 1.35, // × curtain light: HDR cores above 1
        CAP: 2.2, // soft per-pixel cap (HDR)
        CORE: '#e8fff0', // near-white cores ...
        CORE_AMOUNT: 0.3, // ... in the brightest lower parts
        ZONE: 0.28, // ramp shift from each curtain's lower edge to its top (green -> cyan -> blue / violet)
        FRINGE: '#ff5de0', // magenta fringe ...
        FRINGE_AMOUNT: 0.6, // ... at the very top of the strongest rays
        GRADE_SATURATION: 1.1,
        SKY_WASH: 0.15, // the aurora's wash over the sky (LOOK.SKY.WASH in the muted look): the gaps stay dark
        AMBIENT_CAP: 0.1, // soft cap of the aurora's average light on sky, mountains and water (0 = none)
        TONE: 'soft', // composite tone curve: ACES darks, hue-keeping highlight shoulder
      },
      // the reference photo's look (reference restyle 2): AURORA.MELODY / LOW ramps, natural green
      muted: { HUE_CENTRE: 0.3, HUE_SPREAD: [0.25, 1.0], SATURATION: [0.95, 1.0], GAIN: 1, CAP: 0.75, CORE: '#ffffff', CORE_AMOUNT: 0.08, ZONE: 0, FRINGE: '#ffffff', FRINGE_AMOUNT: 0, GRADE_SATURATION: 1.0, SKY_WASH: 0.5, AMBIENT_CAP: 0, TONE: true },
    },
    RAYS: {
      DEPTH: [6.5, 9, 13, 18], // curtain distances in the lookup table (map units): sets how far a packet runs per screen width
      FADE: 2.2, // brightness fade toward the top (per ray length)
      STREAK: 7, // px blur along the rays (toward the VP): the long exposure; NOISE.BLUR is across them
      // broad soft rays: low-frequency noise across the rays, stretched along them
      TEXTURE: { CONTRAST: 0.45, FREQUENCY: 16, ALONG: 1.0 }, // depth, per radian across, per screen height along
      GAIN: 0.5, // × aurora brightness (keeps SCALE.BRIGHT's quiet / loud range)
      STRIATION: { CONTRAST: 0.75, FREQUENCY: 0.55 }, // the lookup table's rays (override NOISE.RAY_CONTRAST / FREQUENCY)
    },
    SKY: {
      // (the base gradient is NIGHT.SKY: teal-grey patches between the curtains)
      AIRGLOW: '#0b1a14', // a soft green wash over the whole sky (added)
      WASH: 0.5, // the aurora's own light washes the sky green around it
      CORNERS: 0.6, // darker at the far left and the upper corners
      GAP: { COLOR: '#3a2a50', AMOUNT: 0.08 }, // faint violet in the dark gaps between the curtains
      HAZE: { COLOR: '#2a4a3a', STRENGTH: 0.2, HEIGHT: 0.035 }, // low mist over the mountains (view-ray height)
      SHORE_GLOW: 0.06, // aurora glow where the far shore meets the water
    },
    STARS: { DENSITY: 0.38, SIZE: 0.5, BEHIND_AURORA: 6 }, // share of the old field (~500 visible), size, dimming behind the aurora
    CLOUDS: {
      // thin, dark, cool wisps higher in the sky (C), drifting left -> right with the mist on the sky
      // clock, partly silhouetting the aurora; their edges glow where a ribbon passes behind them
      ON: true,
      OPACITY: 0.42,
      EDGE_GLOW: 0.9, // × the aurora behind, at the wisps' thin edges
      SCALE: 2.2, // fbm frequency (per screen height)
      STRETCH: 3.2, // stretched sideways into wisps
      OCTAVES: 4,
      COVER: 0.52, // density threshold: higher = fewer clouds
      SOFT: 0.25, // edge softness
      SIDES: [-0.25, 0.45], // inner edges of the left / right banks (x in screen heights from the centre)
      BAND: [0.08, 0.55], // lowest / highest cloud (screen heights above the mountains' foot)
      BODY: '#16232a', // dark blue-grey ...
      AURORA_TINT: 0.12, // ... with a faint green tint from the aurora
      RIM: ['#e8946a', '#f2b58a'], // (warm rims: off)
      RIM_STRENGTH: 0,
      RIM_WIDTH: 0.06,
      LIGHT: [-0.08, -0.06],
      DRIFT: [0.01, 0.014], // drift speeds of the two banks, both left -> right (screen heights per sky-clock second)
      BASS_GAIN: 0,
      DAWN_GAIN: 0,
    },
    MOUNTAINS: {
      // dark silhouettes against the aurora (user, 2026-10-27; restyle 2 had lit blue-green rock #2a4637
      // and snow #3a5848): near-black blue-green, the snow streaks only a hint, a thin rim on the ridges
      ROCK: '#0b1311', // near-black blue-green rock
      SNOW: '#121c19', // the snow streaks, barely lighter
      RIM: 0.6, // the aurora catches the ridge lines (× its average light), only at the crest
      SKY_LIGHT: 0.04, // the aurora lights the snow (a little)
      LIT: { AMP: [0.1, 0.45], LIGHT: [0.4, 1] }, // ROCK / SNOW as given from aurora amplitude AMP[1] up, × LIGHT[0] when faint (dark silhouettes)
      HAZE: [0.3, 0.1, 0], // haze over the [far, middle, near] layers: the far hills a shade lighter, for depth
    },
    // A dark, calm, glassy mirror of the whole sky (R toggles the reflection)
    WATER: {
      ON: true, // R
      TOP: '#0e1d16', // the water's own colour at the horizon ...
      BOTTOM: '#060d0a', // ... and at the bottom
      REFLECT: [0.66, 0.3], // reflection × the sky's brightness [at the horizon, at the bottom] (Fresnel)
      FRESNEL: 1.4, // falloff exponent with distance from the horizon
      REACH: 3.0, // it mirrors this much more of the sky than a plain mirror would (shows the aurora)
      BLUR: [0.003, 0.045], // vertical streaking of the reflection [at the horizon, at the bottom] (screen heights)
      WOBBLE: 0.01, // horizontal ripple wobble of the reflection at the bottom (screen widths; ~0 at the horizon)
      RIPPLE: 0.3, // small, slow surface ripples (displacement)
      FINE: 1.6, // ripple fineness
      SPEED: 0.15, // slow
      STARS: 0.55, // reflected stars (× the sky's)
      GLOW: 0.35, // coloured glow on the water near the horizon (× the reflected aurora there)
      SHORE: 0.5, // aurora glow along the shoreline (the mountains' reflection)
      // accents (ALIVE.ACCENT: the strongest onsets) send soft rings across the water, a few at a time
      ONSET_RINGS: { MAX: 4, MIN_GAP: 0.45, SPEED: 2.5, WIDTH: 0.7, LIFE: 6, AMP: 0.55 }, // s, water units / s, units, s, × slope
      RINGS: 0.3, // rings spreading from the ship (when shown)
      NOTE_RINGS: 0.5,
      ROCKS: false, // the old foreground boulders
    },
    SHIP: {
      ON: false, // B (hidden in this look)
      X: 0.63,
      WATERLINE: 0.15, // screen height of its waterline (the horizon is at 0.18)
      SIZE: 0.11,
      DRIFT: 0.012, // screen widths per minute, toward the left
      BOB: 0.0018,
      ROLL: 0.012,
      HULL: '#05080a',
      SAIL: '#8fa39c',
      SAIL_LIGHT: 0.2,
      LIGHT: '#ffa65a',
      LIGHT_STRENGTH: 0.9,
      MELODY_GAIN: 0.6,
      FLICKER: 0.12,
      BILLOW: [0.05, 0.11],
    },
    GRADE: {
      LIFT: '#050c0b', // lifted blacks, teal (as seen)
      SATURATION: 1.0, // overall
      WARM_KEEP: 0.9, // saturation of the warm hues
      VIGNETTE: 0.3, // subtle
      BLOOM: { THRESHOLD: 0.75, STRENGTH: 0.55 }, // subtle, on the brightest cores (and the reflection's glow)
    },
    // the region means the --match check compares against (from the reference photo's description)
    REFERENCE: {
      TOP_SKY: '#2f5a47', // top 15 %: the curtains converging, fading into the sky wash
      AURORA_MID: '#417657', // 20-55 %: the curtains' body
      DARK_LEFT: '#20373d', // x 0-15 %, y 35-60 %: the dark patch at the far left
      HORIZON_GLOW: '#417657', // 55-65 %: the glowing lower edges over the mountains
      MOUNTAINS: '#2a4637', // 68-82 %
      FAR_WATER: '#243e31', // 84-92 %
      NEAR_WATER: '#1e3127', // 92-100 %
      CORE: '#72c883', // the curtains' bright cores (brightest 2 % of the sky)
      STARS: 500,
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
      DUSK: [[0.045, 0.07, 0.11], [0.026, 0.042, 0.075]], // deep blue-teal
      NIGHT: [[0.045, 0.085, 0.095], [0.03, 0.055, 0.072]], // (reference 2: teal-grey #20373d between the curtains, darker up high)
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
    SNOW: 0.08, // how much the dusk / dawn glow lights the snow (the mountains are silhouettes)
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
  { group: 'alive (REACTIVITY: D overlay, [ ])' },
  ['ALIVE.LEVEL.QUIET', 'level: quiet percentile', 0, 0.9, 0.01],
  ['ALIVE.LEVEL.CURVE', 'level: curve', 0.5, 3, 0.05],
  ['ALIVE.LEVEL.RELEASE', 'level: release (s)', 0.1, 4, 0.05],
  ['ALIVE.RANGE.BRIGHT.0', 'brightness: quiet', 0.02, 1, 0.01],
  ['ALIVE.RANGE.BRIGHT.1', 'brightness: loud', 0.3, 3, 0.05],
  ['ALIVE.RANGE.HEIGHT.1', 'height: loud', 0.8, 2.5, 0.05],
  ['ALIVE.RANGE.MOVE.1', 'movement: loud', 0.5, 3, 0.05],
  ['ALIVE.SPEED.RANGE.0', 'speed: quiet', 0.1, 1.5, 0.01],
  ['ALIVE.SPEED.RANGE.1', 'speed: loud', 0.5, 4, 0.05],
  ['ALIVE.SPEED.MOMENTUM', 'speed: momentum', 0, 6, 0.1],
  ['ALIVE.KICK.GAIN', 'note kick', 0, 1, 0.01],
  ['ALIVE.KICK.DECAY', 'note kick decay (s)', 0.1, 2, 0.05],
  ['ALIVE.KICK.PULSE', 'note pulse', 0, 3, 0.05],
  ['ALIVE.SWELL.GAIN', 'low swell', 0, 2, 0.05],
  ['ALIVE.ACCENT.GLOW', 'accent glow', 0, 1.5, 0.05],
  ['ALIVE.MOTION.SWAY', 'sway (rad)', 0, 0.4, 0.01],
  ['ALIVE.MOTION.ROTATE', 'rotation (rad)', 0, 0.3, 0.01],
  ['ALIVE.MOTION.BILLOW', 'billow', 0, 4, 0.05],
  ['ALIVE.MOTION.DRIFT', 'ribbon travel', 0, 6, 0.1],
  ['ALIVE.STARS.ROTATION', 'star rotation', 0, 0.01, 0.0001],
  { group: 'mist' },
  ['MIST.COVER', 'mist: cover threshold', -0.4, 0.6, 0.01],
  ['MIST.SOFT', 'mist: softness', 0.05, 1, 0.01],
  ['MIST.WARP', 'mist: billow', 0, 1.5, 0.01],
  ['MIST.ROLL', 'mist: roll rate', 0, 0.3, 0.005],
  ['MIST.LAYERS.0.OPACITY', 'mist: far opacity', 0, 1, 0.01],
  ['MIST.LAYERS.1.OPACITY', 'mist: valleys opacity', 0, 1, 0.01],
  ['MIST.LAYERS.2.OPACITY', 'mist: near opacity', 0, 1, 0.01],
  ['MIST.LAYERS.3.OPACITY', 'mist: water opacity', 0, 1, 0.01],
  ['MIST.LAYERS.2.SPEED', 'mist: near speed', 0, 0.1, 0.001],
  ['MIST.TINT', 'mist: aurora tint', 0, 3, 0.05],
  ['MIST.OVERHEAD', 'mist: overhead glow', 0, 3, 0.05],
  ['MIST.REFLECT', 'mist: in the water', 0, 1.5, 0.05],
  ['LOOK.CLOUDS.EDGE_GLOW', 'clouds: edge glow', 0, 3, 0.05],
  { group: 'look' },
  ['LOOK.CURTAINS.GAIN', 'curtains: light', 0, 8, 0.1],
  ['LOOK.CURTAINS.BEND', 'curtains: bend', 0, 0.06, 0.002],
  ['LOOK.CURTAINS.CURL.TWIST', 'curtains: loop twist', 0, 4, 0.05],
  ['LOOK.CURTAINS.FAN', 'curtains: climax fan', 0, 0.6, 0.01],
  ['LOOK.PALETTE.vivid.GAIN', 'vivid: peak brightness', 0.5, 5, 0.05],
  ['LOOK.PALETTE.vivid.SATURATION.1', 'vivid: saturation (loud)', 0.5, 2, 0.02],
  ['LOOK.PALETTE.vivid.ZONE', 'vivid: colour zones', 0, 0.8, 0.01],
  ['LOOK.PALETTE.vivid.FRINGE_AMOUNT', 'vivid: magenta fringe', 0, 1, 0.02],
  ['LOOK.CURTAINS.EDGE_ON', 'curtains: edge-on glow', 0, 2, 0.05],
  ['LOOK.RAYS.STREAK', 'rays: streak blur (px)', 0, 24, 0.5],
  ['LOOK.RAYS.FADE', 'rays: fade up', 0.5, 5, 0.05],
  ['LOOK.RAYS.TEXTURE.CONTRAST', 'rays: texture', 0, 1, 0.02],
  ['LOOK.SKY.WASH', 'sky: aurora wash', 0, 2, 0.05],
  ['LOOK.SKY.CORNERS', 'sky: dark corners', 0, 1, 0.02],
  ['LOOK.SKY.GAP.AMOUNT', 'sky: violet gaps', 0, 0.3, 0.01],
  ['LOOK.STARS.DENSITY', 'stars: density', 0, 3, 0.05],
  ['LOOK.CLOUDS.OPACITY', 'clouds: opacity', 0, 1, 0.02],
  ['LOOK.MOUNTAINS.RIM', 'mountains: green rim', 0, 4, 0.05],
  ['LOOK.WATER.REFLECT.0', 'water: reflection (horizon)', 0, 1, 0.01],
  ['LOOK.WATER.REFLECT.1', 'water: reflection (bottom)', 0, 1, 0.01],
  ['LOOK.WATER.WOBBLE', 'water: wobble', 0, 0.04, 0.001],
  ['LOOK.WATER.GLOW', 'water: horizon glow', 0, 1.5, 0.05],
  ['LOOK.GRADE.SATURATION', 'grade: saturation', 0.3, 1.3, 0.02],
  ['LOOK.GRADE.VIGNETTE', 'grade: vignette', 0, 1, 0.02],
  { group: 'night' },
  ['NIGHT.DUSK_GLOW.STRENGTH', 'dusk glow', 0, 3, 0.05],
  ['NIGHT.DAWN_GLOW.STRENGTH', 'dawn glow', 0, 3, 0.05],
  ['NIGHT.MILKY_WAY.1', 'Milky Way (deepest night)', 0, 5, 0.1],
  ['NIGHT.STARS.GAIN.1', 'stars (deepest night)', 0, 3, 0.05],
  ['NIGHT.AURORA.DAWN_FADE', 'aurora fade at dawn', 0, 1, 0.05],
];
