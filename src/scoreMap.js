/**
 * scoreMap.js: the runtime "score follower".
 *
 * The offline analysis (scripts/analyze.mjs -> /public/analysis/<id>.json)
 * knows the whole piece: its sections, climaxes, every onset and the melody.
 * The live analyser (audio.js) knows only the present, but works with any
 * source. This module joins them into one per-frame object, `audio.perf`,
 * that scenes read:
 *
 *   source        'score' (analysis of the playing piece), 'live' (mic / unknown file) or 'idle'
 *   t             playhead (s), drift-free: follows the <audio> clock incl. seeks, pauses, tab throttling
 *   level         loudness for THIS piece, 0..1 through a gentle S-curve (quiet looks truly quiet)
 *   drive         level with anticipation: rises up to LOOKAHEAD s before a crescendo lands,
 *                 then releases slowly (fast attack, slow release). The main intensity knob.
 *   rise          0..1, how much louder the next LOOKAHEAD s will be (a crescendo is coming)
 *   climax        0..1 envelope around the piece's big moments, already rising during the build
 *   section       { index, role, label, letter, mood, start, end } and `next`, `timeToNext`, `progress`
 *   stage         'calm' | 'building' | 'climax' | 'resolving' (from the section role), `ending` in a fade
 *   mood          0..1, the section's mood, cross-fading into the next section's ahead of time
 *   sectionId     increments on every section change (incl. after a seek)
 *   onsets        notes that sounded since the last frame: { t, strength, height, melody, accent }
 *   upcoming      notes in the next ONSET_WINDOW s, { ..., in: seconds until it sounds }
 *   height, heightConf, pitchHz   melody pitch height 0..1 (low..high for this piece)
 *   chroma, key { name, tonic, mode }, keyId (increments on a key change)
 *   beatPhase, beatId, cues (manual cues fired this frame), jumpId (increments on a seek)
 *   bass, mid, treble, presence   from the live analyser (fine detail, works with the mic)
 */
import { audio as defaultAudio } from './audio.js';

