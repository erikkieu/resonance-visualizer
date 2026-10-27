/**
 * Scene 5 profile: "Interstellar" (the track in /public/Music: an
 * Interstellar-style organ piece after Hans Zimmer, ~2:05, E minor).
 *
 * A slow organ build over a repeating pattern (~100 bpm pulse) that grows
 * into a long, huge climax (~0:47-1:47) and fades out. Analysis: hush to
 * ~0:18, two swells to ~0:47, the climax, a fade from ~1:47. How the galaxy
 * performs it:
 *   - `build`: the score's drive, slowly smoothed (it rises with the organ,
 *     ahead of each step), is the one value behind everything
 *   - rotation, core glow, bloom, star density and the camera pull-back
 *     all follow `build`; in the quiet parts the galaxy is nearly still
 *   - the repeating pattern: every beat of the score sends a faint
 *     shockwave ring from the core (PULSE keeps beat-level pulsing low)
 *   - the galaxy's body moves with the music, slowly and smoothly: it tips
 *     toward the viewer and grows as the music builds, leans with the
 *     bass/treble balance and the melody (MOTION)
 *   - the climax opens it fully: the galaxy at its largest and most open,
 *     the core flares and every star is lit
 *   - the fade lets it all settle back, rotation easing toward stillness
 *   - around it, a field of stars at every depth; some are tuned to one
 *     frequency band and glow (warm low, ice-blue high) when it comes forward
 *
 * Every constant is here; the ones in TUNE are live sliders (T).
 */
