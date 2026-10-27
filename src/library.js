import library from 'virtual:music-library';
import { PIECES, MUSIC_DIR, ANALYSIS_DIR, pieceForFile, pieceForScene } from './pieces.js';
import { ScoreMap } from './scoreMap.js';

/**
 * library.js: finds each scene's piece in /public/Music and keeps the score
 * follower (audio.perf) pointed at the analysis of whatever is playing.
 *
 * A library piece always gets its analysis. A dropped file gets it too when
 * its name matches a piece AND its length matches the analysed recording
 * (another recording of the same piece would be out of sync); anything else,
 * and the microphone, runs on live analysis only.
 */

const DURATION_TOLERANCE = 2; // s
const base = import.meta.env.BASE_URL;
const files = PIECES.map((p) => [p.id, library.music.find((f) => p.match.test(f.normalize('NFC')))]);

/** URL of a piece's audio file, or null when it is not in /public/Music. */
export function pieceUrl(piece) {
  const file = files.find(([id]) => id === piece?.id)?.[1];
  return file ? `${base}${MUSIC_DIR}/${encodeURIComponent(file)}` : null;
}

export const hasAnalysis = (id) => library.analysis.includes(`${id}.json`);

/** The piece bound to scene `index`, if its audio is available. */
export function availablePiece(index) {
  const piece = pieceForScene(index);
  return piece && pieceUrl(piece) ? piece : null;
}

const cache = new Map();
function loadMap(id) {
  if (!cache.has(id)) {
    cache.set(
      id,
      ScoreMap.load(`${base}${ANALYSIS_DIR}/${id}.json`).catch((err) => {
        console.warn(`[resonance] analysis for "${id}" unavailable; live analysis only`, err);
        cache.delete(id);
        return null;
      }),
    );
  }
  return cache.get(id);
}

export function playPiece(audio, piece) {
  return audio.useUrl(pieceUrl(piece), `${piece.title} · ${piece.composer}`, piece.id);
}

/** Keeps `perf` on the right analysis as sources change. */
export function connectLibrary(audio, perf) {
  let current = ''; // src the decision was made for
  let request = 0;
  audio.onChange(async () => {
    const el = audio.element;
    if (audio.mode !== 'file' || !el) {
      if (current) perf.setMap(null);
      current = '';
      return;
    }
    if (el.src === current || !isFinite(el.duration)) return; // wait for the metadata
    current = el.src;
    const id = audio.pieceId ?? pieceForFile(audio.fileName)?.id;
    const mine = ++request;
    perf.setMap(null);
    if (!id || !hasAnalysis(id)) return;
    const map = await loadMap(id);
    if (mine !== request || !map) return;
    if (Math.abs(map.duration - el.duration) > DURATION_TOLERANCE) {
      console.info(`[resonance] "${audio.fileName}" is ${el.duration.toFixed(1)} s, the analysis is ${map.duration.toFixed(1)} s: live analysis only`);
      return;
    }
    perf.setMap(map);
  });
}
