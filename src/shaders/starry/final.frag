// ---------------------------------------------------------------------------
// Starry Night, final pass: the wet canvas as seen through the screen.
//   - impasto: paint luminance as height, lit from the upper left
//   - a faint canvas weave
//   - pitch-class tint on the swirl highlights and the star halos
//   - warm glows from the light mask (stars, moon, windows), breathing moon,
//     onset pulses around single stars, treble twinkle and sparkles
//   - soft vignette
// ---------------------------------------------------------------------------

uniform sampler2D tCanvas;
uniform sampler2D tMask;
uniform vec4 uMap;          // painting uv = screen uv * uMap.xy + uMap.zw
uniform vec2 uCanvasTexel;
uniform vec2 uResolution;
uniform float uTime;
uniform float uTreble;
uniform float uBass;
uniform float uGlow;        // star / moon glow gain (dims in very quiet passages)
uniform float uMoonGlow;
uniform float uClimax;      // 0..1: the sky opens, light blooms yellow-white
uniform vec3 uTint;         // colour of the held dominant note
uniform float uTintAmount;
uniform vec3 uStars[12];    // x, y, radius (the last one is the moon)
uniform float uPulse[12];   // onset pulses per star
uniform vec2 uMoon;         // moon centre incl. the melody lift
varying vec2 vUv;

void main() {
  vec2 puv = vUv * uMap.xy + uMap.zw;
  vec2 p = vec2(puv.x * uAspect, puv.y);
  vec3 col = texture2D(tCanvas, puv).rgb;

  // --- impasto: paint luminance as a height field
  vec2 e = uCanvasTexel * 1.5;
  float hL = luma(texture2D(tCanvas, puv - vec2(e.x, 0.0)).rgb);
  float hR = luma(texture2D(tCanvas, puv + vec2(e.x, 0.0)).rgb);
  float hB = luma(texture2D(tCanvas, puv - vec2(0.0, e.y)).rgb);
  float hT = luma(texture2D(tCanvas, puv + vec2(0.0, e.y)).rgb);
  vec3 n = normalize(vec3((hL - hR) * 3.0, (hB - hT) * 3.0, 1.0));
  vec3 L = normalize(vec3(-0.5, 0.6, 0.65));
  float diff = clamp(dot(n, L), 0.0, 1.0);
  col *= 0.82 + 0.3 * diff;
  col += vec3(1.0, 0.97, 0.9) * pow(max(dot(reflect(-L, n), vec3(0.0, 0.0, 1.0)), 0.0), 20.0) * 0.06;

  // --- canvas weave
  vec2 fc = gl_FragCoord.xy;
  col *= 1.0 + 0.025 * sin(fc.x * 1.7) * sin(fc.y * 1.7);

  vec4 m = texture2D(tMask, puv);
  float sky = 1.0 - m.g;

  // --- the held note tints the bright swirls and the halos, subtly
  float hi = smoothstep(0.35, 0.75, luma(col)) * sky;
  col = mix(col, col * uTint * 1.35, hi * uTintAmount);

  // --- light: soft glows around the bright paint, warmer, then whiter at the climax
  vec3 warm = mix(vec3(1.0, 0.82, 0.42), vec3(1.0, 0.96, 0.82), uClimax);
  vec3 haloCol = mix(warm, uTint, uTintAmount * 0.5);
  float near = textureLod(tMask, puv, 2.5).b;
  float far = textureLod(tMask, puv, 5.0).b;
  // in very quiet passages the stars dim a little
  col = mix(col, col * 0.7, textureLod(tMask, puv, 1.0).b * (1.0 - smoothstep(0.3, 0.8, uGlow)));
  col += haloCol * (near * 0.18 + far * 0.45) * uGlow;

  // breathing moon (bass), lifted with the melody
  float dm = length(p - uMoon) / (uStars[11].z * (1.0 + 0.25 * uBass));
  col += warm * exp(-dm * dm * 0.9) * uMoonGlow;

  // onset pulses: a brief soft bloom around one star (a wide glow with a faint rim, not a hard ring)
  for (int i = 0; i < 12; i++) {
    float r = length(p - uStars[i].xy) / uStars[i].z;
    float ring = (r - 1.3) * 1.8;
    col += haloCol * uPulse[i] * (exp(-r * r * 0.9) * 0.55 + exp(-ring * ring) * 0.1);
  }

  // treble: star centres twinkle, highlights sparkle
  float core = textureLod(tMask, puv, 0.5).b;
  col += warm * core * uTreble * 0.4 * (0.5 + 0.5 * sin(uTime * 21.0 + p.x * 90.0 + p.y * 70.0));
  float spark = step(0.992, hash12(floor(fc * 0.5) + floor(uTime * 12.0)));
  col += vec3(1.0, 0.97, 0.9) * spark * hi * uTreble * 0.6;

  // --- vignette
  vec2 q = vUv - 0.5;
  col *= 1.0 - 0.38 * dot(q, q) * 1.6;

  gl_FragColor = vec4(max(col, 0.0), 1.0);
}
