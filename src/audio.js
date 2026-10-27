/**
 * audio.js: Web Audio analysis singleton.
 *
 * Every frame `audio.update(dt)` produces smoothed, normalized (0..1) values:
 *   bass    20-150 Hz
 *   mid     150-2000 Hz
 *   treble  2000-12000 Hz
 *   energy  overall RMS loudness
 *   beat    onset pulse: jumps to 1 on a detected beat, then decays
 *   beatId  increments once per beat (scenes compare it to spawn one-shot events)
 *   presence  0 when nothing is playing, 1 while music (live input or demo)
 *             is audible; ramps slowly so scenes can calm down gracefully
 *   noteId    increments on every articulated note (broadband onset, 150 Hz-6 kHz),
 *             which catches string/harpsichord/woodwind attacks that have no kick
 *   note      pulse that jumps to 1 on a note onset, then decays
 *   density   notes per second, smoothed and scaled to 0..1 (~7 notes/s = 1)
 *   pitchHeight  0..1, how high the melody is: the strongest peak in
 *             FMIN..FMAX (parabolic interpolation; spectral centroid when the
 *             peak is not prominent), on a log scale, fast attack / slow
 *             release, stretched over the range heard in the last ~20 s
 *             (pitchHz, pitchConfidence, pitchHeightRaw, pitchLo/pitchHi for debugging)
 *   level     adaptive loudness: (dB - recentMin) / (recentMax - recentMin) over
 *             the last LEVEL_CONFIG.WINDOW seconds (levelDb / levelMinDb / levelMaxDb)
 *   onsetId   increments on every piano-style onset (spectral flux 100-2000 Hz);
 *   onset     pulse that jumps to 1 on an onset, then decays; onsetRate = onsets / s
 *   melodyNoteId  increments on every melody note (sensitive onsets in 200 Hz-3 kHz),
 *             tuned on Drottningholmsmusiken to catch the bowed/legato notes
 *             noteId misses; melodyNote is its decaying pulse
 *   chroma / dominantNote / dominantNoteName / noteStrength
 *             12-bin pitch-class profile (C..B) and its strongest class
 *   the two voices (src/voices.js; scoreMap.js turns them into perf.voices when no
 *   analysis is loaded):
 *   lowNoteId / lowStrength / lowHz / lowHeight / lowConfidence / lowNote
 *             low register (bass notes, low chord tones): flux onsets in VOICES.LOW.FLUX_HZ,
 *             the strongest long-FFT peak in REGISTER_HZ (height 0..1 log over it) and
 *             the dominant pitch class of the low-register chroma
 *   leadNoteId / leadStrength / leadHz / leadHeight / leadConfidence
 *             the melody: a pitch step of VOICES.MELODY.STEP semitones held
 *             LIVE.MELODY_STEP_HOLD s, or a melody onset while voiced
 *
 * Sources: microphone, a local file (via an <audio> element, so seeking is
 * trivial), or the synthetic generator. When nothing live is audible, the
 * output cross-fades to a gentle "idle" signal so scenes never freeze.
 */

import { VOICES } from './voices.js';

// ===================================================================== config
// Pitch height (melody) and chroma. All tuning lives here.
export const PITCH_CONFIG = {
  FMIN: 150, // Hz: pitchHeight 0 (bottom of the melody range)
  FMAX: 2000, // Hz: pitchHeight 1 (top of the melody range)
  FFT_SIZE: 8192, // long FFT, ~6 Hz bins: enough resolution for melody peaks and semitones
  ANALYSER_SMOOTHING: 0.2, // Web Audio smoothing on the long FFT
  ATTACK: 0.08, // s: pitchHeight rises fast...
  RELEASE: 0.5, // s: ...and falls slowly
  WINDOW: 20, // s of history for the adaptive min / max
  MIN_RANGE: 0.2, // never stretch less than this much raw height over 0..1
  MIN_HISTORY: 3, // s of history before the adaptive range is fully trusted
  PEAK_TILT_DB_PER_OCTAVE: 3, // favour melody peaks over strong low harmonics of the bass
  CONFIDENCE_DB: [6, 14], // peak prominence over the band average: 6 dB = centroid, 14 dB = peak
  CHROMA_MIN_HZ: 60,
  CHROMA_MAX_HZ: 4000,
  CHROMA_SMOOTHING: 0.35, // s
  DOMINANT_MARGIN: 0.12, // a new dominant note must beat the current one by 12 %
};
// Adaptive loudness level
export const LEVEL_CONFIG = {
  WINDOW: 20, // s of history for recentMin / recentMax
  INTEGRATION: 0.5, // s, short-term loudness averaging
  MIN_RANGE_DB: 6, // never stretch less than this many dB over 0..1 (steady music reads ~0.5)
  WARMUP: 0.75, // s of audible signal ignored at the start (a fade-in would fake a huge range)
  MIN_HISTORY: 4, // s of history before the level is fully trusted (until then it leans to 0.5)
  SILENCE_DB: -50, // below this the input counts as silence: the one absolute threshold left
  // Until loud music has actually been heard, the ceiling starts at a typical
  // loud level and relaxes toward the observed maximum, so a very quiet intro
  // reads quiet (not as "the loudest so far") and a crescendo rises gradually.
  PRIOR_MAX_DB: -20,
  PRIOR_RELAX: 40, // s
};
// Piano-style note onsets
export const ONSET_CONFIG = {
  MIN_HZ: 100,
  MAX_HZ: 2000,
  K: 1.4, // threshold = mean + K * std of the recent flux
  FLOOR: 0.006,
  REFRACTORY: 0.07, // s between two onsets
};
// Melody notes: a more sensitive onset detector over the melody range.
// Tuned offline on Drottningholmsmusiken (Roman): about 4.7 notes/s against
// noteId's 1.8, with timing that still follows the rhythm (gaps fall on the
// sixteenth grid as often as noteId's do), and next to nothing in silence.
export const MELODY_CONFIG = {
  MIN_HZ: 200,
  MAX_HZ: 3000,
  K: 0.6, // threshold = mean + K * std of the recent flux
  FLOOR: 0.002,
  REFRACTORY: 0.11, // s between two notes (a sixteenth at ~104 bpm is 0.145 s)
};
// ============================================================================

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Demo chord loop for the synthetic signal: D major, B minor, F# minor, A major
const DEMO_CHORDS = [
  [2, 6, 9],
  [11, 2, 6],
  [6, 9, 1],
  [9, 1, 4],
];
const HISTORY_HZ = 10; // pitch history sample rate

