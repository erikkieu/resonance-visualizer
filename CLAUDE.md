# Resonance: notes for Claude

A five-scene WebGL music visualizer (Vite, vanilla ES modules, Three.js, custom GLSL). Each scene **performs one specific piece**: an offline analysis of the piece plus a runtime score follower drive structure and anticipation, and the live Web Audio analyser adds fine detail (and is the only input for the mic or an unknown file).

## Rules

- **Never commit audio.** Pieces live in `public/Music/` (gitignored by extension: mp3/wav/flac/ogg/m4a/aac/webm). Don't move, rename or re-encode them; `src/pieces.js` matches files by leading number / name.
- `public/analysis/*.json` is derived data and fine to commit. Regenerate it with `npm run analyze`; that **keeps the hand-edited `manual` block** of each JSON.
- Commit or push only when the user asks. The user has uncommitted work of their own in `Scene1Fluid.js`, `Scene2StarryNight.js` and the starry/fluid shaders: build on it, don't revert it.
- Keep every tuning constant in one config object per scene/profile, with the important ones exposed as live sliders (T panel).
- Match the existing style: long explanatory header comment per file, short "why" comments, `CONFIG`/`PROFILE` objects in CAPS at the top.
- Verify visual changes by looking (see "Verifying"), not only by reading numbers.

## Commands

```bash
npm run dev                         # http://localhost:5173 (?debug exposes window.__resonance)
npm run analyze [-- <id>]           # offline analysis -> public/analysis/<id>.json + printed summary (needs ffmpeg)
npm run verify -- <id> [--quick] [--seq start,end] [--out dir]   # headless Chrome screenshots + checks
npm run verify -- drottningholm --journey [--out dir]            # Scene 1 journey: numbers at 10 times, 5 screenshots, trend checks
npm run build                       # GitHub Pages build (base /resonance-visualizer/)
```

`verify` uses Playwright's Chromium if installed, else the system Google Chrome (`channel: 'chrome'`, Metal GPU, ~60 fps headless on the M4). It defaults to writing to `.verify/` (gitignored); during sessions pass `--out` to the scratchpad.

## Piece ↔ scene binding (`src/pieces.js`)

| Key | Scene | Piece (file in `public/Music/`) | Profile |
| --- | --- | --- | --- |
| 1 | Liquid Paint (fluid pour) | Roman, *Drottningholmsmusiken* (`1. …`), ~7:14, ~56 bpm | `profiles/drottningholm.js` |
| 2 | Starry Night | Schubert/Liszt, *Ständchen* (`2. …`, filename is NFD Unicode), ~6:05, ~50 bpm | `profiles/standchen.js` |
| 3 | Aurora | Sibelius, *Andante Festivo* (`3. …`), ~4:05 | `profiles/andanteFestivo.js` |
| 4 | Stockholm (silent film) | Mozart, *Eine kleine Nachtmusik* **I. Allegro only** (`4. A1-Allegro.mp3`, confirmed by user, no Romanze) | **not done yet** |
| 5 | Galaxy | `5. quentingaming-interstellar-580133.mp3`: an Interstellar-style track, **not** Zimmer's *Day One*; user said use it as-is | `profiles/interstellar.js` |

`bpm` in `pieces.js` is a beat-level hint for the tracker (Drottningholm 56, Ständchen 50).

## Architecture

```
scripts/analyze.mjs   offline analysis (ffmpeg decode -> own FFT; no Python deps)
scripts/verify.mjs    Playwright visual verification
src/pieces.js         piece manifest (plain ESM, also imported by the scripts)
src/library.js        finds pieces/analyses via virtual:music-library, plays a piece, points audio.perf at the right analysis
src/audio.js          live Web Audio analyser singleton (bass/mid/treble/energy, onsets, pitchHeight, chroma, level, presence ...)
src/scoreMap.js       ScoreMap (analysis + time queries), ScoreFollower (drift-free clock), Performance (= audio.perf)
src/SceneManager.js   scene registry, lazy loading, 1.2 s crossfade, adaptive quality
src/main.js           renderer, frame loop: audio.update -> perf.update -> manager.update/render
src/ui.js             DOM chrome, scene buttons, "play this scene's piece" offer, transport, drag & drop
src/debug.js          D overlay (live values + perf values + scene `debug` getter)
src/timeline.js       score timeline in the D overlay (sections, loudness, onsets, look-ahead, section jump buttons)
src/tune.js           T slider panel; configParams()/bindConfig() bind nested profile constants live
src/scenes/SceneN*.js scenes; src/scenes/profiles/*.js per-piece musical mappings
src/shaders/**        GLSL (imported ?raw)
vite.config.js        folderListing() virtual modules: virtual:texture-plates, virtual:music-library
```

### Scene interface (`SceneBase.js`)

