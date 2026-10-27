// ---------------------------------------------------------------------------
// Instanced brush strokes, drawn into the paint canvas (painting space).
// Each instance reads its state and home, bends along the local streamline
// (sampling the flow behind and ahead of its centre) and takes its colour
// from the reference painting at its home, with a little variation.
// position.x runs along the stroke (-1..1), position.y across it (-1..1).
// ---------------------------------------------------------------------------

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
varying vec2 vLocal;
varying vec3 vColor;
varying float vAlpha;
varying float vSeed;

vec2 flowDir(vec2 p, vec2 fallback) {
  vec2 v = texture2D(tFlow, toUV(p)).xy;
  float l = length(v);
  return l > 1e-6 ? v / l : fallback;
}

void main() {
  int id = gl_InstanceID;
  int w = int(uStateWidth);
  ivec2 ij = ivec2(id % w, id / w);
  float seed = hash11(float(id) * 0.6180339 + 0.37);
  vSeed = seed;
  vLocal = position.xy;
  if (seed > uVisible) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // outside the clip volume: not drawn
    vColor = vec3(0.0);
    vAlpha = 0.0;
    return;
  }
  vec4 st = texelFetch(tState, ij, 0);
  vec4 home = texelFetch(tHome, ij, 0);
  vec2 huv = toUV(home.xy);
  vec4 mask = textureLod(tMask, huv, 1.5);
  float cypress = smoothstep(0.25, 0.6, mask.r);
  float land = mask.g * (1.0 - cypress);

  // size by region: long flames in the cypress, shorter dabs in the village
  float len = mix(0.022, 0.042, home.z);
  float wid = mix(0.0055, 0.0095, hash11(seed * 91.7));
  // the village is fine detail: short, narrow dabs
  float village = land * smoothstep(0.26, 0.18, home.y);
  len *= mix(1.0, 1.7, cypress) * mix(1.0, 0.75, land) * mix(1.0, 0.6, village);
  wid *= mix(1.0, 0.8, cypress) * mix(1.0, 0.7, village);

  vec2 pos = st.xy;
  // the cypress sways from its base, more with the music's energy
  pos.x += uSway * cypress * pow(clamp(home.y / 0.95, 0.0, 1.0), 2.0) * sin(uTime * 0.6 + home.y * 2.0);

  // bend along the streamline: directions behind, at and ahead of the centre
  vec2 dir = flowDir(pos, vec2(1.0, 0.0));
  vec2 dirB = flowDir(pos - dir * len * 0.5, dir);
  vec2 dirA = flowDir(pos + dir * len * 0.5, dir);
  float turn = atan(dirB.x * dirA.y - dirB.y * dirA.x, dot(dirB, dirA));
  vec2 nrm = vec2(-dir.y, dir.x);
  float u = position.x;
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
  col = mix(col, textureLod(tRef, refUV(toUV(pos)), 1.2).rgb, 0.2);
  col *= (0.9 + 0.2 * hash11(seed * 37.3)) * uBright;
  col += (hash11(seed * 53.1) - 0.5) * vec3(0.012, 0.0, -0.012);
  vColor = col;
  // fade in at birth and out before the rebirth; strokes that drift into
  // another region (sky over the cypress, hills into the sky) fade away, so
  // silhouettes stay crisp
  vec4 here = textureLod(tMask, toUV(pos), 1.5);
  float stray = abs(smoothstep(0.25, 0.6, here.r) - cypress) + abs(here.g - mask.g);
  vAlpha = uOpacity * smoothstep(0.0, 0.12, st.z) * smoothstep(1.0, 0.8, st.z) * (1.0 - clamp(stray * 1.5, 0.0, 1.0));
}
