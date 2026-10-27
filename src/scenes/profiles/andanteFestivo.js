/**
 * Scene 3 profile: Jean Sibelius, "Andante Festivo" (string orchestra, ~4:05).
 *
 * Noble and warm: long legato lines that keep building, a first climax
 * around 1:34-2:03, a short release, and a final radiant, triumphant climax
 * (~3:43) that then dies away. A narrow dynamic range (~12 dB), so the
 * profile leans on the piece-normalised level and on the score's structure
 * rather than on raw loudness. How the aurora performs it:
 *   - `build` (the score's anticipating drive, smoothed nobly) grows the
 *     curtains in height, width, coverage and brightness
 *   - quiet passages: low, narrow curtains with slow, wide ripples
 *   - sections set the state; the climax flares the curtains (taller,
 *     brighter, the green body warming toward gold, a pink-white crown)
 *   - accented string attacks send a soft shimmer through the rays and a
 *     gentle colour surge, never on every note
 *
 * Every constant is here; the ones in TUNE are live sliders (T).
 */
export const PROFILE = {
  piece: 'andante-festivo',

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
  WARM: { QUIET: 0.0, FULL: 0.15, CLIMAX: 0.65 }, // green body warming toward gold
  EXPOSURE: { QUIET: 0.8, FULL: 1.05, CLIMAX: 0.05 },

  // accented onsets -> a soft shimmer and colour surge (decaying slowly)
  ACCENT: { SHIMMER: 0.5, SURGE: 0.25, DECAY: 1.4, MIN_STRENGTH: 0.55 },
};

/** Live sliders (T): [path, label, min, max, step]. */
export const TUNE = [
  { group: 'Andante Festivo' },
  ['BUILD.ATTACK', 'build attack (s)', 0.2, 5, 0.1],
  ['BUILD.RELEASE', 'build release (s)', 0.5, 10, 0.1],
  ['BUILD.CURVE', 'build curve', 0.5, 3, 0.05],
  ['SPEED.QUIET', 'quiet ripple speed', 0.05, 1, 0.01],
  ['HEIGHT.CLIMAX', 'climax height', 0, 1.5, 0.05],
  ['BRIGHT.CLIMAX', 'climax flare', 0, 2, 0.05],
  ['WARM.CLIMAX', 'climax warmth', 0, 1, 0.05],
  ['BRIGHT.QUIET', 'quiet brightness', 0, 1, 0.01],
  ['ACCENT.SHIMMER', 'accent shimmer', 0, 1.5, 0.05],
];