`async init(renderer)`, `update(dt, audio)`, `render(target|null)`, `resize(w, h)`, `setQuality(level 0..3)`, `dispose()`. Properties read by the manager: `renderScale`, `toneMapped`, `exposure` (a linear multiplier in the final composite). An optional `get debug()` returns rows for the D overlay. Scenes run their own clock (`this.time`) and should read the music from **`audio.perf`**, which falls back to live analysis when there is no score.

### `audio.perf` (Performance, `src/scoreMap.js`)

`source` ('score' | 'live' | 'idle'), `t`, `level` (per-piece, S-curved), `drive` (level with look-ahead: rises before a crescendo, fast attack / slow release; **the main intensity knob**), `rise`, `climax` (0..1 envelope, already rising during the build), `section`/`next`/`timeToNext`/`progress`, `stage` ('calm' | 'building' | 'climax' | 'resolving'), `ending`, `mood`, `sectionId`, `onsets` (fired this frame: `{t, strength, height, melody, accent}`), `upcoming` (next 0.2 s), `height`/`heightConf`/`pitchHz`, `chroma`, `key`/`keyId`, `beatPhase`/`beatId`, `cues`, `jumpId` (increments on a seek: scenes snap their smoothing), plus the live `bass/mid/treble/presence`.

Role → stage: hush→calm, build→building, swell→building before its peak / resolving after, climax→climax, release→resolving, fade→resolving (+`ending`).

