// ---------------------------------------------------------------------------
// Starry Night, pass 2: brush strokes (full resolution).
//
// Three layers of strokes on jittered grids (large -> small). Each stroke
// samples the underpainting once at its centre for colour and direction,
// then is drawn as a tapered, slightly bent capsule with bristle grooves.
// The top-most stroke covering a pixel wins (like wet-on-wet impasto).
// A height value per stroke is lit via screen-space derivatives, which
// produces ridges along every stroke edge.
// ---------------------------------------------------------------------------

uniform sampler2D tField;
uniform vec2 uFieldSize;
uniform vec2 uResolution;
varying vec2 vUv;

vec4 fieldAt(vec2 p) {
  vec2 uv = clamp(vec2((p.x - uOffsetX) / uAspect, p.y), 0.0, 0.999);
  return texelFetch(tField, ivec2(uv * uFieldSize), 0);
}

// Searches the 3x3 neighbourhood of one stroke layer.
// out: colour, local (u, v) inside the stroke, per-stroke random. Returns hit.
bool strokeLayer(vec2 p, float cell, float lenK, float widK, float density, float seed,
                 out vec3 col, out vec2 uv, out float rnd) {
  vec2 g = floor(p / cell);
  float best = -1.0;
  col = vec3(0.0);
  uv = vec2(0.0);
  rnd = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 id = g + vec2(float(i), float(j));
      vec2 h1 = hash22(id + seed);
      vec2 h2 = hash22(id * 1.73 + seed + 19.1);
      if (h2.x > density) continue;
      vec2 c = (id + 0.5 + (h1 - 0.5) * 0.7) * cell;
      vec4 f = fieldAt(c);
      float ang = f.a * PI;
      vec2 dir = vec2(cos(ang), sin(ang));
      vec2 d = p - c;
      float u = dot(d, dir) / (cell * lenK);
      float v = dot(d, vec2(-dir.y, dir.x)) / (cell * widK);
      v += (h2.y - 0.5) * 0.7 * u * u; // slight bend
      float taper = 1.0 - 0.45 * u * u;
      if (abs(u) < 1.0 && abs(v) < taper && h2.y > best) {
        best = h2.y;
        // per-stroke variation of value and hue, as if the brush picked up a
        // little more or less paint
        float jitter = (h1.x - 0.5) * 0.14;
        col = f.rgb * (1.0 + jitter) + (h1.y - 0.5) * vec3(0.03, 0.02, -0.03);
        uv = vec2(u, v / taper);
        rnd = h2.x * 7.31 + h1.y;
      }
    }
  }
  return best >= 0.0;
}

void main() {
  vec2 p = vec2(vUv.x * uAspect + uOffsetX, vUv.y);

  // ground: the blurred underpainting shows wherever no stroke lands
  vec3 col = texture2D(tField, vUv).rgb * 0.82;
  float height = 0.0;

  // the top-most stroke that covers this pixel
  vec2 suv = vec2(0.0);
  float sr = 0.0;
  vec3 tc;
  vec2 tuv;
  float tr;
  // layer sizes in painting units; the small layer is sparser
  if (strokeLayer(p, 0.034, 1.08, 0.34, 1.0, 1.0, tc, tuv, tr)) {
    col = tc;
    suv = tuv;
    sr = tr;
    height = 0.3 + 0.4 * (1.0 - suv.y * suv.y);
  }
  if (strokeLayer(p, 0.022, 1.08, 0.33, 0.85, 7.0, tc, tuv, tr)) {
    col = tc;
    suv = tuv;
    sr = tr;
    height = 0.7 + 0.4 * (1.0 - suv.y * suv.y);
  }
  if (strokeLayer(p, 0.0145, 1.05, 0.32, 0.55, 13.0, tc, tuv, tr)) {
    col = tc;
    suv = tuv;
    sr = tr;
    height = 1.1 + 0.35 * (1.0 - suv.y * suv.y);
  }

  // bristle grooves running along the stroke
  float bristle = 0.5 + 0.5 * sin(suv.y * 9.0 + sr * 20.0);
  bristle = mix(bristle, vnoise(vec2(suv.y * 7.0 + sr * 13.0, suv.x * 1.2)), 0.5);
  col *= 0.92 + 0.14 * bristle;
  height += 0.12 * bristle;

  // impasto lighting from screen-space slope of the paint height
  float k = uResolution.y / 900.0;
  vec3 n = normalize(vec3(-dFdx(height) * 1.6 / k, -dFdy(height) * 1.6 / k, 1.0));
  vec3 L = normalize(vec3(-0.45, 0.6, 0.65));
  float light = clamp(dot(n, L), 0.0, 1.0);
  col *= 0.8 + 0.32 * light;
  col += vec3(1.0, 0.97, 0.88) * pow(max(dot(reflect(-L, n), vec3(0.0, 0.0, 1.0)), 0.0), 18.0) * 0.08;

  // crisp, twinkling star cores (treble) on top of the paint
  for (int i = 0; i < NSTARS; i++) {
    float s = starSize(i);
    vec2 d = p - starPos(i);
    float r = length(d) / s;
    float tw = 0.75 + 0.25 * sin(uTime * 3.0 + float(i) * 1.7) + uTreble * 0.9 * (0.5 + 0.5 * sin(uTime * 23.0 + float(i) * 4.1));
    col += vec3(1.0, 0.94, 0.7) * exp(-r * r * 9.0) * 0.55 * tw;
    col += vec3(1.0, 0.85, 0.45) * exp(-r * 1.6) * 0.08 * (1.0 + uBass);
  }
  vec2 dm = p - moonPos();
  col += vec3(1.0, 0.8, 0.4) * exp(-length(dm) / MOON_R * 1.3) * (0.18 + 0.2 * uBass);

  // warm glowing windows, crisp at full resolution
  vec4 vil = village(p);
  col = mix(col, vec3(1.0, 0.84, 0.38), vil.z * (0.85 + 0.15 * sin(uTime * 2.0 + p.x * 40.0)));
  float glowAcc = 0.0;
  for (int i = 0; i < 4; i++) {
    float a = float(i) * 1.5708 + 0.785;
    glowAcc += village(p + vec2(cos(a), sin(a)) * 0.006).z;
  }
  col += vec3(1.0, 0.7, 0.3) * glowAcc * 0.08;

  // canvas weave and vignette
  vec2 fc = gl_FragCoord.xy;
  float weave = (sin(fc.x * 1.9) * sin(fc.y * 1.9)) * 0.012;
  col += weave;
  vec2 q = vUv - 0.5;
  col *= 1.0 - 0.42 * dot(q, q);

  // the painting was authored in sRGB: convert to linear for the HDR pipeline
  gl_FragColor = vec4(pow(max(col, 0.0), vec3(2.2)), 1.0);
}