export const PROFILE = {
  piece: 'interstellar',

  STAGES: {
    calm: { speed: 0.4, core: 0.75, pull: 0.0, rings: 0.0 },
    building: { speed: 1.0, core: 1.0, pull: 0.35, rings: 0.7 },
    climax: { speed: 1.25, core: 1.35, pull: 1.0, rings: 1.0 },
    resolving: { speed: 0.6, core: 0.85, pull: 0.5, rings: 0.4 },
  },
  STAGE_BLEND: 4, // s: slow, like the music

  BUILD: { ATTACK: 2.5, RELEASE: 4.0, CURVE: 1.4 }, // smoothing of the drive into `build` (attack was 1.0: the light pumped with the pattern)
  SPEED: { STILL: 0.06, FULL: 1.6, SMOOTHING: 2.0 }, // scene clock (rotation, drift)
  CORE: { QUIET: 0.25, FULL: 1.25, CLIMAX: 0.6, BASS: 0.35 }, // core glow intensity
  BLOOM: { QUIET: 0.45, FULL: 0.9, CLIMAX: 0.35 },
  EXPOSURE: { QUIET: 0.6, FULL: 1.05, CLIMAX: 0.2 },
  STARS: { QUIET: 0.75, FULL: 1.0 }, // share of the galaxy's stars lit (quiet was 0.4: stars popping in and out read as pulsing)
  // The view is kept calm (user, 2026-10-27: the orbiting camera spun the whole
  // sky and felt nauseating): a fixed viewpoint, the background stands still,
  // and only the galaxy itself turns, very slowly.
  // The galaxy always turns slowly (user, 2026-10-27), in wall-clock time so
  // it doesn't stop in the quiet parts; the music only adds a little.
  SPIN: {
    BASE: 0.014, // rad/s: ~0.8°/s, one turn in ~7.5 min
    MUSIC: 0.008, // rad/s added at full build
    SMOOTHING: 5.0, // s, speed changes are gradual
  },

  // The galaxy's own body language (user, 2026-10-27: less pulsing, more
  // slow turning and growing). The whole disk tilts and grows; critically
  // damped springs with long periods keep every move seamless (they ease in
  // and out and never overshoot). The camera and the sky stay still.
  MOTION: {
    PITCH: [-0.12, 0.3], // rad, tipping toward the viewer: quiet (more edge-on) -> full (opening up)
    PITCH_CLIMAX: 0.12, // rad, extra opening at the climax
    MELODY: 0.12, // rad, a high melody tips it further toward the viewer, a low one away
    ROLL: 0.3, // rad, sideways lean: brighter-than-usual sound leans one way, darker the other
    BALANCE_GAIN: 8.0, // spectral-centroid shift (0..1 over the 8 bands) -> lean; tanh-limited
    BALANCE_AVERAGE: 25.0, // s, "usual" brightness the centroid is compared with
    BALANCE_SMOOTHING: 4.0, // s
    WANDER: 0.05, // rad, a very slow drift so it is never frozen (periods ~1-2 min)
    SIZE: [0.82, 1.12], // scale: quiet -> full
    SIZE_CLIMAX: 0.1,
    PERIOD: 12.0, // s, spring period of the tilts: larger = calmer
    SIZE_PERIOD: 10.0, // s, spring period of the size
  },
  // How much of the old beat-level pulsing is left (1 = all of it): bass
  // breathing and mid ripples of the arms, the core's bass/beat flicker and
  // the beat shockwave rings. User wants it subtle (0.2 was still too much).
  PULSE: 0.08,
  SPARKLE: 0.35, // share of the old treble sparkle on galaxy and background stars

  // Shooting stars come when the musicians play stronger (user, 2026-10-27):
  // none below THRESHOLD of the build, then more often the louder it gets,
  // and a strong accent in a loud passage can launch one right on the note.
  // Random spot in the sky, mostly falling diagonally, behind the galaxy.
  METEORS: {
    THRESHOLD: 0.4, // build (or climax) below this: no shooting stars
    GAP: [20, 5], // s between them on average: just above THRESHOLD -> full strength
    MIN_GAP: 4.0, // s, never closer than this (2.5 gave one every ~3 s with accents; the climax lasts ~1 min)
    ACCENT: 0.3, // how far above THRESHOLD (0..1) before accents may launch one
    DURATION: [0.7, 1.3], // s
    LENGTH: [0.2, 0.36], // tail, x screen height
    TRAVEL: [0.3, 0.5], // path, x screen height
    WIDTH: 3.5, // px
    BRIGHT: 3.0, // head brightness (> 1 blooms)
  },

  // Background stars behind the galaxy's disk are hidden by it (user,
  // 2026-10-27: too many stars seemed to lie in front of the galaxy).
  OCCLUDE: {
    AMOUNT: 0.92, // 1 = fully hidden at the centre of the disk
    RADIUS: 1.15, // x galaxy radius; the hiding fades out from ~half of it to the rim
  },

  // A bright point of light now and then, floating slowly across the screen
  // behind the galaxy (user, 2026-10-27; replaced the asteroids). A hot core
  // that blooms, a soft halo and faint diffraction spikes; it breathes gently
  // and the galaxy's disk hides it where they overlap.
  LIGHTS: {
    // more of them, from every side (user, 2026-10-27): at most POOL on screen,
    // a new one only GAP s after the last one came in; one strong at a time,
    // the others fainter (FAINT)
    POOL: 3, // at most this many at once
    FIRST: 8, // s after the scene opens
    GAP: 15, // s: always wait this long after one came in before sending the next
    CROSS: 60, // s to drift across the width of the screen; other paths at the same speed (±20 %)
    FAINT: { BRIGHT: 0.4, SIZE: 0.7 }, // x the strong one
    // it blinks (user, 2026-10-27): fade in, shine ON s, fade out, dark OFF s, again
    BLINK: { ON: 4, OFF: 6, FADE: 1 },
    // and floats instead of following a fixed line: smooth wandering on top
    // of the slow drift (x wander stays slower than the drift, so it eases
    // and hurries but never turns back)
    WANDER: { X: 0.12, Y: 0.22, PERIOD: [14, 32] }, // half-screen units; s
    SIZE: 0.08, // halo radius, x screen height
    BRIGHT: 4.0, // core brightness (> 1 blooms)
    TINTS: [0xf2f6ff, 0xdce8ff, 0xfff1dc], // white, ice blue, warm
  },

  // Fine stardust: many tiny faint particles in the far background, grained
  // like the galaxy's own particles; part of them gather in a soft band.
  STARDUST: {
    COUNT: 60000,
    DEPTH: [900, 1400],
    SIZE: [0.8, 1.4], // px
    BRIGHT: 0.32,
    BAND: 0.45, // share in the band
    BAND_WIDTH: 0.16, // band thickness (radians, gaussian)
  },
  CAMERA: {
    PULL: 0.2, // extra distance (x the normal one) at full pull (was 0.75; the galaxy now grows instead)
    RISE: 0.0, // extra elevation (radians) at full pull; > 0 tilts the whole sky
    ORBIT: 0.0, // camera orbit speed (rad per scene-clock second; was 0.05)
    SWAY: 0.0, // 0..1: the old slow bob of elevation, distance and look-at point
    PARALLAX: 0.25, // mouse parallax (1 = the old amount)
    SMOOTHING: 3.0, // s, camera moves are slow
  },
  RINGS: { MIN_DRIVE: 0.25, STRENGTH: [0.3, 1.1], SPEED: [0.25, 0.55] }, // shockwaves on the score's beats

  // The resonant starfield: stars scattered at all depths around the galaxy,
  // a share of them tuned to one of BANDS log-spaced frequency bands of the
  // live spectrum. Each band is measured against its own recent average, so
  // a star lights up when *its* frequencies come forward, not just when the
  // music is loud. COUNT / TUNED / DEPTH / HZ are read once at init.
  RESONANCE: {
    COUNT: 9000,
    TUNED: 0.35, // share of the field that reacts; the rest shine steadily
    DEPTH: [80, 1200], // distance range, log-uniform: as many near stars as far ones
    SIZE: [1.2, 4.5], // px, far -> near
    BRIGHT: [0.4, 1.4], // far -> near
    HZ: [40, 10000], // band edges span this range (8 bands)
    PEAK_MIX: 0.6, // band value = this much of its loudest bin + the rest of its mean
    GAIN: 4.5, // extra brightness at full response
    SIZE_GAIN: 2.0, // extra size at full response
    CURVE: 1.6, // > 1: only clear peaks light the stars fully
    ATTACK: 0.04, // s
    RELEASE: 0.45, // s, the afterglow
    AVERAGE: 3.0, // s, the baseline each band is compared with
    PEAK_DECAY: 6.0, // s
    FLOOR: 0.04, // below this a band counts as silent (no noise sparkle)
    IDLE: 0.3, // response with nothing playing (the synthetic idle bands)
    TINTS: [0xffa860, 0xffc680, 0xffe2b0, 0xfff4e0, 0xe8f0ff, 0xc4dcff, 0xa8c8ff, 0x9ec0ff], // low -> high
  },
};