Clock sync: element `currentTime` minus `outputLatency + baseLatency`; drift above 0.25 s snaps (counted as a seek, so missed onsets aren't replayed); smaller drift slews over 0.4 s. Measured drift after seeks: 2–3 ms.

A dropped file uses an analysis only if its name matches a piece **and** its duration is within 2 s of the analysis; otherwise live only.

### Per-scene profile pattern

Every profile has `STAGES` (multipliers per stage, cross-faded into the next section during the last LOOKAHEAD seconds, smoothed over `STAGE_BLEND`), drive→parameter curves (`QUIET`/`FULL`/`CLIMAX`), an exposure curve (quiet must look truly quiet), onset events, and a `TUNE` list for the T panel. In each scene, `jumped = perf.jumpId !== this.jumpId` snaps smoothing after seeks, and `presence` blends back to the scene's original idle look when nothing plays.

## Settled thresholds

**Analysis (`scripts/analyze.mjs` CONFIG):** decode 22050 Hz mono; FFT 2048 / long FFT 4096; hop 512 (23 ms; onsets keep this precision), curves written every 2nd hop (~46 ms), chroma every 4th. Loudness is A-weighted, 0.4 s short-term and 3 s slow; `level` maps **p5 → 0 and p99 → 1** (`loudness.range`). Silence is below -70 dBFS. Melody: harmonic summation C3–G6, Viterbi path with a top-voice bias, confidence mapped from a salience ratio of [2.0, 4.5]. Key: Krumhansl over 15 s windows with a 5 s hop, switch penalty 0.12, regions ≥ 10 s. Sections: Foote novelty (10 s kernel) plus loudness change, target ~35 s each, MIN_LEN 12 s, **MAX_LEN 60 s** (longer ones are split), final fade = after the last slow level ≥ 0.5 (≥ 6 s). A last section that peaks in its second half (peak ≥ 0.7) is a **finale climax**, not a fade. Swell = rise and fall ≥ 0.2 with the peak in the middle 40%. Secondary climax needs level ≥ 0.7.

**Runtime (`SCORE_CONFIG`):** LOOKAHEAD 1.5 s, ONSET_WINDOW 0.2 s, S_CURVE 1.3, DRIVE attack 0.12 s / release 1.4 s, CLIMAX lead 0.8 s and hold 3 s / decay 6 s; lesser climaxes are weighted by `((level - 0.7) / (top - 0.7))²`. A melody note needs confidence ≥ 0.3 and a step ≥ 0.7 semitone (or strength ≥ 0.6 = accent).

## Audio → visual mappings (per profile)

- **Scene 2 / Ständchen:** drive → flow speed (FREEZE 0.04 … MAX 2.4, swell hysteresis 0.8/0.62); exposure 0.5 (quiet) → 1.0, ×1.1 at the climax; melody height → spiral/moon lift (0.07) and light colour (violet → cobalt → sky → pale yellow → white); minor/major tints violet/gold; melody notes bloom a star at the note's height (never the same star twice, soft painted halo); other onsets make faint sky-blue ripples (≤ 9/s); the climax opens the sky (all strokes, glow ×1.9). Burst strokes are spread over a disc, not a ring (hard rings looked like UI).
- **Scene 1 / Drottningholm:** a tide clock (rise 1.2 s, fall 4 s, curve 1.25); stages scale speed, pours, swirl, paint and bloom size (hush: speed ×0.55, pours ×0.3); score onsets bloom notes at their own pitch (≤ 7/s); key change → colour burst (D azure, F# violet-blue, A gold, B purple, E white) and a slow hue turn; the last climax section → expansive pours from below; exposure 0.62 → 1.0. Live input keeps the scene's original behaviour (but does get the journey, see below).

### Scene 1 journey (light swirls → deep blue / purple swirls)

A slow value `journey` (0 = start, 1 = end) gives the 7:14 piece a long-term arc on top of the live reactivity. **User decision (2026-10-27): the background stays dark for the whole piece; only the colour of the swirls travels**: white, yellow and light blues early → deeper, brighter blues and purple at the end, with yellow splashes throughout. (A first version also turned the ground from near-white to black; the user rejected that.) Everything is in `profiles/drottningholm.js`:

- `JOURNEY.KEYS`: `[time s, journey]` keyframes, monotone cubic between them: 0:00 0 · 1:30 0.15 · 2:20 0.25 · 3:30 0.45 · 4:30 0.6 · 5:10 0.7 · 5:47 0.75 · 6:30 0.9 · 7:14 1. `CLIMAX_LIFT` 0.15 × `perf.climax` lifts it back toward the light colours (reduced 60 % late, where `FLARE` adds blue-white paint + small glows). Live input / unknown file: the same curve paced by music heard (`DRIFT_SECONDS`), then back. Idle: `IDLE` 0.4. `FORCE ≥ 0` pins it (T slider "pin journey") to tune one palette.
- `PALETTES`: 5 stops (dawn 0, day 0.2, ocean 0.45, dusk 0.65, night 1), blended between the two nearest. All share the dark navy `ground` and dark veins (`lace` 0). Each has its own pitch `ramp` (this replaced `COLOUR.RAMP`); **every ramp starts dark navy / purple**, so low notes read as background and keep the canvas dark, and only mid/high notes carry the travelling colour. Also a lightness window `L` for note-family tints, `chroma`, family weight multipliers, `exposure`, `vignette`, `gold`, `glow`. `BRIGHT_FAMILIES: ['yellow']` keep their own lightness (squeezed darker, yellow turns olive). `YELLOW_SPLASH` [0.16, 0.1]: share of pours that are bright yellow splashes. `ACCENT`: rare cyan / ice-white notes late.
- `FEEL`: `[start, end]` pairs for dye fade (1.35 → 1.6: old paint must fade or the dense finale covers the dark ground), damping, clock speed, swirl, pour radius / force, bloom size, cells, lacing, and how much of the quiet-dims exposure curve applies.
- `FLOW` (diagonal current turning `TURN`°/s → spirals from journey 0.25–0.9), `WASH` (sweeps of the current palette every 6–10 s; key changes add one in the key's colour, and key bursts are pulled `BURST.PALETTE_PULL` toward the palette), `VIEW` (zoom 1 → 1.1 plus drift; the pointer is mapped through it), `CHOREO` (per-section seeded pour pattern: orbit / streams / scatter / spiral / drift, never one of the last 2), `REPAINT` (a seek that moves the journey > 0.06 fades old paint to 30 % and repaints in the new palette).
- Scene side: `_updateJourney` → `_applyJourney` (palette + feel + shader uniforms `cDeep cNavy uLaceLight uLaceAmt uVignette uView`), `_updateChoreo` / `_moveEmitters`, `_flow`, `_wash`, `_flareBurst`, `_repaint`. The D overlay shows journey (keys − lift), palette swatches + ground, a journey-curve SVG with the playhead, and the choreography.
- The display shader's hue bands (blue..purple, light yellow) still apply, so mint / turquoise only show as pale tints.

`npm run verify -- drottningholm --journey` prints per timestamp: journey, mean luminance, ground (darkest 25 %), swirls (brightest 25 %), dominant hue, yellow share, fps; checks the ground stays < 0.04, the swirl hue moves ≥ 20° toward blue / purple, and yellow remains late. Measured 2026-10-27: ground ≤ 0.031 everywhere; swirl hue 252° → 282°; yellow 12 % at 0:10, 0.1–0.6 % in the last four samples (small splashes); 60 fps, 0 errors.

## Controls

`1`–`5` scenes · `P` play the current scene's piece (or play/pause it) · `Space` play/pause · `F` fullscreen · `H` hide UI · `D` debug overlay + score timeline (click the timeline or a section button to seek; **Shift+0…9** jumps to 0 %…90 % of the piece) · `T` tuning sliders for the current scene/profile · drag (Scene 1) pours paint · mouse (Scenes 2, 5) parallax / pushes strokes.

## Status (2026-10-27)

Done and verified (60 fps, 0 console errors, build starts before the loudest point): the pipeline, the score follower, the debug timeline, Scene 2, Scene 1 and Scene 5. Scene 1's journey (dark background, travelling swirl colours) is verified with `--journey`; awaiting the user's feedback. Scene 3 is applied but its climax fix needs a re-run of `npm run verify -- andante-festivo`. Scene 4 is not started. README.md has not been updated for the new features yet.
