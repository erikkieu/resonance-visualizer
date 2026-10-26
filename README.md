# Resonance

A five-scene WebGL music visualizer built with Vite, vanilla JavaScript (ES modules), Three.js and custom GLSL. Each scene moves slowly and softly in quiet passages and speeds up as the music gets louder.

**Live demo:** https://erikkieu.github.io/resonance-visualizer/ (needs a browser with WebGL 2)

*Screenshot / GIF: coming soon.*
<!-- Add an image at docs/preview.gif (or .png) and replace the line above with:
![Resonance](docs/preview.gif) -->

| Key | Scene |
| --- | --- |
| `1` | **Liquid Paint**: a GPU fluid simulation rendered as a blue/teal acrylic pour |
| `2` | **Starry Night**: a living, brush-stroked painting inspired by Van Gogh (1889, public domain) |
| `3` | **Aurora**: aurora curtains over a fjord with snowy mountains and a mirrored reflection |
| `4` | **Stockholm**: a 1930s city square as flickering black-and-white silent film |
| `5` | **Galaxy**: a ~240k-particle spiral galaxy in a nebula-filled sky |

## Running it

Requires Node 20.19+ or 22.12+ and a browser with WebGL 2 (recent Chrome, Edge, Firefox or Safari).

```bash
npm install
npm run dev        # http://localhost:5173
```

```bash
npm run build      # static site in dist/, built for GitHub Pages under /resonance-visualizer/
npm run preview    # serve the build locally
```

**No audio is included** in this repository. Drop in your own audio file, use the microphone, or try **Demo** mode.

Microphone input needs a secure context, so use `localhost` or HTTPS. GitHub Pages serves over HTTPS, so the microphone works on the live demo too.

**Deploying:** every push to `main` builds the site and publishes it to GitHub Pages (`.github/workflows/deploy.yml`). If you fork it under another repository name, change `PAGES_BASE` in `vite.config.js` to match.

## Controls

- **1–5**: switch scene (1.2 s crossfade)
- **F**: toggle fullscreen
- **H**: hide or show all UI (the canvas stays visible)
- **D**: debug overlay for live tuning. It shows pitch height (with its frequency, peak-vs-centroid confidence and adaptive range), loudness, the dominant note with 12-bin chroma, and the scene's values. For Scene 1 that includes a swatch of the colour new paint is getting. It stays visible when the rest of the UI hides.
- **Space**: play or pause the loaded file
- **Drag on the canvas** (Scene 1): pour paint with the mouse or a finger
- **Move the mouse** (Scene 5): camera parallax

The UI auto-hides after 3 s without mouse movement and comes back when you move the mouse.

**Audio sources:**
- **Mic**: microphone via `getUserMedia`.
- **File**: file picker, or drag and drop an mp3/wav/ogg anywhere on the page. Comes with play/pause and a seek bar.
- **Demo**: a synthetic ~96 bpm groove whose loudness swells and recedes over 32 s, so every reaction is visible without real audio.

With no audible input, the scenes run on a gentle built-in "idle" signal, so they never freeze.

## How the audio drives the scenes

`src/audio.js` exports a singleton that analyses the input every frame (`AnalyserNode`, fftSize 2048, smoothing 0.8) and provides values in the range 0..1:

| Value | Source |
| --- | --- |
| `bass` | 20–150 Hz |
| `mid` | 150–2000 Hz |
| `treble` | 2–12 kHz |
| `energy` | overall RMS loudness |
| `beat` | onset pulse that jumps to 1 and decays; `beatId` increments once per beat |
| `presence` | 0 when nothing is playing, 1 while music (live input or demo) is audible; ramps slowly |
| `noteId` / `note` | broadband (150 Hz–6 kHz) note onsets from a second, lightly smoothed analyser; catches bowed, plucked and wind attacks without drums |
| `density` | notes per second, smoothed (~7 notes/s = 1) |
| `pitchHeight` | how high the melody is. Strongest peak in 150–2000 Hz from an 8192-point FFT, refined by parabolic interpolation, blending toward the spectral centroid when the peak isn't prominent. Log scale, fast attack (80 ms) / slow release (500 ms), stretched over the range heard in the last 20 s. Debug values: `pitchHz`, `pitchConfidence`, `pitchHeightRaw`, `pitchLo` / `pitchHi`. |
| `chroma` / `dominantNote` / `noteStrength` | 12-bin pitch-class profile (C…B), its strongest class (with a small hysteresis margin), and how clearly it stands out |

Processing details:
- Every value goes through attack/release smoothing (fast rise, slow fall).
- Each value is also normalized against an adaptive running maximum. The peak snaps up instantly and decays over ~10 s, so quiet and loud tracks both use the full range.
- Beats come from spectral flux on the low end, compared against an adaptive mean + standard deviation threshold.
- Pitch settings (`FMIN`, `FMAX`, smoothing times, window, confidence thresholds, chroma) live in `PITCH_CONFIG` at the top of `audio.js`.

**Core rule.** Every scene advances its own clock with

```
sceneTime += dt * (baseSpeed + speedGain * energy)
```

