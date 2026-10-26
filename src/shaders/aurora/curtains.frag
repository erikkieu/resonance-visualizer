// ---------------------------------------------------------------------------
// Aurora curtain lookup table (4096 x 3, recomputed every frame).
// Each row is one curtain; each column a position x along it (-50..50 map
// units). Precomputing the slowly varying shape here means the volume march
// needs one texture fetch per curtain per slice instead of several noises.
//   r = z of the curtain's centre line (base distance + meander + folds)
//   g = brightness along the curtain (patchiness x fine vertical rays)
// ---------------------------------------------------------------------------

varying vec2 vUv;

void main() {
  float x = (vUv.x - 0.5) * 100.0;
  float fk = floor(vUv.y * 3.0);
  float t = uTime;

  float base = 8.0 + 7.5 * fk;
  float fold = 0.32 + 0.35 * uMid; // mid: fold frequency
  float meander = 4.0 * (vnoise(vec2(x * 0.035 + fk * 9.1, t * 0.018 + fk)) - 0.5) * 2.0;
  float folds = (1.8 - 0.3 * fk) * sin(x * fold + t * (0.5 + 0.1 * fk) + fk * 2.3)
              + 0.5 * sin(x * fold * 2.3 - t * 0.7 + fk);

  float patchy = smoothstep(0.35, 0.8, vnoise(vec2(x * 0.09 + t * 0.03, fk * 5.0)));
  // fine vertical rays; treble makes them crisper and denser
  float rays = vnoise(vec2(x * (2.6 + 2.5 * uTreble) - t * 0.25, fk * 3.0 + t * 0.05));
  rays = mix(1.0, 0.25 + 1.1 * rays * rays, 0.55 + 0.35 * uTreble);

  gl_FragColor = vec4(base + meander + folds, (0.04 + 0.96 * patchy) * rays * (1.0 - 0.3 * fk), 0.0, 1.0);
}