// ====================================================================== config
export const SCORE_CONFIG = {
  LOOKAHEAD: 1.5, // s the score looks ahead (crescendos, section changes)
  ONSET_WINDOW: 0.2, // s of upcoming onsets exposed for scheduling
  DRIFT_SNAP: 0.25, // s: farther than this from the media clock -> jump (a seek)
  DRIFT_SLEW: 0.4, // s: smaller drift is pulled in over this time constant
  S_CURVE: 1.3, // contrast of the level S-curve (1 = linear)
  DRIVE: { ATTACK: 0.12, RELEASE: 1.4, AHEAD_WEIGHT: 0.95 },
  CLIMAX: { MIN_LEVEL: 0.7, LEAD: 0.8, HOLD: 3, DECAY: 6 },
  MELODY_NOTE: { MIN_CONF: 0.3, MIN_STEP: 0.7, ACCENT: 0.6 }, // semitones / strength
  LIVE: { CLIMAX_ENTER: 0.85, CLIMAX_EXIT: 0.68, CLIMAX_HOLD: 2, CALM: 0.3, RISE_GAIN: 2.5, MOOD: 6, MIN_STAGE: 5 },
};
// ============================================================================

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const follow = (v, to, dt, attack, release) => v + (to - v) * (1 - Math.exp(-dt / (to > v ? attack : release)));
const sCurve = (x, a = SCORE_CONFIG.S_CURVE) => {
  const p = Math.pow(clamp01(x), a);
  return p / (p + Math.pow(1 - clamp01(x), a));
};
const STAGE_OF = { hush: 'calm', build: 'building', swell: 'building', climax: 'climax', release: 'resolving', fade: 'resolving' };
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** First index i with arr[i] > t (arr sorted ascending). */
function upperBound(arr, t, get = (x) => x) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (get(arr[mid]) <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ===================================================================== ScoreMap

/** The analysis of one piece, with time queries. */
export class ScoreMap {
  static async load(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`no analysis at ${url} (${res.status})`);
    return new ScoreMap(await res.json());
  }

  constructor(data) {
    this.data = data;
    this.id = data.id;
    this.title = data.title;
    this.duration = data.duration;
    this.rate = data.frameRate;
    this.chromaRate = data.chromaRate;
    this.level = Float32Array.from(data.level);
    const [lo, hi] = data.loudness.range;
    this.slowLevel = Float32Array.from(data.loudness.slowDb, (db) => clamp01((db - lo) / (hi - lo)));
    this.height = Float32Array.from(data.melody.height);
    this.heightConf = Float32Array.from(data.melody.confidence);
    this.hz = Float32Array.from(data.melody.hz);
    this.bands = { bass: Float32Array.from(data.bands.bass), mid: Float32Array.from(data.bands.mid), treble: Float32Array.from(data.bands.treble) };
    this.beats = data.beats;
    this.keys = data.keys.regions;
    this.manual = data.manual ?? {};

    // sections, with the hand-edited overrides applied
    const overrides = this.manual.sections ?? [];
    this.sections = data.sections.map((s) => {
      const o = overrides.find((m) => m.at >= s.start && m.at < s.end);
      const merged = o ? { ...s, ...o, manual: true } : { ...s };
      delete merged.at;
      merged.stage = STAGE_OF[merged.role] ?? 'calm';
      return merged;
    });
    this.cues = [...(this.manual.cues ?? [])].sort((a, b) => a.t - b.t);

    // onsets, each tagged: is it a new melody note, is it an accent
    const M = SCORE_CONFIG.MELODY_NOTE;
    const semis = (t) => {
      const hz = this.sample(this.hz, t);
      return hz > 0 ? 12 * Math.log2(hz / 440) : NaN;
    };
    this.onsets = data.onsets.times.map((t, i) => {
      const strength = data.onsets.strength[i];
      const conf = this.sample(this.heightConf, t + 0.04);
      const step = Math.abs(semis(t + 0.08) - semis(t - 0.06));
      return {
        t,
        strength,
        height: this.sample(this.height, t + 0.06),
        melody: conf >= M.MIN_CONF && (step >= M.MIN_STEP || strength >= M.ACCENT),
        accent: strength >= M.ACCENT,
      };
    });

    // climax envelope: ramps from each big moment's build start, holds, decays;
    // the biggest climax reaches 1, lesser ones less (squared, so they stay clearly smaller)
    const C = SCORE_CONFIG.CLIMAX;
    this.climaxCurve = new Float32Array(this.level.length);
    const topLevel = Math.max(C.MIN_LEVEL + 0.01, ...data.climaxes.sustained.map((c) => c.level));
    for (const c of data.climaxes.sustained) {
      if (c.level < C.MIN_LEVEL) continue;
      const weight = clamp01((c.level - C.MIN_LEVEL) / (topLevel - C.MIN_LEVEL)) ** 2;
      for (let i = 0; i < this.climaxCurve.length; i++) {
        const t = i / this.rate;
        let v = 0;
        if (t >= c.buildStart && t < c.t) {
          const x = (t - c.buildStart) / Math.max(0.5, c.t - c.buildStart);
          v = x * x * (3 - 2 * x);
        } else if (t >= c.t && t < c.t + C.HOLD) v = 1;
        else if (t >= c.t + C.HOLD) v = Math.exp(-(t - c.t - C.HOLD) / C.DECAY);
        this.climaxCurve[i] = Math.max(this.climaxCurve[i], v * weight);
      }
    }
  }

  /** Linear interpolation of a curve sampled at `rate` (frames) at time t. */
  sample(arr, t, rate = this.rate) {
    const x = Math.max(0, t * rate);
    const i = Math.floor(x);
    if (i >= arr.length - 1) return arr[arr.length - 1] ?? 0;
    return arr[i] + (arr[i + 1] - arr[i]) * (x - i);
  }

  /** Max of a curve over [t0, t1], each sample weighted by `weight(dtFromT0)`. */
  maxAhead(arr, t0, t1, weight = () => 1) {
    let best = 0;
    const i0 = Math.max(0, Math.floor(t0 * this.rate));
    const i1 = Math.min(arr.length - 1, Math.ceil(t1 * this.rate));
    for (let i = i0; i <= i1; i++) best = Math.max(best, arr[i] * weight(i / this.rate - t0));
    return best;
  }

  sectionIndexAt(t) {
    const i = upperBound(this.sections, t, (s) => s.start) - 1;
    return Math.max(0, Math.min(this.sections.length - 1, i));
  }

  keyAt(t) {
    return this.keys[Math.max(0, upperBound(this.keys, t, (k) => k.start) - 1)] ?? this.keys[0];
  }

  chromaAt(t, out) {
    const frame = this.data.chroma[Math.min(this.data.chroma.length - 1, Math.max(0, Math.round(t * this.chromaRate)))];
    for (let i = 0; i < 12; i++) out[i] = frame?.[i] ?? 0;
    return out;
  }
}

