// ---------------------------------------------------------------------------
// Fresh, bright strokes thrown around a star (or the moon) on a note onset.
// Analytic: each burst is a uniform (centre, radius, birth time); its strokes
// spiral outward along the halo and fade over BURST_LIFE seconds, leaving
// wet trails in the canvas.
// ---------------------------------------------------------------------------

uniform vec4 uBursts[BURSTS];   // x, y, radius, birth time
uniform vec3 uBurstColors[BURSTS];
uniform float uBurstAmp[BURSTS]; // opacity: melody blooms ~1, accompaniment ripples faint
uniform float uRealTime;
uniform float uFadeIn;          // s: blooms swell in, never flash
varying vec2 vLocal;
varying vec3 vColor;
varying float vAlpha;
varying float vSeed;

void main() {
  int id = gl_InstanceID;
  int k = id / BURST_STROKES;
  vec4 b = uBursts[k];
  float age = uRealTime - b.w;
  float seed = hash11(float(id) * 0.7548 + 0.11);
  vSeed = seed;
  vLocal = position.xy;
  if (age < 0.0 || age >= BURST_LIFE) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vColor = vec3(0.0);
    vAlpha = 0.0;
    return;
  }
  float h2 = hash11(seed * 17.1);
  float h3 = hash11(seed * 29.3);
  // spread over a disc (sqrt: even density) that opens outward, so a bloom reads as a painted halo, not a ring
  float r = b.z * (0.15 + 1.1 * sqrt(h2)) * (0.6 + 0.5 * (1.0 - exp(-age * 2.2)));
  float th = seed * 6.2831853 + age * (0.5 + 0.6 * h3);
  vec2 c = b.xy + r * vec2(cos(th), sin(th));
  vec2 dir = vec2(-sin(th), cos(th));
  vec2 side = vec2(-dir.y, dir.x);
  float halfLen = (0.008 + 0.008 * h2);
  float wid = 0.0045;
  float u = position.x;
  vec2 p = c + dir * u * halfLen + side * position.y * wid * 0.5 * (1.0 - 0.5 * u * u);
  gl_Position = vec4(p.x / uAspect * 2.0 - 1.0, p.y * 2.0 - 1.0, 0.0, 1.0);
  vColor = uBurstColors[k] * (0.9 + 0.25 * h3);
  // clamp: at the very end of a life float error can make 1 - t slightly
  // negative, and pow() of a negative base is NaN (which would poison the canvas)
  float t = clamp(age / BURST_LIFE, 0.0, 1.0);
  vAlpha = 0.9 * uBurstAmp[k] * smoothstep(0.0, uFadeIn, age) * pow(1.0 - t, 1.5);
}
