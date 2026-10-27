# Resonance: notes for Claude

A five-scene WebGL music visualizer (Vite, vanilla ES modules, Three.js, custom GLSL). Each scene **performs one specific piece**: an offline analysis of the piece plus a runtime score follower drive structure and anticipation, and the live Web Audio analyser adds fine detail (and is the only input for the mic or an unknown file).

## Rules

- **Never commit audio.** Pieces live in `public/Music/` (gitignored by extension: mp3/wav/flac/ogg/m4a/aac/webm). Don't move, rename or re-encode them; `src/pieces.js` matches files by leading number / name.
- `public/analysis/*.json` is derived data and fine to commit. Regenerate it with `npm run analyze`; that **keeps the hand-edited `manual` block** of each JSON.
- Commit or push only when the user asks. Build on the user's own work in the scenes and shaders; don't revert it.
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
| 2 | Aurora (`Scene2Aurora.js`) | Schubert/Liszt, *Ständchen* (`2. …`, filename is NFD Unicode), ~6:05, ~50 bpm | `profiles/standchen.js` |
| 3 | Starry Night (`Scene3StarryNight.js`) | Sibelius, *Andante Festivo* (`3. …`), ~4:05 | `profiles/andanteFestivo.js` |

**Swapped 2026-10-27 (user):** the visuals of keys 2 and 3 traded places; the pieces stayed on their keys. A profile is shaped for its *scene* (the Starry-shaped profile is now `andanteFestivo.js`, the Aurora-shaped one `standchen.js`); their numbers were carried over from the old piece and only the notes were rewritten, so both may want retuning by ear. The T-panel storage keys (`resonance.tune.starry` / `.aurora`) follow the scene.
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