const FFT_SIZE = 2048;
const BANDS = {
  bass: [20, 150],
  mid: [150, 2000],
  treble: [2000, 12000],
};

// Attack / release time constants (seconds): fast rise, slow fall.
const SMOOTHING = {
  bass: [0.035, 0.32],
  mid: [0.05, 0.4],
  treble: [0.02, 0.22],
  energy: [0.08, 0.7],
};

/** Exponential attack/release follower, frame-rate independent. */
function follow(current, target, dt, attack, release) {
  const tau = target > current ? attack : release;
  return current + (target - current) * (1 - Math.exp(-dt / tau));
}

/**
 * Adaptive running-max normalizer. The peak snaps up instantly and decays
 * slowly (time constant `decay`), so quiet tracks and loud tracks both span
 * the 0..1 range, while a quiet passage after a loud one still reads as quiet.
 * `floor` keeps silence/noise from being amplified into fake activity.
 */
class PeakNormalizer {
  constructor(floor, decay = 9) {
    this.floor = floor;
    this.decay = decay;
    this.peak = floor;
  }

  process(value, dt) {
    this.peak = Math.max(value, this.peak * Math.exp(-dt / this.decay), this.floor);
    return Math.min(1, value / this.peak);
  }
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Adaptive-threshold onset detector: an onset is a flux value that clearly
 * exceeds the recent mean (mean + k * std over ~0.8 s), with a refractory
 * period so one attack is not counted twice.
 */
class OnsetDetector {
  constructor({ k, floor, refractory, history = 48 }) {
    this.k = k;
    this.floor = floor;
    this.refractory = refractory;
    this.history = new Float32Array(history);
    this.index = 0;
    this.last = -10;
  }

  detect(flux, time) {
    const h = this.history;
    let mean = 0;
    for (let i = 0; i < h.length; i++) mean += h[i];
    mean /= h.length;
    let v = 0;
    for (let i = 0; i < h.length; i++) v += (h[i] - mean) ** 2;
    const std = Math.sqrt(v / h.length);
    h[this.index] = flux;
    this.index = (this.index + 1) % h.length;
    if (flux > mean + this.k * std + this.floor && time - this.last > this.refractory) {
      this.last = time;
      return true;
    }
    return false;
  }
}

// Notes per second that count as "full" density (a Presto in sixteenths)
const DENSITY_FULL = 7;

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.mode = 'idle'; // 'idle' | 'demo' | 'mic' | 'file'

    // public, smoothed outputs
    this.bass = 0;
    this.mid = 0;
    this.treble = 0;
    this.energy = 0;
    this.beat = 0;
    this.beatId = 0;
    this.note = 0;
    this.noteId = 0;
    this.density = 0;
    this.pitchHeight = 0.5;
    this.pitchHeightRaw = 0.5;
    this.pitchHz = 0;
    this.pitchConfidence = 0;
    this.pitchLo = 0;
    this.pitchHi = 1;
    this.chroma = new Float32Array(12).fill(1 / 12);
    this.dominantNote = 2;
    this.noteStrength = 0;
    this.level = 0;
    this.levelDb = -Infinity;
    this.levelMinDb = -Infinity;
    this.levelMaxDb = -Infinity;
    this.onset = 0;
    this.onsetId = 0;
    this.onsetRate = 0;
    this.melodyNote = 0;
    this.melodyNoteId = 0;
    // the two voices
    this.lowNoteId = 0;
    this.lowStrength = 0;
    this.lowHz = 0;
    this.lowHeight = 0;
    this.lowConfidence = 0;
    this.lowNote = -1;
    this.leadNoteId = 0;
    this.leadStrength = 0;
    this.leadHz = 0;
    this.leadHeight = 0;
    this.leadConfidence = 0;
    this._lowChroma = new Float32Array(12);
    this._leadSemi = NaN;
    this._leadPending = NaN;
    this._leadPendingAt = 0;
    this._leadLast = -10;
    this._noteCount = 0; // leaky note counter for the density estimate
    /** 0 = fully synthetic, 1 = fully live input */
    this.liveMix = 0;
    /** 0 = no music playing (idle signal), 1 = music (live or demo) */
    this.presence = 0;

