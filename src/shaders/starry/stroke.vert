// ---------------------------------------------------------------------------
// Instanced brush strokes, drawn into the paint canvas (painting space).
// Each instance reads its state and home, bends along the local streamline
// (sampling the flow behind and ahead of its centre) and takes its colour
// from the reference painting at its home, with a little variation.
// position.x runs along the stroke (-1..1), position.y across it (-1..1).
// The painting paints itself: each stroke has a rank (aRank, the coverage at
// which the painter reaches it); tInv says when (on the reveal clock) the
// coverage passed that rank, so a stroke draws on from its start to its end
// over uGrow seconds after that moment, wet and bright at first, settling as
// it dries. A pure function of the clock: scrubbing replays it exactly.
// ---------------------------------------------------------------------------

attribute float aRank;      // coverage at which the painter reaches this stroke

uniform sampler2D tState;
uniform sampler2D tHome;
uniform sampler2D tFlow;
uniform sampler2D tRef;
uniform sampler2D tMask;
uniform float uStateWidth;
uniform float uVisible;   // fraction of strokes shown (extra strokes join at the climax)
uniform float uOpacity;
uniform float uBright;    // overall stroke brightness (climax bloom)
uniform float uSway;      // cypress sway amplitude
uniform float uTime;
uniform float uLayer;       // 0: sky and hills, 1: the foreground on top (buildings, cypress)
uniform sampler2D tInv;     // coverage -> reveal clock (s) it was reached at, INV_BINS texels
uniform float uRevealNow;   // the reveal clock now: the playhead, or the live painting clock
uniform float uCover;       // coverage now (for the optional dissolve at the end)
uniform vec2 uGrow;         // s to draw on: short ... long strokes
uniform vec2 uWet;          // fresh paint: seconds to settle, extra brightness
varying float vHead;        // the brush head along the stroke (-1..1; 1 = drawn)
varying float vWet;         // sheen of fresh paint, 0 when dry
varying vec2 vLocal;
varying vec3 vColor;
varying float vAlpha;
varying float vSeed;

vec2 flowDir(vec2 p, vec2 fallback) {
  vec2 v = texture2D(tFlow, toUV(p)).xy;
  float l = length(v);
  return l > 1e-6 ? v / l : fallback;
}

float paintedAt(float rank) {
  float x = clamp(rank, 0.0, 1.0) * float(INV_BINS - 1);
  int i = int(floor(x));
  float a = texelFetch(tInv, ivec2(i, 0), 0).r;
  float b = texelFetch(tInv, ivec2(min(i + 1, INV_BINS - 1), 0), 0).r;
  return mix(a, b, fract(x));
}

void hide() {
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // outside the clip volume: not drawn
  vColor = vec3(0.0);
  vAlpha = 0.0;
  vHead = 1.0;
  vWet = 0.0;
}