The speed multiplier is lerped toward its target, so motion never jerks (`src/scenes/SceneBase.js`). On top of that, each scene maps the bands as follows:

| Scene | energy | bass | mid | treble | beat |
| --- | --- | --- | --- | --- | --- |
| 1 Liquid Paint | via a slow "drive" (loudness + note density): simulation speed, pour rate and force; loudness also sets paint intensity and saturation | continuo pours from below | vorticity (curl) strength | tiny bright specks, more cells, glints | extra pours once the music has built up; each **note** leaves a curling flourish; **pitch height** colours all paint |
| 2 Starry Night | swirl rotation and flow speed; cypress sway | star halos and moon glow | brush-stroke turbulence | star twinkle | — |
| 3 Aurora | wave speed and brightness | curtains swell and flare upward | fold frequency | fine vertical rays, star twinkle | green-to-pink colour surge |
| 4 Stockholm | speed of trams, cars and pedestrians | light flicker, camera shake | — | grain, dust, scratches | exposure flash |
| 5 Galaxy | rotation speed, camera drift | core glow, arm expansion | ripples through the particles | star sparkle | shockwave rings travelling outward |

## The scenes

### 1 · Liquid Paint (`Scene1Fluid.js`, `shaders/fluid/`)

A real Navier–Stokes solver in the style of Pavel Dobryakov's *WebGL Fluid Simulation*. It uses half-float ping-pong targets for velocity, dye, pressure, divergence and curl. Each frame runs:

1. splat injection (batched, up to 12 Gaussian splats per pass)
2. curl
3. vorticity confinement
4. divergence
5. pressure (20 Jacobi iterations)
6. gradient subtraction
7. semi-Lagrangian advection of velocity and dye

**Colour follows the melody.** Every pour takes its colour from a ramp at the current `pitchHeight`:

| Height | Colour |
| --- | --- |
| 0 | deep purple `#2a0a4a` |
| 0.25 | dark navy `#0a1a5c` |
| ~0.5 | ocean blue → cyan |
| ~0.75 | light blue → mint |
| 1 | white with a hint of warm yellow `#fff8dc` |

- **Variation**: each pour gets a small random offset (±0.05 along the ramp).
- **Loudness**: scales paint amount, brightness and saturation, so loud high notes give the brightest whites and quiet low notes the deepest purples.
- **Hue shift**: the dominant pitch class adds a shift of up to ±15°, weighted by note strength.
- **Long pours**: colour is applied as the paint is released, so a long pour paints the melody's movement.
- **No recolouring**: paint already on the canvas keeps its colour and new paint mixes in.
- **Settings**: everything is in the `COLOUR` config at the top of `Scene1Fluid.js` (ramp stops, jitter, loudness ranges, hue shift).

The dye stores real colour, premultiplied by paint amount, in **Oklab**, a perceptual colour space, so mixes stay colourful like paint instead of averaging to grey as linear RGB does. `display.frag` then:
- keeps borders between pours crisp with an unsharp mask
- draws dark lacing where the colour changes quickly
- lights the paint amount as a glossy height field

Small multiplicative fades open "cells" in the paint.

**Motion.** Scene 1 is driven by a single smoothed value, `drive` = music presence × loudness:
- **No music**: the simulation clock runs at 10% and only faint ambient pours keep the paint drifting.
- **Music**: `drive` = presence × (70% loudness + 30% note density). It eases up over ~3 s and back down over ~5 s, through two cascaded smoothing stages.
- **What follows `drive`**: the clock, the pour rate and force, the swirliness, and how quickly motion settles.
- **No jolts**: every audio-driven pour releases its force and paint over a short window with a smooth envelope.

Tune it with `IDLE_SPEED`, `MUSIC_SPEED`, `DRIVE_RISE`, `DRIVE_FALL`, `DRIVE_FROM_ENERGY` and `DRIVE_FROM_DENSITY` at the top of `Scene1Fluid.js`.