// ================================================================= ScoreFollower

/**
 * A playhead locked to an <audio> element. Between the element's (coarse)
 * clock updates it advances with the frame time, and any drift is pulled in
 * gently; a jump larger than DRIFT_SNAP (a seek, a throttled background tab)
 * snaps it and counts as a seek, so missed onsets are not replayed in a burst.
 */
export class ScoreFollower {
  constructor() {
    this.t = 0;
    this.jumped = true;
    this.jumpId = 0;
    this._lastTarget = 0;
  }

  /** Audible position: the media clock minus the output latency (what is heard now). */
  _target(el, ctx) {
    const latency = (ctx?.outputLatency || 0) + (ctx?.baseLatency || 0);
    return Math.max(0, el.currentTime - latency);
  }

  update(dt, el, ctx) {
    const prev = this.t;
    const target = this._target(el, ctx);
    if (el.paused || el.seeking || el.readyState < 2) {
      this.jumped = Math.abs(target - this.t) > 1e-3;
      this.t = target;
    } else {
      const next = this.t + dt * (el.playbackRate || 1);
      const drift = target - next;
      if (Math.abs(drift) > SCORE_CONFIG.DRIFT_SNAP) {
        this.t = target;
        this.jumped = true;
      } else {
        this.t = next + drift * (1 - Math.exp(-dt / SCORE_CONFIG.DRIFT_SLEW));
        this.jumped = false;
      }
    }
    // never run backwards in normal play (onset cursors rely on it)
    if (!this.jumped && this.t < prev) this.t = prev;
    if (this.jumped) this.jumpId++;
    this._lastTarget = target;
    return this.t;
  }

  get drift() {
    return this._lastTarget - this.t;
  }
}

// =================================================================== Performance

/** The blended, per-frame view of the music that scenes read as `audio.perf`. */
export class Performance {
  constructor(audio = defaultAudio) {
    this.audio = audio;
    this.map = null;
    this.follower = new ScoreFollower();
    this.source = 'idle';
    this.t = 0;
    this.level = 0;
    this.drive = 0;
    this.rise = 0;
    this.climax = 0;
    this.mood = 0;
    this.stage = 'calm';
    this.ending = false;
    this.section = null;
    this.next = null;
    this.timeToNext = Infinity;
    this.progress = 0;
    this.sectionId = 0;
    this.onsets = [];
    this.upcoming = [];
    this.cues = [];
    this.height = 0.5;
    this.heightConf = 0;
    this.pitchHz = 0;
    this.chroma = new Float32Array(12);
    this.key = { name: '', tonic: 2, mode: 'major' };
    this.keyId = 0;
    this.beatPhase = 0;
    this.beatId = 0;
    this.jumpId = 0;
    this.bass = 0;
    this.mid = 0;
    this.treble = 0;
    this.presence = 0;
    this._sectionIndex = -1;
    this._keyStart = -1;
    this._beatIndex = -1;
    // live fallback state
    this._lastOnsetId = 0;
    this._lastMelodyId = 0;
    this._liveSlow = 0;
    this._livePrev = 0;
    this._climaxTimer = 0;
    this._stageTime = 0;
    this._liveStage = 'calm';
  }

