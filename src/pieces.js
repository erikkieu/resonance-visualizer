/**
 * pieces.js: which piece of music each scene performs.
 *
 * Audio lives in /public/Music (gitignored, never committed); a file is
 * matched by `match` against its name, so the exact spelling (and the Unicode
 * normalisation macOS gives "ä") does not matter. The offline analysis
 * (`npm run analyze`) writes /public/analysis/<id>.json for every piece it
 * finds. Plain ESM with no Vite imports: scripts/analyze.mjs reads it too.
 * `bpm` (optional) tells the beat tracker which metrical level is the beat.
 */
export const MUSIC_DIR = 'Music';
export const ANALYSIS_DIR = 'analysis';

export const PIECES = [
  {
    id: 'drottningholm',
    scene: 0,
    title: 'Drottningholmsmusiken',
    composer: 'Johan Helmich Roman',
    bpm: 56,
    match: /^1\.|drottningholm/i,
  },
  {
    id: 'standchen',
    scene: 1,
    title: 'Ständchen',
    composer: 'Schubert / Liszt',
    bpm: 50,
    match: /^2\.|st(a|ä)ndchen/i,
  },
  {
    id: 'andante-festivo',
    scene: 2,
    title: 'Andante Festivo',
    composer: 'Jean Sibelius',
    match: /^3\.|andante festivo/i,
  },
  {
    id: 'kleine-nachtmusik',
    scene: 3,
    title: 'Eine kleine Nachtmusik · I. Allegro',
    composer: 'W. A. Mozart',
    match: /^4\.|nachtmusik/i,
  },
  {
    id: 'interstellar',
    scene: 4,
    title: 'Interstellar',
    composer: 'after Hans Zimmer',
    match: /^5\.|interstellar/i,
  },
];

/** The piece bound to scene `index`, or undefined. */
export const pieceForScene = (index) => PIECES.find((p) => p.scene === index);

/** The piece a file name belongs to, or undefined. */
export const pieceForFile = (name) => PIECES.find((p) => p.match.test(name.normalize('NFC')));