- **Scene 3 / Starry Night (now Andante Festivo; mappings below were written for the Ständchen):** drive → flow speed (FREEZE 0.04 … MAX 2.4, swell hysteresis 0.8/0.62); exposure 0.5 (quiet) → 1.0, ×1.1 at the climax; melody height → spiral/moon lift (0.07) and light colour (violet → cobalt → sky → pale yellow → white); minor/major tints violet/gold; melody notes bloom a star at the note's height (never the same star twice, soft painted halo); other onsets make faint sky-blue ripples (≤ 9/s); the climax opens the sky (all strokes, glow ×1.9). Burst strokes are spread over a disc, not a ring (hard rings looked like UI).
- **Scene 1 / Drottningholm:** a tide clock (rise 1.2 s, fall 4 s, curve 1.25); stages scale speed, pours, swirl, paint and bloom size (hush: speed ×0.55, pours ×0.3); score onsets bloom notes at their own pitch (≤ 7/s); key change → colour burst (D azure, F# violet-blue, A gold, B purple, E white) and a slow hue turn; the last climax section → expansive pours from below; exposure 0.62 → 1.0. Live input keeps the scene's original behaviour (but does get the journey, see below).

- **Scene 5 / Interstellar:** `build` (drive^1.4, attack 2.5 s / release 4 s) → scene clock (0.06 → 1.6), core glow, bloom, exposure (0.6 → 1.05), star density (75 → 100%); the galaxy spins slowly in wall-clock time and tilts / leans / grows with the music (see the Scene 5 notes below); the camera stays fixed and only dollies back ×1.2 at full `open` = max(stage.pull × build, climax); score beats → faint shockwave rings (none below drive 0.25, scaled by `PULSE`).
- **Scene 2 / Aurora (now Ständchen; mappings below were written for the Andante Festivo):** `build` (drive^1.6) → curtain height/width/coverage/brightness/fold via new aurora uniforms (`uHeight uWidth uCover uFold uBright uWarm`); the climax warms green toward gold; accented onsets → a soft shimmer and colour surge. The climax was blown out to white; it was capped (BRIGHT FULL 0.85 / CLIMAX 0.25, COVER ≤ ~0.9, EXPOSURE CLIMAX 0.05). **Verified with the Ständchen (2026-10-27): its climax (~4:51) still washes half the frame to white-grey.** Lowering the profile's BRIGHT/COVER/HEIGHT/EXPOSURE barely changed it, so the cause is inside the scene/shader (live energy and bass gain on the curtains, bloom), not the profile. Not fixed yet.
- **Scene 4 / Mozart:** still on the old live mappings (energy → speed, bass → flicker, treble → grain, beat → exposure flash). To do: motion locked to the score's beats, accents flicker the exposure, contrast and grain follow quick vs lyrical passages.
- **Scene 5 / Interstellar, resonant stars** (`PROFILE.RESONANCE`, added 2026-10-27): 9000 extra stars at log-uniform depths 80–1200 (near = bigger/brighter), 35 % tuned to one of 8 log-spaced bands (40 Hz–10 kHz) of the live spectrum. Band value = 0.6 × loudest bin + 0.4 × mean (the mean alone missed a clear 6 kHz tone), compared with its own 3 s average and decaying peak, so a star glows when *its* band comes forward. Tints warm (low) → ice blue (high); glow ×4.5, size ×2 at full response. Checked headless with low/700 Hz/6 kHz test tones: each lights only its own bands, 60 fps.
- **Scene 5 calm view (user decision 2026-10-27: the orbiting camera made them feel sick):** fixed viewpoint (`CAMERA.ORBIT` 0, `SWAY` 0, `RISE` 0, `PARALLAX` 0.25), so the sky stands still; the climax only dollies straight back. Galaxy turn `ROTATION` 0.01 (was 0.045): ~3° per 5 s at normal speed. Don't reintroduce camera orbit or tilt.
- **Scene 5 body motion (user decision 2026-10-27: less pulsing; the galaxy should turn and grow with the music, slow and seamless):** stars, dust and rings sit in `this.body`, which `_moveBody` tilts about the viewer's axes and scales, all on critically damped springs (`MOTION.PERIOD` 12 s, `SIZE_PERIOD` 10 s; no overshoot, smooth after seeks). Tilt toward the viewer: build −0.12 → 0.3 rad, +0.12 at the climax, ±0.12 with the melody height. Sideways lean: spectral centroid of the 8 resonant bands vs its own 25 s average (`BALANCE_*`), tanh-limited to `ROLL` 0.3 rad. Plus a ~1–2 min `WANDER` of 0.05 rad. Size 0.82 → 1.12 (+0.1 climax); camera `PULL` cut to 0.2 so the growth isn't cancelled. `PULSE` 0.2 scales bass breathing, mid ripples, the core's bass/beat flicker, the sky's bass glow and the beat rings. Measured with a quiet → loud test tone: tilt −3° → 26°, size 0.86 → 1.22, max 1° change per 0.25 s, 60 fps.
- **Scene 5 round 3 (user, 2026-10-27):** pulsing must be *subtle*: `PULSE` 0.08, `SPARKLE` 0.35 (treble twinkle on galaxy + background), `BUILD.ATTACK` 2.5 s (light pumped with the pattern), `STARS.QUIET` 0.75 (stars popping in/out read as pulsing). The galaxy **always spins slowly** in wall-clock time: `SPIN.BASE` 0.014 rad/s (~0.8°/s) + `MUSIC` 0.008 × build, eased over 5 s (replaced `ROTATION`, which nearly stopped in quiet parts). **Shooting stars** (`METEORS`, `_meteors`): **only when the music plays strongly** (user, same day): none while max(build, climax) < `THRESHOLD` 0.4; above it a charge fills at 1 / gap (gap 20 s → 5 s with loudness, randomised ×0.6–1.4), and strong accents (`accent` or strength ≥ 0.7) may launch one once loudness ≥ `ACCENT` 0.3; never closer than `MIN_GAP` 4 s; louder = brighter and longer. Test (quiet 20 s → loud 25 s): none while quiet, first 2.6 s into the loud part. Random screen spot, mostly falling diagonally, streak quads placed in camera space at depth 300 (`matrixAutoUpdate` off, so `matrixWorldNeedsUpdate` must be set). **Stardust** (`STARDUST`, `buildStardust`): 60k tiny faint points at 900–1400 in the galaxy's palette, 45 % in a soft tilted band; uses the shared starfield material.
- **Scene 5 disk occlusion (user, 2026-10-27: "not so many stars in front of the galaxy"):** `occlude.glsl` is prepended to `stars.vert` and `resonant.vert`; each background star casts a ray to the camera and dims by `OCCLUDE.AMOUNT` 0.92 if it crosses the galaxy disk (normal and radius follow the tilting/growing body, radius ×1.15, soft from 0.45 to 1.0 of it). Verified with the galaxy hidden: background stars vanish behind the disk area. Most of the remaining grain over the galaxy is its own particles; the user didn't pick that as the problem, so the galaxy's particle layout is unchanged.
- **Scene 5: no moon.** Two moons were tried on 2026-10-27 and both rejected by the user: a shader-drawn one ("didn't like how it looked") and the user's own photo cut out to transparency, floating in an arc left → right over 100 s ("didn't turn out well either"). All moon code, shaders, config and the cut-out PNG were removed. Don't add a moon again unless the user asks.
- **Scene 5: no asteroids.** Asteroids cut out of a user-supplied picture, drifting past behind the galaxy at different depths, were tried on 2026-10-27 and removed at the user's request ("ta bort meteorerna": the user calls them meteors; the shooting stars stayed). Code, shaders and the cut-out PNG are gone.
- **Scene 5 light points (user, 2026-10-27, replacing the asteroids):** `LIGHTS` + `_lights`, `light.vert/frag`. Now and then (every 25–50 s, first at 8 s; pool of 2) a strong point of light floats from off-screen left or right to the other side in ~60 s (±20 %), in a gentle curve at random heights, breathing ±15 %. Hot core (`BRIGHT` 4, blooms), soft halo (`SIZE` 0.08 × screen height), faint four-point diffraction spikes; tint white / ice blue / warm. Additive, camera space at depth 800, renderOrder 2, hidden by the disk via `diskShadow`. A first version (`BRIGHT` 2.4, `SIZE` 0.05) read as just another star. Verified: first at 8 s, ~115 px per 5 s at 1280×720, 60 fps. **Then (same day): it blinks and floats.** `BLINK` {ON 4, OFF 6, FADE 1}: fade in 1 s, shine 4 s, fade out 1 s, dark 6 s (12 s cycle, smoothstep fades, the drift goes on while dark). `WANDER` {X 0.12, Y 0.22, PERIOD 14–32 s}: per light two sine waves per axis on top of the slow drift (x wander < drift speed, so it eases and hurries but never turns back; waves start at 0 so it still enters off screen); base heights kept within ±0.55 so the wander stays on screen. Measured: on 4 s / dark 6 s exactly, x speed 18–38 px/s, y floating ±70 px. **Then: several, from every side (user, same day).** `POOL` 3 = at most three on screen; a new one only `GAP` 15 s after the last came in (and only with a free slot); **one strong at a time**, the others `FAINT` (brightness ×0.4, size ×0.7). Each enters just off screen on a random edge (left/right weigh 1, top/bottom 0.7) and drifts to another edge (opposite 60 %, paths shorter than 1.8 half-screen units rejected) at the speed of crossing the width in `CROSS` s; the wander is along the path (eased by sin(πp)) and across it. Simulated 3.5 min at 6× clock: max 3 at once, gaps ≥ 15 s, entries from all four sides, one strong at a time.

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

`1`–`5` scenes (1 Liquid Paint, 2 Aurora, 3 Starry Night, 4 Stockholm, 5 Galaxy) · `P` play the current scene's piece (or play/pause it) · `Space` play/pause · `F` fullscreen · `H` hide UI · `D` debug overlay + score timeline (click the timeline or a section button to seek; **Shift+0…9** jumps to 0 %…90 % of the piece) · `T` tuning sliders for the current scene/profile · drag (Scene 1) pours paint · mouse (Scenes 3, 5) parallax / pushes strokes.

## Status (2026-10-27)

Done and verified (60 fps, 0 console errors, build starts before the loudest point): the pipeline, the score follower, the debug timeline, Scene 1 and Scene 5; after the swap, Scene 3 (Starry Night / Andante Festivo: climaxes bright, not blown out) and Scene 2 (Aurora / Ständchen) apart from its washed-out climax. Scene 1's journey (dark background, travelling swirl colours) is verified with `--journey`; awaiting the user's feedback. Scene 4 is not started. README.md has the swapped scene order but not the score-following / journey features yet.