  /** Use the analysis `map` (or null) for the piece now loaded in the audio element. */
  setMap(map) {
    this.map = map;
    this._sectionIndex = -1;
    this._keyStart = -1;
    this._beatIndex = -1;
    this.follower.jumped = true;
  }

  update(dt) {
    const a = this.audio;
    this.presence = a.presence;
    this.bass = a.bass;
    this.mid = a.mid;
    this.treble = a.treble;
    this.onsets.length = 0;
    this.cues.length = 0;
    this.upcoming.length = 0;
    const scored = this.map && a.mode === 'file' && a.element;
    if (scored) this._updateScore(dt);
    else this._updateLive(dt);
  }

  // ----------------------------------------------------------------- score

  _updateScore(dt) {
    const a = this.audio;
    const m = this.map;
    const C = SCORE_CONFIG;
    const prevT = this.t;
    const t = this.follower.update(dt, a.element, a.ctx);
    const jumped = this.follower.jumped;
    const playing = !a.element.paused;
    this.source = 'score';
    this.t = t;
    if (jumped) this.jumpId++;

    // loudness, anticipation, climax
    const raw = m.sample(m.level, t);
    this.level = sCurve(raw);
    const L = C.LOOKAHEAD;
    const ahead = m.maxAhead(m.level, t, t + L, (d) => 1 - (1 - C.DRIVE.AHEAD_WEIGHT) * (d / L) - 0.25 * (d / L) ** 2);
    const target = Math.max(this.level, sCurve(ahead));
    // in silence (paused) the scene keeps the moment's look, without anticipation
    const driveTarget = playing ? target : this.level;
    this.drive = jumped ? driveTarget : follow(this.drive, driveTarget, dt, C.DRIVE.ATTACK, C.DRIVE.RELEASE);
    const slowNow = m.sample(m.slowLevel, t);
    this.rise = clamp01((m.maxAhead(m.slowLevel, t, t + L) - slowNow) * 3);
    this.climax = m.sample(m.climaxCurve, t + C.CLIMAX.LEAD);

    // structure
    const si = m.sectionIndexAt(t);
    const s = m.sections[si];
    if (si !== this._sectionIndex) {
      this._sectionIndex = si;
      this.sectionId++;
    }
    this.section = s;
    this.next = m.sections[si + 1] ?? null;
    this.timeToNext = this.next ? this.next.start - t : Infinity;
    this.progress = clamp01((t - s.start) / Math.max(1e-3, s.end - s.start));
    this.stage = s.role === 'swell' ? (t < s.peakAt ? 'building' : 'resolving') : s.stage;
    this.ending = s.role === 'fade';
    const cross = this.next ? clamp01(1 - this.timeToNext / L) : 0;
    const blend = cross * cross * (3 - 2 * cross);
    this.mood = s.mood + ((this.next?.mood ?? s.mood) - s.mood) * blend;

    // melody, harmony, beat
    this.height = m.sample(m.height, t);
    this.heightConf = m.sample(m.heightConf, t);
    this.pitchHz = m.sample(m.hz, t);
    m.chromaAt(t, this.chroma);
    const key = m.keyAt(t);
    if (key && key.start !== this._keyStart) {
      this._keyStart = key.start;
      this.keyId++;
      this.key = { name: key.key, tonic: key.tonic, mode: key.mode };
    }
    const bi = upperBound(m.beats, t) - 1;
    if (bi !== this._beatIndex) {
      if (!jumped && bi > this._beatIndex) this.beatId++;
      this._beatIndex = bi;
    }
    const b0 = m.beats[bi] ?? 0;
    const b1 = m.beats[bi + 1] ?? b0 + 1;
    this.beatPhase = clamp01((t - b0) / Math.max(1e-3, b1 - b0));

    // events: what sounded since the last frame (not after a seek), and what comes next
    if (!jumped && playing && t > prevT) {
      for (let i = upperBound(m.onsets, prevT, (o) => o.t); i < m.onsets.length && m.onsets[i].t <= t; i++) this.onsets.push(m.onsets[i]);
      for (let i = upperBound(m.cues, prevT, (c) => c.t); i < m.cues.length && m.cues[i].t <= t; i++) this.cues.push(m.cues[i]);
    }
    if (playing) {
      for (let i = upperBound(m.onsets, t, (o) => o.t); i < m.onsets.length && m.onsets[i].t <= t + C.ONSET_WINDOW; i++) {
        this.upcoming.push({ ...m.onsets[i], in: m.onsets[i].t - t });
      }
    }
  }