void main() {
  int id = gl_InstanceID;
  int w = int(uStateWidth);
  ivec2 ij = ivec2(id % w, id / w);
  float seed = hash11(float(id) * 0.6180339 + 0.37);
  vSeed = seed;
  vLocal = position.xy;
  // not yet painted (or dissolved again at the very end)
  float age = uRevealNow - paintedAt(aRank);
  float kept = smoothstep(aRank - 0.02, aRank, uCover);
  if (seed > uVisible || age <= 0.0 || kept <= 0.0) {
    hide();
    return;
  }
  vec4 st = texelFetch(tState, ij, 0);
  vec4 home = texelFetch(tHome, ij, 0);
  vec2 huv = toUV(home.xy);
  vec4 mask = textureLod(tMask, huv, 1.5);
  float cypress = smoothstep(0.25, 0.6, mask.r);
  float building = smoothstep(0.3, 0.7, texelFetch(tMask, ivec2(huv * vec2(textureSize(tMask, 0))), 0).a);
  float land = mask.g * (1.0 - cypress);
  // two passes: the buildings and the cypress are painted over the sky and the hills
  if ((max(cypress, building) > 0.5 ? 1.0 : 0.0) != uLayer) {
    hide();
    return;
  }

  // size by region: long flames in the cypress, short narrow dabs on the buildings (fine detail)
  float len = mix(0.022, 0.042, home.z);
  float wid = mix(0.0055, 0.0095, hash11(seed * 91.7));
  len *= mix(1.0, 1.7, cypress) * mix(1.0, 0.75, land) * mix(1.0, 0.5, building);
  wid *= mix(1.0, 0.8, cypress) * mix(1.0, 0.6, building);

  // draw on: the brush head sweeps from the start to the end (eased), longer for long strokes
  float g = clamp(age / mix(uGrow.x, uGrow.y, clamp((len - 0.02) / 0.05, 0.0, 1.0)), 0.0, 1.0);
  g = g * g * (3.0 - 2.0 * g);
  vHead = -1.0 + 2.0 * g;
  vWet = uWet.y * exp(-age / uWet.x);
  wid *= 1.0 - 0.12 * vWet / max(uWet.y, 1e-3); // the paint settles a touch thicker as it dries

  vec2 pos = mix(st.xy, home.xy, building); // buildings stay exactly where they are painted
  // the cypress sways from its base, more with the music's energy
  pos.x += uSway * cypress * pow(clamp(home.y / 0.95, 0.0, 1.0), 2.0) * sin(uTime * 0.6 + home.y * 2.0);

  // bend along the streamline: directions behind, at and ahead of the centre
  vec2 dir = flowDir(pos, vec2(1.0, 0.0));
  vec2 dirB = flowDir(pos - dir * len * 0.5, dir);
  vec2 dirA = flowDir(pos + dir * len * 0.5, dir);
  float turn = atan(dirB.x * dirA.y - dirB.y * dirA.x, dot(dirB, dirA));
  if (building > 0.5) {
    // buildings: straight strokes along the painted edges (walls and the spire upright, roofs along their slope)
    vec2 e = vec2(0.004 / uAspect, 0.004);
    float gx = luma(textureLod(tRef, refUV(huv + vec2(e.x, 0.0)), 1.5).rgb) - luma(textureLod(tRef, refUV(huv - vec2(e.x, 0.0)), 1.5).rgb);
    float gy = luma(textureLod(tRef, refUV(huv + vec2(0.0, e.y)), 1.5).rgb) - luma(textureLod(tRef, refUV(huv - vec2(0.0, e.y)), 1.5).rgb);
    vec2 g = vec2(-gy, gx);
    dir = length(g) > 0.01 ? normalize(g) : vec2(1.0, 0.0);
    turn = 0.0;
  }
  vec2 nrm = vec2(-dir.y, dir.x);
  float u = min(position.x, vHead); // past the brush head the strip folds onto it
  vLocal.x = u;
  float halfLen = len * 0.5;
  vec2 centre = pos + dir * u * halfLen + nrm * (turn * 0.25 * u * u * halfLen);
  vec2 tangent = normalize(dir + nrm * turn * 0.5 * u);
  vec2 side = vec2(-tangent.y, tangent.x);
  // brush profile: full at the start, thinning toward the tail
  float profile = (1.0 - 0.55 * u * u) * (1.0 - 0.18 * u);
  vec2 p = centre + side * position.y * wid * 0.5 * profile;

  gl_Position = vec4(p.x / uAspect * 2.0 - 1.0, p.y * 2.0 - 1.0, 0.0, 1.0);

  vec3 col = textureLod(tRef, refUV(huv), 1.2).rgb;
  // a touch of the colour where the stroke now is: gentle drift along the flow
  col = mix(col, textureLod(tRef, refUV(toUV(pos)), 1.2).rgb, 0.2 * (1.0 - building));
  col *= (0.9 + 0.2 * hash11(seed * 37.3)) * uBright * (1.0 + vWet);
  col += (hash11(seed * 53.1) - 0.5) * vec3(0.012, 0.0, -0.012);
  vColor = col;
  // fade in at birth and out before the rebirth; strokes that drift into
  // another region (sky over the cypress, hills into the sky) fade away, so
  // silhouettes stay crisp
  vec4 here = textureLod(tMask, toUV(pos), 1.5);
  float stray = abs(smoothstep(0.25, 0.6, here.r) - cypress) + abs(here.g - mask.g) + abs(here.a - mask.a) * (1.0 - building);
  vAlpha = uOpacity * smoothstep(0.0, 0.12, st.z) * smoothstep(1.0, 0.8, st.z) * (1.0 - clamp(stray * 1.5, 0.0, 1.0)) * kept;
}
