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
 *   - the repeating pattern: every beat of the score sends a shockwave ring
 *     from the core, stronger as the music grows, none in the stillness
 *   - the climax opens the view: the camera pulls far back and rises over
 *     the disk, the core flares and every star is lit
 *   - the fade lets it all settle back, rotation easing toward stillness
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

  BUILD: { ATTACK: 1.0, RELEASE: 4.0, CURVE: 1.4 }, // smoothing of the drive into `build`
  SPEED: { STILL: 0.06, FULL: 1.6, SMOOTHING: 2.0 }, // scene clock (rotation, drift)
  CORE: { QUIET: 0.25, FULL: 1.25, CLIMAX: 0.6, BASS: 0.35 }, // core glow intensity
  BLOOM: { QUIET: 0.45, FULL: 0.9, CLIMAX: 0.35 },
  EXPOSURE: { QUIET: 0.6, FULL: 1.05, CLIMAX: 0.2 },
  STARS: { QUIET: 0.4, FULL: 1.0 }, // share of the galaxy's stars lit
  CAMERA: {
    PULL: 0.75, // extra distance (x the normal one) at full pull: the opening-up
    RISE: 0.35, // extra elevation (radians) at full pull: looking down over the whole disk
    SMOOTHING: 3.0, // s, camera moves are slow
  },
  RINGS: { MIN_DRIVE: 0.25, STRENGTH: [0.3, 1.1], SPEED: [0.25, 0.55] }, // shockwaves on the score's beats
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
  ['CORE.CLIMAX', 'climax core flare', 0, 2, 0.05],
  ['STARS.QUIET', 'quiet star density', 0.1, 1, 0.01],
  ['EXPOSURE.QUIET', 'quiet exposure', 0.2, 1, 0.01],
  ['RINGS.STRENGTH.1', 'ring strength', 0, 2, 0.05],
];