  // ------------------------------------------------------------------ live

  _updateLive(dt) {
    const a = this.audio;
    const L = SCORE_CONFIG.LIVE;
    this.source = a.mode === 'mic' || a.mode === 'file' ? 'live' : 'idle';
    this.t = a.mode === 'file' ? a.currentTime : this.t + dt;
    this.level = sCurve(a.level);
    // slope of a slowly smoothed level -> "a crescendo is under way"
    this._liveSlow = follow(this._liveSlow, this.level, dt, 1.2, 1.2);
    const slope = (this._liveSlow - this._livePrev) / Math.max(dt, 1e-3);
    this._livePrev = this._liveSlow;
    this.rise = follow(this.rise, clamp01(slope * L.RISE_GAIN), dt, 0.3, 1.0);
    this.drive = follow(this.drive, clamp01(this.level + 0.3 * this.rise), dt, SCORE_CONFIG.DRIVE.ATTACK, SCORE_CONFIG.DRIVE.RELEASE);
    this.mood = follow(this.mood, this.level, dt, L.MOOD, L.MOOD);

    // stage with hysteresis and a minimum hold, so it changes like a section would
    this._climaxTimer = this.level > L.CLIMAX_ENTER ? this._climaxTimer + dt : 0;
    this._stageTime += dt;
    let stage = this._liveStage;
    if (stage === 'climax') {
      if (this.level < L.CLIMAX_EXIT) stage = 'resolving';
    } else if (this._climaxTimer > L.CLIMAX_HOLD) stage = 'climax';
    else if (this._stageTime > L.MIN_STAGE) {
      if (this.rise > 0.15) stage = 'building';
      else if (this.mood < L.CALM) stage = 'calm';
      else if (slope < -0.02) stage = 'resolving';
    }
    if (stage !== this._liveStage) {
      this._liveStage = stage;
      this._stageTime = 0;
      this.sectionId++;
    }
    this.stage = stage;
    this.ending = false;
    this.climax = follow(this.climax, stage === 'climax' ? 1 : 0, dt, 1.5, 5);
    this.section = null;
    this.next = null;
    this.timeToNext = Infinity;
    this.progress = 0;

    this.height = a.pitchHeight;
    this.heightConf = a.pitchConfidence;
    this.pitchHz = a.pitchHz;
    this.chroma.set(a.chroma);
    if (this.key.tonic !== a.dominantNote) {
      this.key = { name: NOTE_NAMES[a.dominantNote], tonic: a.dominantNote, mode: '' };
      this.keyId++;
    }
    this.beatPhase = 0;
    if (a.beatId !== this._liveBeat) {
      this._liveBeat = a.beatId;
      this.beatId++;
    }
    if (a.onsetId !== this._lastOnsetId) {
      this._lastOnsetId = a.onsetId;
      const melody = a.melodyNoteId !== this._lastMelodyId;
      this._lastMelodyId = a.melodyNoteId;
      const strength = clamp01(0.3 + 0.7 * a.level);
      this.onsets.push({ t: this.t, strength, height: a.pitchHeight, melody, accent: strength > 0.8 });
    }
  }

  /** Readable state for the debug overlay. */
  get summary() {
    const s = this.section;
    return {
      source: this.source,
      section: s ? `${s.index} ${s.label} (${s.role})` : this.stage,
      stage: `${this.stage}${this.ending ? ' · ending' : ''}`,
      next: this.next ? `${this.next.role} in ${this.timeToNext.toFixed(1)} s` : '-',
    };
  }
}