    this.time = 0;
    this._listeners = new Set();
    this._synthNextBeat = 0;
    this._synthNextNote = 0;
    // low-end onsets = beats (kick drums, bass notes)
    this._beatDetector = new OnsetDetector({ k: 1.6, floor: 0.012, refractory: 0.26 });
    // broadband onsets = individual notes (bowed/plucked attacks, no drums needed)
    this._noteDetector = new OnsetDetector({ k: 1.3, floor: 0.006, refractory: 0.09 });
    // piano-style onsets in the melody/accompaniment range
    this._onsetDetector = new OnsetDetector({ k: ONSET_CONFIG.K, floor: ONSET_CONFIG.FLOOR, refractory: ONSET_CONFIG.REFRACTORY });
    this._onsetCount = 0; // leaky onset counter for the rate
    this._melodyDetector = new OnsetDetector({ k: MELODY_CONFIG.K, floor: MELODY_CONFIG.FLOOR, refractory: MELODY_CONFIG.REFRACTORY });
    const LL = VOICES.LIVE.LOW;
    this._lowDetector = new OnsetDetector({ k: LL.K, floor: LL.FLOOR, refractory: LL.REFRACTORY });
    // adaptive loudness: short-term mean square and a ring of recent dB values
    this._meanSquare = 0;
    this._levelRing = new Float32Array(LEVEL_CONFIG.WINDOW * HISTORY_HZ);
    this._levelCount = 0;
    this._levelIndex = 0;
    this._levelClock = 0;
    this._audibleTime = 0;
    this._levelPrior = LEVEL_CONFIG.PRIOR_MAX_DB;
    // Long memories: a soft movement after a loud one must stay soft (Baroque
    // terraced dynamics, slow movements), yet a changed volume knob adapts
    // within a minute.
    this._norm = {
      bass: new PeakNormalizer(0.08, 20),
      mid: new PeakNormalizer(0.06, 20),
      treble: new PeakNormalizer(0.04, 20),
      energy: new PeakNormalizer(0.02, 40),
    };
    // pitch height history for the adaptive range
    this._pitchRing = new Float32Array(PITCH_CONFIG.WINDOW * HISTORY_HZ);
    this._pitchCount = 0;
    this._pitchIndex = 0;
    this._pitchClock = 0;
    this._synthHeight = 0.5;
    this._chromaTarget = new Float32Array(12);
    this._synthChroma = new Float32Array(12);