/** Live sliders (T): [path, label, min, max, step]. */
export const TUNE = [
  { group: 'Interstellar' },
  ['BUILD.ATTACK', 'build attack (s)', 0.2, 5, 0.1],
  ['BUILD.RELEASE', 'build release (s)', 0.5, 12, 0.1],
  ['SPEED.STILL', 'stillness speed', 0, 0.5, 0.01],
  ['SPEED.FULL', 'full speed', 0.5, 3, 0.05],
  ['CAMERA.PULL', 'climax pull-back', 0, 2, 0.05],
  ['CAMERA.RISE', 'climax rise', 0, 0.8, 0.01],
  ['SPIN.BASE', 'galaxy spin', 0, 0.06, 0.001],
  ['SPIN.MUSIC', 'spin from music', 0, 0.04, 0.001],
  ['SPARKLE', 'sparkle', 0, 1, 0.01],
  ['LIGHTS.GAP', 'light point: wait before next (s)', 3, 60, 1],
  ['LIGHTS.FAINT.BRIGHT', 'light point: faint ones brightness', 0.1, 1, 0.01],
  ['LIGHTS.CROSS', 'light point: crossing time (s)', 10, 200, 1],
  ['LIGHTS.BRIGHT', 'light point: brightness', 0.3, 6, 0.05],
  ['LIGHTS.SIZE', 'light point: glow size', 0.01, 0.15, 0.005],
  ['LIGHTS.BLINK.ON', 'light point: shines (s)', 0.5, 15, 0.5],
  ['LIGHTS.BLINK.OFF', 'light point: dark (s)', 0, 20, 0.5],
  ['LIGHTS.BLINK.FADE', 'light point: fade (s)', 0.1, 4, 0.1],
  ['LIGHTS.WANDER.Y', 'light point: float up/down', 0, 0.6, 0.01],
  ['OCCLUDE.AMOUNT', 'galaxy hides stars behind it', 0, 1, 0.01],
  ['OCCLUDE.RADIUS', 'hiding radius', 0.6, 1.6, 0.01],
  ['METEORS.THRESHOLD', 'meteors: from loudness', 0, 1, 0.01],
  ['METEORS.GAP.0', 'meteors: gap when moderate (s)', 3, 60, 1],
  ['METEORS.GAP.1', 'meteors: gap at full (s)', 1, 30, 0.5],
  { group: 'Galaxy motion' },
  ['MOTION.PITCH.1', 'full tilt toward viewer', -0.3, 0.6, 0.01],
  ['MOTION.ROLL', 'sideways lean', 0, 0.8, 0.01],
  ['MOTION.MELODY', 'melody tilt', 0, 0.4, 0.01],
  ['MOTION.WANDER', 'slow wander', 0, 0.2, 0.005],
  ['MOTION.SIZE.0', 'quiet size', 0.5, 1.2, 0.01],
  ['MOTION.SIZE.1', 'full size', 0.8, 1.5, 0.01],
  ['MOTION.PERIOD', 'tilt calmness (s)', 2, 20, 0.5],
  ['MOTION.SIZE_PERIOD', 'size calmness (s)', 2, 20, 0.5],
  ['PULSE', 'beat pulsing', 0, 1, 0.01],
  ['CAMERA.ORBIT', 'camera orbit', 0, 0.06, 0.001],
  ['CAMERA.SWAY', 'camera sway', 0, 1, 0.01],
  ['CAMERA.PARALLAX', 'mouse parallax', 0, 1, 0.01],
  ['CORE.CLIMAX', 'climax core flare', 0, 2, 0.05],
  ['STARS.QUIET', 'quiet star density', 0.1, 1, 0.01],
  ['EXPOSURE.QUIET', 'quiet exposure', 0.2, 1, 0.01],
  ['RINGS.STRENGTH.1', 'ring strength', 0, 2, 0.05],
  { group: 'Resonant stars' },
  ['RESONANCE.GAIN', 'glow', 0, 8, 0.1],
  ['RESONANCE.SIZE_GAIN', 'swell', 0, 4, 0.05],
  ['RESONANCE.CURVE', 'contrast', 0.5, 4, 0.05],
  ['RESONANCE.RELEASE', 'afterglow (s)', 0.05, 2, 0.01],
  ['RESONANCE.IDLE', 'idle response', 0, 1, 0.01],
];