**Tuned for Baroque music** (J.H. Roman's *Drottningholmsmusiken*, 1744): strings, winds and continuo, no drums, terraced forte/piano dynamics, and movements from Grave to Presto.
- **Busy vs. calm movements**: density lets a Presto swirl more than a Larghetto at the same volume.
- **Dynamics**: the normalizers have long memories (40 s for loudness), so a piano movement after a forte one stays calm.
- **Ornaments**: every articulated note leaves a small curling flourish along a travelling "phrase line", at a height that follows the pitch height and in that height's colour.
- **Continuo**: the bass line pours in from the lower part of the canvas.

### 2 · Starry Night (`Scene2StarryNight.js`, `shaders/starry/`)

Two passes:
- **`field.frag`** (low resolution) paints an underpainting. Brush direction comes from the stream function of several vortices, so strokes swirl around the great spiral, every star and the moon.
- **`strokes.frag`** lays three layers of oriented, tapered, slightly bent brush strokes over it, each sampling the underpainting once at its centre. Bristle grooves and screen-space-derivative lighting give an impasto ridge look.

Star cores and the village windows are added crisply on top. On portrait screens the painting is centre-cropped instead of squeezed.

### 3 · Aurora (`Scene3Aurora.js`, `shaders/aurora/`)

The curtains are thin folded sheets standing on a map. Their shapes live in a per-frame 4096×3 lookup texture (`curtains.frag`). `aurora.frag` marches upward through horizontal slices; every slice re-samples the same footprint, which stacks into vertical sheets in perspective, with a pink lower fringe, a green body and a violet crown.

Supporting passes:
- `terrain.frag` bakes the mountains and the Milky Way once per resize.
- `ambient.frag` averages the aurora light into a 1×1 texture that lights the snow, the shoreline and the rim of the foreground rocks.
- `landscape.frag` mirrors and ripples everything for the water.
- Bloom adds the glow.

### 4 · Stockholm (`Scene4Stockholm.js`, `shaders/stockholm/street.frag`)

A single ray-cast shader. It casts rays against the ground, two receding neoclassical facades and a far row of buildings with a clock tower (the clock shows your local time). Trams, cars, pedestrians (with a walk cycle and canes or umbrellas), lamps and bare trees are 2D silhouettes on vertical planes at fixed depths. That gives true perspective and parallax, with a per-pixel depth test sorting them. The scene also has cobblestones, rails, overhead wires and soft contact shadows.

The film treatment covers:
- sepia-tinted monochrome
- grain, flicker and gate weave
- scratches that persist for a few frames, plus dust and hairs
- vignette and rounded gate corners

Motion and film artefacts step at 18 fps, and the scene only re-renders when a new film frame starts.

**Optional photo plate:** put an image in `public/textures/` (for example `stockholm.jpg`) and it becomes the background plate, with the trams, cars and people layered over it. Images there are discovered at dev/build time through a tiny Vite plugin (`vite.config.js`), so nothing is fetched speculatively. That folder is git-ignored because photos are often copyrighted, so the published site always renders the street procedurally.

### 5 · Galaxy (`Scene5Galaxy.js`, `shaders/galaxy/`)

~240k `THREE.Points` particles with a custom shader and additive blending. Particles store orbits (radius, angle, height) on two logarithmic spiral arms rather than positions, so the vertex shader handles rotation, breathing, ripples and beat shockwaves.

The particle types are:
- a warm bulge
- old disk stars
- young blue-white stars
- pink HII clusters
- violet dust glow

Dark dust lanes are a second particle set drawn with multiplicative blending, so they absorb starlight. Behind the galaxy are:
- a teal/crimson fbm nebula, baked once into a cubemap
- three parallax starfield layers
- distant galaxies
- a bass-driven core glow
- shockwave rings

## Architecture

```
src/
  main.js            renderer (DPR ≤ 2), frame loop, keyboard/pointer, adaptive quality
  audio.js           Web Audio analysis singleton
  SceneManager.js    lazy scene loading, crossfade, final composite (ACES + sRGB + dither)
  ui.js              DOM chrome: buttons, transport, meter, overlay, drag and drop, auto-hide
  input.js           shared pointer state
  scenes/            SceneBase + Scene1Fluid … Scene5Galaxy
  gl/                FullscreenPass, render-target helpers, Bloom
  shaders/           GLSL, grouped per scene (imported with Vite's ?raw)
```

**Scene contract.** Every scene implements `init(renderer)`, `update(dt, audio)`, `render(target|null)`, `resize(w, h)`, `setQuality(level)` and `dispose()`.

**Loading and switching.** Scene modules are dynamically imported the first time they're needed. Each scene renders into its own HDR target. The final composite pass cross-fades the outgoing and incoming scenes with a soft noise-shaped dissolve, applies per-scene ACES tone mapping, then encodes and dithers. The outgoing scene is disposed as soon as its fade completes, so at most two scenes hold GPU memory.

**Performance.**
- One `WebGLRenderer` with device pixel ratio capped at 2.
- Scenes render internally within a ~3.4 MP budget times their own `renderScale`. The canvas keeps full resolution for the composite.
- If a scene averages below 40 fps over a 1.5 s window, it drops one quality level (resolution scale, plus simulation resolution, slice count or particle count, depending on the scene). The level is remembered per scene. Measurements pause during loads and crossfades.
- Shader programs are precompiled asynchronously when a scene loads, with a time limit so a busy GPU can't stall a scene switch.

**Fallbacks.** If WebGL 2 or half-float render targets are unavailable, a message explains why instead of a blank page.

## Credits

- **Inspiration for Scene 1:** Pavel Dobryakov's [WebGL Fluid Simulation](https://github.com/PavelDoGreat/WebGL-Fluid-Simulation) (MIT). The solver follows its structure.
- **Inspiration for Scene 2:** *The Starry Night* (Vincent van Gogh, 1889), which is in the public domain. Scene 2 is an original procedural interpretation, not a copy of the image.
- Simplex noise: Ashima Arts / Stefan Gustavson (MIT).
- Hash functions: "Hash without Sine" by Dave Hoskins (MIT).
- Built with [Three.js](https://threejs.org) and [Vite](https://vite.dev).

## License

[MIT](LICENSE)
