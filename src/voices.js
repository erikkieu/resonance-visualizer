/**
 * voices.js: how the music is split into two voices, shared by the offline
 * analysis (scripts/analyze.mjs) and the live analyser (audio.js).
 *
 *   LOW      the low register: bass notes and low chord tones (left hand).
 *            Onsets are spectral flux in REGISTER_HZ plus changes of the
 *            low-register chroma (a new chord without a fresh bass attack).
 *            Its pitch is the strongest harmonic-sum candidate in REGISTER_HZ,
 *            height 0..1 log over that range; `note` is the dominant pitch
 *            class of the smoothed low chroma.
 *   MELODY   the singing top line: the predominant pitch in REGISTER_HZ
 *            (voiced = confidence over MIN_CONF). A new note is a pitch step
 *            of at least STEP semitones held HOLD s, or a fresh attack
 *            (upper-register flux) while voiced. Height is log over the
 *            piece's melody range (p3..p97 of the voiced frames).
 *
 * Scenes read the result as audio.perf.voices (scoreMap.js). Retune here and
 * re-run `npm run analyze -- <piece>`.
 */
export const VOICES = {
  LOW: {
    REGISTER_HZ: [60, 350],
    FLUX_HZ: [50, 400], // flux band for the low attacks (a little wider: the attack transient)
    HARMONICS: 4,
    CONFIDENCE: [1.6, 3.5], // salience peak / mean -> confidence 0..1
    CHROMA_SMOOTH: 0.3, // s
    ONSET: { MEDIAN: 0.6, DELTA: 0.12, PEAK: 0.06, MIN_GAP: 0.22 }, // s / share of the p95 flux
    CHORD_CHANGE: 0.22, // cosine distance of the low chroma 0.3 s before vs after = a new chord
    MIN_LEVEL: 0.08, // level under which nothing counts
  },
  MELODY: {
    REGISTER_HZ: [220, 2000],
    MIN_CONF: 0.3,
    STEP: 0.8, // semitones
    HOLD: 0.05, // s a new pitch must hold
    ATTACK: { MEDIAN: 0.5, DELTA: 0.1, PEAK: 0.05, MIN_GAP: 0.09 },
    FLUX_HZ: [250, 4000],
    MIN_GAP: 0.09, // s between two melody notes
    REATTACK: 0.3, // a same-pitch attack counts as a new note above this (share of the p99.5 flux)
  },
  // live analyser (audio.js): flux detectors (threshold = mean + K * std of the recent flux)
  LIVE: {
    LOW: { K: 1.5, FLOOR: 0.004, REFRACTORY: 0.22 },
    MELODY_STEP_HOLD: 0.06, // s
  },
};