    this.element = null;
    this.fileName = '';
    this.pieceId = null; // id from src/pieces.js when a library piece is playing
    this._objectUrl = null;
    this._mic = null;
  }

  // ---------------------------------------------------------------- setup

  /**
   * Creates (or resumes) the AudioContext. Must run inside a user gesture the
   * first time to satisfy the autoplay policy; main.js also calls it on the
   * first pointer/key event.
   */
  async ensureContext() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) throw new Error('Web Audio is not supported in this browser');
      this.ctx = new Ctx();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = FFT_SIZE;
      this.analyser.smoothingTimeConstant = 0.8;
      this.analyser.minDecibels = -95;
      this.analyser.maxDecibels = -20;
      // A second, barely smoothed analyser for note onsets: the 0.8 smoothing
      // above blurs fast passages (e.g. sixteenth-note runs) into one event.
      this.onsetAnalyser = this.ctx.createAnalyser();
      this.onsetAnalyser.fftSize = 1024;
      this.onsetAnalyser.smoothingTimeConstant = 0.25;
      this.onsetAnalyser.minDecibels = -95;
      this.onsetAnalyser.maxDecibels = -20;
      // Keep the analyser pulled by the graph without making it audible.
      const sink = this.ctx.createGain();
      sink.gain.value = 0;
      this.analyser.connect(sink).connect(this.ctx.destination);
      this.onsetAnalyser.connect(sink);
      // long FFT for the melody pitch and the chroma
      this.pitchAnalyser = this.ctx.createAnalyser();
      this.pitchAnalyser.fftSize = PITCH_CONFIG.FFT_SIZE;
      this.pitchAnalyser.smoothingTimeConstant = PITCH_CONFIG.ANALYSER_SMOOTHING;
      this.pitchAnalyser.minDecibels = -100;
      this.pitchAnalyser.maxDecibels = -20;
      this.pitchAnalyser.connect(sink);
      this.pitchData = new Float32Array(this.pitchAnalyser.frequencyBinCount);

      this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
      this.prevFreq = new Uint8Array(this.analyser.frequencyBinCount);
      this.timeData = new Float32Array(this.analyser.fftSize);
      this.fastFreq = new Uint8Array(this.onsetAnalyser.frequencyBinCount);
      this.prevFast = new Uint8Array(this.onsetAnalyser.frequencyBinCount);
      this._computeBins();
    }
    if (this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch {
        /* will retry on the next gesture */
      }
    }
    return this.ctx;
  }

  _computeBins() {
    const hzPerBin = this.ctx.sampleRate / FFT_SIZE;
    const n = this.analyser.frequencyBinCount;
    const toBin = (hz) => Math.min(n - 1, Math.max(1, Math.round(hz / hzPerBin)));
    this.bins = {};
    for (const [k, [lo, hi]] of Object.entries(BANDS)) this.bins[k] = [toBin(lo), Math.max(toBin(lo) + 1, toBin(hi))];
    // beat detection looks at the low end (kick drums, bass notes)
    this.fluxBins = [toBin(30), toBin(260)];
    // note detection looks at the melodic range (strings, winds, harpsichord),
    // on the fast analyser (half the FFT size, so twice the Hz per bin)
    const fastHz = this.ctx.sampleRate / this.onsetAnalyser.fftSize;
    const fastN = this.onsetAnalyser.frequencyBinCount;
    const toFastBin = (hz) => Math.min(fastN - 1, Math.max(1, Math.round(hz / fastHz)));
    this.noteBins = [toFastBin(150), toFastBin(6000)];
    this.onsetBins = [toFastBin(ONSET_CONFIG.MIN_HZ), toFastBin(ONSET_CONFIG.MAX_HZ)];
    this.melodyBins = [toFastBin(MELODY_CONFIG.MIN_HZ), toFastBin(MELODY_CONFIG.MAX_HZ)];
    this.lowFluxBins = [toFastBin(VOICES.LOW.FLUX_HZ[0]), Math.max(toFastBin(VOICES.LOW.FLUX_HZ[0]) + 1, toFastBin(VOICES.LOW.FLUX_HZ[1]))];

    // Long FFT: melody band for the pitch peak, and the chroma folding table
    const C = PITCH_CONFIG;
    const pHz = this.ctx.sampleRate / C.FFT_SIZE;
    this.pitchBinHz = pHz;
    this.pitchBins = [Math.max(2, Math.floor(C.FMIN / pHz)), Math.ceil(C.FMAX / pHz)];
    this.lowPitchBins = VOICES.LOW.REGISTER_HZ.map((hz) => Math.max(2, Math.round(hz / pHz)));
    // tilt in dB per bin so higher (melodic) peaks win over loud low partials
    this.pitchTilt = Float32Array.from({ length: this.pitchBins[1] - this.pitchBins[0] + 1 }, (_, i) => C.PEAK_TILT_DB_PER_OCTAVE * Math.log2(((this.pitchBins[0] + i) * pHz) / C.FMIN));
    // chroma: each bin goes to its nearest semitone, weighted by how close it is
    const bins = [];
    const classes = [];
    const weights = [];
    for (let k = Math.ceil(C.CHROMA_MIN_HZ / pHz); k <= Math.floor(C.CHROMA_MAX_HZ / pHz); k++) {
      const midi = 69 + 12 * Math.log2((k * pHz) / 440);
      const nearest = Math.round(midi);
      const w = Math.cos(Math.PI * (midi - nearest)) ** 2;
      if (w < 0.05) continue;
      bins.push(k);
      classes.push(((nearest % 12) + 12) % 12);
      weights.push(w);
    }
    this.chromaBins = Int32Array.from(bins);
    this.chromaClasses = Uint8Array.from(classes);
    this.chromaWeights = Float32Array.from(weights);
  }

  /** Forgets the pitch range history, e.g. when a different source starts. */
  _resetPitchHistory() {
    this._pitchCount = 0;
    this._pitchIndex = 0;
    // the loudness history belongs to the old source too
    this._levelCount = 0;
    this._levelIndex = 0;
    this._audibleTime = 0;
    this._meanSquare = 0;
    this._levelPrior = LEVEL_CONFIG.PRIOR_MAX_DB;
    this.levelMinDb = -Infinity;
    this.levelMaxDb = -Infinity;
  }

  _ensureElement() {
    if (this.element) return;
    const el = new Audio();
    el.preload = 'auto';
    el.crossOrigin = 'anonymous';
    el.addEventListener('ended', () => this._emit());
    el.addEventListener('play', () => this._emit());
    el.addEventListener('pause', () => this._emit());
    el.addEventListener('loadedmetadata', () => this._emit());
    el.addEventListener('seeked', () => this._emit());
    this.element = el;
    const src = this.ctx.createMediaElementSource(el);
    src.connect(this.ctx.destination); // audible
    src.connect(this.analyser); // analysed
    src.connect(this.onsetAnalyser);
    src.connect(this.pitchAnalyser);
  }

  // -------------------------------------------------------------- sources

  async useMic() {
    await this.ensureContext();
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone access is not available here (needs HTTPS or localhost)');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this._stopMic();
    this.element?.pause();
    const source = this.ctx.createMediaStreamSource(stream);
    source.connect(this.analyser); // never to destination: no feedback
    source.connect(this.onsetAnalyser);
    source.connect(this.pitchAnalyser);
    this._mic = { stream, source };
    this._resetPitchHistory();
    this.mode = 'mic';
    this._emit();
  }

  async useFile(file) {
    if (!file) return;
    if (!/^audio\//.test(file.type) && !/\.(mp3|wav|ogg|oga|m4a|aac|flac|webm)$/i.test(file.name)) {
      throw new Error(`"${file.name}" does not look like an audio file`);
    }
    await this.ensureContext();
    this._ensureElement();
    this._stopMic();
    if (this._objectUrl) URL.revokeObjectURL(this._objectUrl);
    this._objectUrl = URL.createObjectURL(file);
    this.element.src = this._objectUrl;
    this.fileName = file.name.replace(/\.[^.]+$/, '');
    this.pieceId = null; // library.js may still recognise a dropped copy of a known piece
    this._resetPitchHistory();
    this.mode = 'file';
    this._emit();
    await this.element.play();
  }

  /** Plays a piece from the library (src/pieces.js) by URL. */
  async useUrl(url, title, pieceId) {
    await this.ensureContext();
    this._ensureElement();
    this._stopMic();
    if (this._objectUrl) URL.revokeObjectURL(this._objectUrl);
    this._objectUrl = null;
    this.element.src = url;
    this.fileName = title;
    this.pieceId = pieceId;
    this._resetPitchHistory();
    this.mode = 'file';
    this._emit();
    await this.element.play();
  }

  async useDemo() {
    await this.ensureContext().catch(() => {});
    this._stopMic();
    this.element?.pause();
    this.mode = 'demo';
    this._emit();
  }

  _stopMic() {
    if (!this._mic) return;
    this._mic.source.disconnect();
    for (const t of this._mic.stream.getTracks()) t.stop();
    this._mic = null;
  }

  async togglePlay() {
    if (this.mode !== 'file' || !this.element) return;
    await this.ensureContext();
    if (this.element.paused) await this.element.play();
    else this.element.pause();
  }

  seek(fraction) {
    const el = this.element;
    if (!el || !isFinite(el.duration)) return;
    el.currentTime = clamp01(fraction) * el.duration;
  }

  seekTo(seconds) {
    const el = this.element;
    if (!el || !isFinite(el.duration)) return;
    el.currentTime = Math.max(0, Math.min(el.duration, seconds));
  }

  get isPlaying() {
    return this.mode === 'file' && this.element && !this.element.paused;
  }

  get currentTime() {
    return this.element?.currentTime ?? 0;
  }

  get duration() {
    const d = this.element?.duration;
    return isFinite(d) ? d : 0;
  }

  /** Subscribe to source/transport changes (used by ui.js). */
  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _emit() {
    for (const fn of this._listeners) fn(this);
  }

  // ------------------------------------------------------------- analysis

  _analyseLive(dt) {
    const a = this.analyser;
    a.getByteFrequencyData(this.freqData);
    a.getFloatTimeDomainData(this.timeData);

    const f = this.freqData;
    const band = ([lo, hi]) => {
      let s = 0;
      for (let i = lo; i < hi; i++) s += f[i];
      return s / ((hi - lo) * 255);
    };

    // RMS of the waveform = perceived loudness proxy
    let sq = 0;
    const td = this.timeData;
    for (let i = 0; i < td.length; i++) sq += td[i] * td[i];
    const rms = Math.sqrt(sq / td.length);

    // Spectral flux on the low end: sum of positive bin-to-bin increases
    let flux = 0;
    const [flo, fhi] = this.fluxBins;
    for (let i = flo; i < fhi; i++) {
      const d = f[i] - this.prevFreq[i];
      if (d > 0) flux += d;
    }
    flux /= (fhi - flo) * 255;

    this.prevFreq.set(f);

    // Broadband flux for note onsets, from the lightly smoothed analyser
    const ff = this.fastFreq;
    this.onsetAnalyser.getByteFrequencyData(ff);
    let noteFlux = 0;
    const [nlo, nhi] = this.noteBins;
    for (let i = nlo; i < nhi; i++) {
      const d = ff[i] - this.prevFast[i];
      if (d > 0) noteFlux += d;
    }
    noteFlux /= (nhi - nlo) * 255;
    let onsetFlux = 0;
    const [olo, ohi] = this.onsetBins;
    for (let i = olo; i < ohi; i++) {
      const d = ff[i] - this.prevFast[i];
      if (d > 0) onsetFlux += d;
    }
    onsetFlux /= (ohi - olo) * 255;
    let melodyFlux = 0;
    const [mlo, mhi] = this.melodyBins;
    for (let i = mlo; i < mhi; i++) {
      const d = ff[i] - this.prevFast[i];
      if (d > 0) melodyFlux += d;
    }
    melodyFlux /= (mhi - mlo) * 255;
    let lowFlux = 0;
    const [llo, lhi] = this.lowFluxBins;
    for (let i = llo; i < lhi; i++) {
      const d = ff[i] - this.prevFast[i];
      if (d > 0) lowFlux += d;
    }
    lowFlux /= (lhi - llo) * 255;
    this.prevFast.set(ff);

    const { pitchHz, pitchConfidence, chroma } = this._analysePitch();
    const low = this._analyseLow();

    // Normalize: band means come in dB space already, so a gamma > 1 restores contrast
    const n = this._norm;
    return {
      rms,
      flux,
      noteFlux,
      onsetFlux,
      melodyFlux,
      lowFlux,
      low,
      pitchHz,
      pitchConfidence,
      chroma,
      bass: Math.pow(n.bass.process(band(this.bins.bass), dt), 1.8),
      mid: Math.pow(n.mid.process(band(this.bins.mid), dt), 1.6),
      treble: Math.pow(n.treble.process(band(this.bins.treble), dt), 1.5),
      energy: Math.pow(n.energy.process(rms, dt), 1.25),
    };
  }

  /**
   * Melody pitch from the long FFT: the strongest (slightly treble-tilted)
   * peak between FMIN and FMAX, refined by parabolic interpolation on its dB
   * neighbours. When the peak barely rises above the band (low prominence),
   * the estimate blends toward the band's spectral centroid instead.
   * Also folds the spectrum into the 12-bin chroma.
   */
  _analysePitch() {
    const C = PITCH_CONFIG;
    const d = this.pitchData;
    this.pitchAnalyser.getFloatFrequencyData(d);
    const [lo, hi] = this.pitchBins;

    let best = -1;
    let bestScore = -Infinity;
    let sumDb = 0;
    let num = 0;
    let den = 0;
    for (let k = lo; k <= hi; k++) {
      const db = Math.max(d[k], -140);
      sumDb += db;
      const mag = Math.pow(10, db / 20);
      num += mag * k;
      den += mag;
      const score = db + this.pitchTilt[k - lo];
      if (score > bestScore && db >= d[k - 1] && db >= d[k + 1]) {
        bestScore = score;
        best = k;
      }
    }
    const binHz = this.pitchBinHz;
    const centroidHz = den > 0 ? (num / den) * binHz : C.FMIN;
    let pitchHz = centroidHz;
    let pitchConfidence = 0;
    if (best > 0) {
      const a = d[best - 1];
      const b = d[best];
      const c = d[best + 1];
      const denom = a - 2 * b + c;
      const offset = denom !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom)) : 0;
      const peakHz = (best + offset) * binHz;
      const prominence = b - sumDb / (hi - lo + 1);
      const [c0, c1] = C.CONFIDENCE_DB;
      pitchConfidence = clamp01((prominence - c0) / (c1 - c0));
      // blend on a log scale so the fallback never jumps
      pitchHz = Math.exp(Math.log(centroidHz) + (Math.log(peakHz) - Math.log(centroidHz)) * pitchConfidence);
    }

    const chroma = this._chromaTarget.fill(0);
    const cb = this.chromaBins;
    const cc = this.chromaClasses;
    const cw = this.chromaWeights;
    for (let j = 0; j < cb.length; j++) {
      const db = d[cb[j]];
      if (db > -100) chroma[cc[j]] += cw[j] * Math.log1p(100 * Math.pow(10, db / 20));
    }
    let total = 0;
    for (let i = 0; i < 12; i++) total += chroma[i];
    if (total > 0) for (let i = 0; i < 12; i++) chroma[i] /= total;
    else chroma.fill(1 / 12);

    return { pitchHz, pitchConfidence, chroma };
  }

  /**
   * The low voice from the long FFT (already read by _analysePitch): the
   * strongest peak in VOICES.LOW.REGISTER_HZ and its prominence, plus the
   * low-register chroma.
   */
  _analyseLow() {
    const d = this.pitchData;
    const [lo, hi] = this.lowPitchBins;
    let best = -1;
    let bestDb = -Infinity;
    let sum = 0;
    const chroma = this._lowChroma.fill(0);
    for (let k = lo; k <= hi; k++) {
      const db = Math.max(d[k], -140);
      sum += db;
      if (db > bestDb && db >= d[k - 1] && db >= d[k + 1]) [bestDb, best] = [db, k];
      if (db > -100) {
        const midi = 69 + 12 * Math.log2((k * this.pitchBinHz) / 440);
        chroma[((Math.round(midi) % 12) + 12) % 12] += Math.log1p(100 * Math.pow(10, db / 20));
      }
    }
    const [r0, r1] = VOICES.LOW.REGISTER_HZ;
    const hz = best > 0 ? best * this.pitchBinHz : 0;
    let note = -1;
    let max = 0;
    for (let i = 0; i < 12; i++) if (chroma[i] > max) [max, note] = [chroma[i], i];
    return {
      hz,
      height: hz > 0 ? clamp01(Math.log2(hz / r0) / Math.log2(r1 / r0)) : 0,
      confidence: best > 0 ? clamp01((bestDb - sum / (hi - lo + 1) - 6) / 12) : 0,
      note,
    };
  }

  /** The melody voice: a held pitch step, or a melody onset while voiced. */
  _updateLead(live, melodyNow, dt) {
    const V = VOICES.MELODY;
    const hz = live.pitchHz;
    const voiced = live.pitchConfidence >= V.MIN_CONF && hz >= V.REGISTER_HZ[0] && hz <= V.REGISTER_HZ[1];
    this.leadHz = voiced ? hz : 0;
    this.leadConfidence = live.pitchConfidence;
    let fire = false;
    if (voiced) {
      const s = 12 * Math.log2(hz / 440);
      if (!(Math.abs(s - this._leadSemi) < V.STEP)) {
        if (!(Math.abs(s - this._leadPending) < 0.5)) {
          this._leadPending = s;
          this._leadPendingAt = this.time;
        } else if (this.time - this._leadPendingAt >= VOICES.LIVE.MELODY_STEP_HOLD) {
          this._leadSemi = s;
          this._leadPending = NaN;
          fire = true;
        }
      } else if (melodyNow) fire = true;
    } else this._leadPending = NaN;
    if (fire && this.time - this._leadLast >= V.MIN_GAP) {
      this._leadLast = this.time;
      this.leadNoteId++;
      this.leadStrength = clamp01(0.3 + 0.7 * this.level);
    }
    this.leadHeight = this.pitchHeight;
  }

  /**
   * Raw height (log scale, fast attack / slow release) stretched over the
   * min..max heard in the last WINDOW seconds. Until MIN_HISTORY seconds are
   * collected the raw height is used as-is.
   */
  _adaptiveHeight(dt) {
    const C = PITCH_CONFIG;
    this._pitchClock += dt;
    if (this._pitchClock >= 1 / HISTORY_HZ) {
      this._pitchClock %= 1 / HISTORY_HZ;
      this._pitchRing[this._pitchIndex] = this.pitchHeightRaw;
      this._pitchIndex = (this._pitchIndex + 1) % this._pitchRing.length;
      this._pitchCount = Math.min(this._pitchCount + 1, this._pitchRing.length);
    }
    if (this._pitchCount === 0) return this.pitchHeightRaw;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < this._pitchCount; i++) {
      const v = this._pitchRing[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (hi - lo < C.MIN_RANGE) {
      const mid = (hi + lo) / 2;
      lo = mid - C.MIN_RANGE / 2;
      hi = mid + C.MIN_RANGE / 2;
    }
    this.pitchLo = lo;
    this.pitchHi = hi;
    const stretched = clamp01((this.pitchHeightRaw - lo) / (hi - lo));
    const trust = clamp01(this._pitchCount / (C.MIN_HISTORY * HISTORY_HZ));
    return this.pitchHeightRaw + (stretched - this.pitchHeightRaw) * trust;
  }

  /**
   * Adaptive loudness: short-term dB mapped into the [min, max] dB range of
   * the last WINDOW seconds. Silence and the first moments after silence
   * (a fade-in) stay out of the history, so pauses and starts do not stretch
   * the range. Until MIN_HISTORY seconds are collected it leans toward 0.5.
   */
  _adaptiveLevel(rms, dt) {
    const C = LEVEL_CONFIG;
    this._meanSquare += (rms * rms - this._meanSquare) * (1 - Math.exp(-dt / C.INTEGRATION));
    const db = 10 * Math.log10(this._meanSquare + 1e-12);
    this.levelDb = db;
    this._audibleTime = db > C.SILENCE_DB ? this._audibleTime + dt : 0;

    this._levelClock += dt;
    if (this._levelClock >= 1 / HISTORY_HZ) {
      this._levelClock %= 1 / HISTORY_HZ;
      if (this._audibleTime > C.WARMUP) {
        this._levelRing[this._levelIndex] = db;
        this._levelIndex = (this._levelIndex + 1) % this._levelRing.length;
        this._levelCount = Math.min(this._levelCount + 1, this._levelRing.length);
      }
    }
    if (this._levelCount === 0 || db <= C.SILENCE_DB) return 0;

    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < this._levelCount; i++) {
      const v = this._levelRing[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    // the prior ceiling relaxes toward what has really been heard
    this._levelPrior += (hi - this._levelPrior) * (1 - Math.exp(-dt / C.PRIOR_RELAX));
    hi = Math.max(hi, this._levelPrior);
    this.levelMinDb = lo;
    this.levelMaxDb = hi;
    if (hi - lo < C.MIN_RANGE_DB) {
      const mid = (hi + lo) / 2;
      lo = mid - C.MIN_RANGE_DB / 2;
      hi = mid + C.MIN_RANGE_DB / 2;
    }
    const raw = clamp01((db - lo) / (hi - lo));
    const trust = clamp01(this._levelCount / (C.MIN_HISTORY * HISTORY_HZ));
    return 0.5 + (raw - 0.5) * trust;
  }

  /** Chroma smoothing and the dominant note (with a hysteresis margin). */
  _updateChroma(target, dt) {
    const k = 1 - Math.exp(-dt / PITCH_CONFIG.CHROMA_SMOOTHING);
    const c = this.chroma;
    let best = 0;
    for (let i = 0; i < 12; i++) {
      c[i] += (target[i] - c[i]) * k;
      if (c[i] > c[best]) best = i;
    }
    if (best !== this.dominantNote && c[best] > c[this.dominantNote] * (1 + PITCH_CONFIG.DOMINANT_MARGIN)) this.dominantNote = best;
    const max = c[this.dominantNote];
    // 0 for a flat profile, toward 1 when one pitch class dominates
    this.noteStrength = max > 0 ? clamp01((1 - 1 / 12 / max) / (1 - 1 / 12)) : 0;
  }

  get dominantNoteName() {
    return NOTE_NAMES[this.dominantNote];
  }

  /**
   * Synthetic signal. intensity 0 = idle (soft, slow breathing pulses),
   * intensity 1 = demo (a ~96 bpm groove whose loudness swells and recedes
   * over 32 s, so the energy-driven speed changes are visible).
   */
  _synth(intensity) {
    const t = this.time;
    if (intensity < 0.5) {
      const breathe = 0.5 + 0.5 * Math.sin(t * 0.42);
      const beatNow = t >= this._synthNextBeat;
      if (beatNow) this._synthNextBeat = t + 2.2 + 1.4 * (0.5 + 0.5 * Math.sin(t * 1.7));
      const noteNow = t >= this._synthNextNote;
      if (noteNow) this._synthNextNote = t + 0.9 + 0.8 * Math.random();
      this._synthChroma.fill(1 / 12);
      return {
        note: noteNow,
        level: 0,
        // a slow drift in the ocean / cyan middle of the colour ramp
        height: 0.5 + 0.08 * Math.sin(t * 0.23) + 0.04 * Math.sin(t * 0.71),
        chroma: this._synthChroma,
        bass: 0.22 + 0.16 * breathe + 0.12 * Math.max(0, Math.sin(t * 1.1)) ** 3,
        mid: 0.22 + 0.12 * Math.sin(t * 0.31 + 1.3) + 0.06 * Math.sin(t * 0.83),
        treble: 0.14 + 0.08 * (0.5 + 0.5 * Math.sin(t * 2.3 + Math.sin(t * 0.7) * 2)),
        energy: 0.14 + 0.1 * breathe + 0.03 * Math.sin(t * 0.13),
        beat: beatNow,
      };
    }
    const bpm = 96;
    const beatLen = 60 / bpm;
    const phase = (t % beatLen) / beatLen;
    const beatIndex = Math.floor(t / beatLen);
    const section = 0.5 - 0.5 * Math.cos((t / 32) * Math.PI * 2); // 0..1 swell
    const swell = 0.2 + 0.8 * section;
    const kick = Math.exp(-phase * 7) * swell;
    const snare = beatIndex % 2 === 1 ? Math.exp(-phase * 9) : 0;
    const hat = Math.exp(-((t % (beatLen / 2)) / (beatLen / 2)) * 12);
    const beatNow = beatIndex !== this._synthBeatIndex && (section > 0.18 || beatIndex % 4 === 0);
    this._synthBeatIndex = beatIndex;
    // a melody in eighth notes, busier and higher as the swell grows
    const eighth = Math.floor(t / (beatLen / 2));
    const noteNow = eighth !== this._synthEighth && (section > 0.35 || eighth % 2 === 0);
    this._synthEighth = eighth;
    // a stepped melody: one height per eighth note, climbing as the swell grows
    const contour = 0.5 + 0.5 * Math.sin(eighth * 1.7 + 2 * Math.sin(eighth * 0.31));
    const [root, third, fifth] = DEMO_CHORDS[Math.floor(t / (beatLen * 8)) % DEMO_CHORDS.length];
    const chroma = this._synthChroma.fill(0.015);
    chroma[root] += 0.5;
    chroma[third] += 0.16;
    chroma[fifth] += 0.18;
    return {
      note: noteNow,
      level: clamp01(0.08 + 0.9 * section),
      height: clamp01(0.12 + 0.5 * contour + 0.35 * section),
      chroma,
      bass: clamp01(0.12 + 0.75 * kick + 0.1 * section),
      mid: clamp01(0.2 + 0.35 * section + 0.35 * snare * swell + 0.08 * Math.sin(t * 0.9)),
      treble: clamp01(0.12 + 0.5 * hat * swell + 0.2 * section),
      energy: clamp01(0.12 + 0.72 * section + 0.12 * kick),
      beat: beatNow,
    };
  }

  update(dt) {
    dt = Math.min(Math.max(dt, 0), 0.1);
    this.time += dt;

    const liveActive = this.analyser && (this.mode === 'mic' || this.isPlaying);
    const live = liveActive ? this._analyseLive(dt) : null;
    const synth = this._synth(this.mode === 'demo' ? 1 : 0);

    // Gate: below ~-50 dBFS RMS we treat the input as silence and cross-fade to idle.
    const audible = live && 20 * Math.log10(live.rms + 1e-9) > LEVEL_CONFIG.SILENCE_DB ? 1 : 0;
    this.liveMix = follow(this.liveMix, audible, dt, 0.2, 1.4);
    const m = this.liveMix;
    const musicOn = this.mode === 'demo' || audible === 1;
    this.presence = follow(this.presence, musicOn ? 1 : 0, dt, 0.8, 2.0);

    let beatNow = false;
    if (live && this._beatDetector.detect(live.flux, this.time) && m > 0.5) beatNow = true;
    if (synth.beat && m < 0.5) beatNow = true;
    if (beatNow) {
      this.beat = 1;
      this.beatId++;
    } else {
      this.beat *= Math.exp(-dt * 5.5);
    }

    let noteNow = false;
    if (live && this._noteDetector.detect(live.noteFlux, this.time) && m > 0.5) noteNow = true;
    if (synth.note && m < 0.5) noteNow = true;
    if (noteNow) {
      this.note = 1;
      this.noteId++;
    } else {
      this.note *= Math.exp(-dt * 8);
    }
    // piano-style onsets (the synthetic signal reuses its note events)
    let onsetNow = false;
    if (live && this._onsetDetector.detect(live.onsetFlux, this.time) && m > 0.5) onsetNow = true;
    if (synth.note && m < 0.5) onsetNow = true;
    if (onsetNow) {
      this.onset = 1;
      this.onsetId++;
    } else {
      this.onset *= Math.exp(-dt * 8);
    }
    this._onsetCount = this._onsetCount * Math.exp(-dt / 2) + (onsetNow ? 1 : 0);
    this.onsetRate = this._onsetCount / 2;
    // melody notes (the synthetic signal reuses its note events)
    let melodyNow = false;
    if (live && this._melodyDetector.detect(live.melodyFlux, this.time) && m > 0.5) melodyNow = true;
    if (synth.note && m < 0.5) melodyNow = true;
    if (melodyNow) {
      this.melodyNote = 1;
      this.melodyNoteId++;
    } else {
      this.melodyNote *= Math.exp(-dt * 8);
    }

    // adaptive loudness level (live), or the synthetic one
    const liveLevel = live ? this._adaptiveLevel(live.rms, dt) : 0;
    this.level = live ? liveLevel * m + synth.level * (1 - m) : synth.level;

    // note density: leaky counter (~2 s window) -> notes per second
    this._noteCount = this._noteCount * Math.exp(-dt / 2) + (noteNow ? 1 : 0);
    this.density = follow(this.density, clamp01(this._noteCount / 2 / DENSITY_FULL), dt, 0.6, 1.6);
    // pitch height: live estimate (held through silence) blended with the synthetic one
    const C = PITCH_CONFIG;
    this._synthHeight = follow(this._synthHeight, synth.height, dt, C.ATTACK, C.RELEASE);
    let liveHeight = this.pitchHeightRaw;
    if (live && audible) {
      this.pitchHz = live.pitchHz;
      this.pitchConfidence = live.pitchConfidence;
      const h = clamp01(Math.log2(live.pitchHz / C.FMIN) / Math.log2(C.FMAX / C.FMIN));
      this.pitchHeightRaw = follow(this.pitchHeightRaw, h, dt, C.ATTACK, C.RELEASE);
      liveHeight = this._adaptiveHeight(dt);
    }
    this.pitchHeight = live ? liveHeight * m + this._synthHeight * (1 - m) : this._synthHeight;
    this._updateChroma(live && m > 0.5 ? live.chroma : synth.chroma, dt);

    // the two voices (the synthetic signal: its beats are the low notes, its notes the melody)
    if (live && m > 0.5) {
      if (this._lowDetector.detect(live.lowFlux, this.time)) {
        this.lowNoteId++;
        this.lowStrength = clamp01(0.3 + 0.7 * this.level);
      }
      this.lowHz = live.low.hz;
      this.lowHeight = follow(this.lowHeight, live.low.height, dt, 0.08, 0.4);
      this.lowConfidence = live.low.confidence;
      this.lowNote = live.low.note;
      this._updateLead(live, melodyNow, dt);
    } else {
      if (synth.beat) {
        this.lowNoteId++;
        this.lowStrength = 0.4 + 0.5 * synth.level;
      }
      if (synth.note) {
        this.leadNoteId++;
        this.leadStrength = 0.4 + 0.5 * synth.level;
      }
      this.lowHeight = 0.3;
      this.leadHeight = this.pitchHeight;
      this.lowNote = this.dominantNote;
    }

    for (const k of ['bass', 'mid', 'treble', 'energy']) {
      const target = live ? synth[k] * (1 - m) + live[k] * m : synth[k];
      const [atk, rel] = SMOOTHING[k];
      this[k] = follow(this[k], target, dt, atk, rel);
    }
  }
}

export const audio = new AudioEngine();
export default audio;
