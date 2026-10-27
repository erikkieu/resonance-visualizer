// ---------------------------------------------------------------------------
// Starry Night: procedural underpainting, used only as a fallback reference
// for scene 2 when /public/textures/starry-night.jpg is missing.
// Output: rgb = linear colour.
//
// Brush direction comes from a stream function psi: the velocity
// (dpsi/dy, -dpsi/dx) is divergence-free, so strokes follow closed swirls
// around the vortices, stars and moon, the way Van Gogh's strokes do.
// ---------------------------------------------------------------------------

varying vec2 vUv;

// Compact Gaussian vortex: tangential flow near c, none far away.
float vortex(vec2 p, vec2 c, float r, float strength) {
  vec2 d = p - c;
  return strength * exp(-dot(d, d) / (r * r));
}

float streamFunction(vec2 p) {
  float s = 0.0;
  // wind current flowing left to right across the sky, gently waving
  s += 0.085 * p.y + 0.028 * sin(p.x * 2.3 - uTime * 0.18 + p.y * 3.1);
  // the great central spiral and its counter-swirl
  s += vortex(p, swirlCenter(), 0.21, 0.085);
  s += vortex(p, swirlCenter2(), 0.13, -0.045);
  // every star and the moon carry their own small whirl
  for (int i = 0; i < NSTARS; i++) s += vortex(p, starPos(i), starSize(i) * 2.6, 0.012);
  s += vortex(p, moonPos(), 0.17, 0.022);
  // turbulence, stronger with the mid band
  s += (0.008 + 0.018 * uMid) * fbm(p * 2.6 + vec2(uTime * 0.04, -uTime * 0.02), 3);
  return s;
}

vec2 flowAt(vec2 p) {
  const float e = 0.004;
  float dx = streamFunction(p + vec2(e, 0.0)) - streamFunction(p - vec2(e, 0.0));
  float dy = streamFunction(p + vec2(0.0, e)) - streamFunction(p - vec2(0.0, e));
  return vec2(dy, -dx) / (2.0 * e);
}

vec3 skyColor(vec2 p, float psi) {
  // ultramarine overhead, lighter cobalt toward the hills
  vec3 deep = vec3(0.06, 0.12, 0.38);
  vec3 cobalt = vec3(0.13, 0.27, 0.58);
  vec3 low = vec3(0.30, 0.48, 0.70);
  vec3 col = mix(low, cobalt, smoothstep(0.28, 0.55, p.y));
  col = mix(col, deep, smoothstep(0.62, 1.0, p.y));

  // alternating light/dark bands along the streamlines (strokes of paint)
  float band = sin(psi * 140.0 + fbm(p * 5.0, 2) * 2.0);
  col *= 0.88 + 0.16 * band;

  // the long luminous wind band that crosses the sky
  float wy = 0.6 + 0.06 * sin(p.x * 2.6 - 0.4 - uTime * 0.1) + 0.02 * sin(p.x * 7.0);
  float wd = (p.y - wy) / 0.05;
  float wind = exp(-wd * wd) * smoothstep(0.05, 0.4, p.x / uLayout) * smoothstep(0.98, 0.7, p.x / uLayout);
  col = mix(col, vec3(0.50, 0.66, 0.84), wind * (0.45 + 0.25 * band));

  // great spiral: rotating arms of pale blue-white with a hint of green
  vec2 d = p - swirlCenter();
  float r = length(d);
  float a = atan(d.y, d.x);
  float arms = sin(a * 2.0 + log(r + 0.02) * 7.0 + uTime * 0.55);
  float spiral = smoothstep(0.26, 0.04, r) * smoothstep(0.1, 0.9, arms);
  col = mix(col, vec3(0.76, 0.86, 0.86), spiral * 0.75);
  col = mix(col, vec3(0.82, 0.86, 0.62), spiral * smoothstep(0.12, 0.0, r) * 0.4);

  vec2 d2 = p - swirlCenter2();
  float r2 = length(d2);
  float arms2 = sin(-atan(d2.y, d2.x) * 2.0 + log(r2 + 0.02) * 6.0 - uTime * 0.45);
  col = mix(col, vec3(0.55, 0.72, 0.86), smoothstep(0.16, 0.03, r2) * smoothstep(0.2, 0.9, arms2) * 0.6);

  // stars: concentric halos of yellow and pale blue-white that pulse outward
  for (int i = 0; i < NSTARS; i++) {
    float s = starSize(i);
    float rs = length(p - starPos(i)) / s;
    if (rs > 3.0) continue;
    float rings = 0.5 + 0.5 * cos(rs * 8.0 - uTime * 1.4 + float(i));
    float halo = smoothstep(2.8, 0.7, rs);
    vec3 ringCol = mix(vec3(0.62, 0.78, 0.86), vec3(0.98, 0.88, 0.42), rings);
    col = mix(col, ringCol, halo * (0.55 + 0.35 * uBass));
    col = mix(col, vec3(1.0, 0.95, 0.62), smoothstep(0.75, 0.15, rs));
  }

  // moon: glowing orb with rotating halo rings and a crescent
  vec2 dm = p - moonPos();
  float rm = length(dm) / MOON_R;
  if (rm < 3.4) {
    float am = atan(dm.y, dm.x);
    float wob = 0.12 * sin(am * 5.0 + uTime * 0.7);
    float rings = 0.5 + 0.5 * cos((rm + wob) * 6.0 - uTime * 0.9);
    vec3 haloCol = mix(vec3(0.95, 0.72, 0.25), vec3(0.98, 0.92, 0.55), rings);
    col = mix(col, haloCol, smoothstep(3.3, 1.1, rm) * (0.6 + 0.3 * uBass));
    // orb and crescent
    vec3 orb = vec3(0.96, 0.62, 0.18);
    col = mix(col, orb, step(rm, 1.0));
    float inner = length(dm - vec2(0.38, 0.22) * MOON_R) / (MOON_R * 0.88);
    col = mix(col, vec3(0.99, 0.86, 0.36), step(rm, 1.0) * step(1.0, inner));
  }
  return col;
}

void main() {
  vec2 p = vec2(vUv.x * uAspect + uOffsetX, vUv.y);
  float psi = streamFunction(p);
  vec2 v = flowAt(p) + vec2(0.015, 0.0);
  float angle = atan(v.y, v.x);
  // mid band roughens the brushwork
  angle += (0.12 + 0.45 * uMid) * snoise(vec3(p * 7.0, uTime * 0.2));
  vec3 col = skyColor(p, psi);

  // --- far hills
  float fh = farHill(p.x);
  if (p.y < fh) {
    float t = smoothstep(fh - 0.12, fh, p.y);
    col = mix(vec3(0.16, 0.24, 0.42), vec3(0.30, 0.42, 0.62), t);
    col *= 0.9 + 0.2 * snoise(vec2(p.x * 14.0, p.y * 40.0));
    float slope = (farHill(p.x + 0.01) - farHill(p.x - 0.01)) / 0.02;
    angle = atan(slope) + 0.25 * snoise(p * 18.0);
  }

  // --- near hills and fields
  float nh = nearHill(p.x);
  if (p.y < nh) {
    float t = smoothstep(0.0, nh, p.y);
    col = mix(vec3(0.07, 0.12, 0.17), vec3(0.17, 0.27, 0.35), t);
    col = mix(col, vec3(0.22, 0.32, 0.30), 0.35 * smoothstep(0.3, 0.8, snoise(p * 9.0)));
    float slope = (nearHill(p.x + 0.01) - nearHill(p.x - 0.01)) / 0.02;
    angle = atan(slope * 0.6) + 0.35 * snoise(p * 16.0 + 3.0);
    // dark clumps of trees among the houses
    float trees = smoothstep(0.55, 0.75, fbm(p * 18.0, 2) + 0.4 - p.y * 1.5);
    col = mix(col, vec3(0.05, 0.09, 0.1), trees * 0.8);
  }

  // --- village
  vec4 vil = village(p);
  if (vil.x > 0.0) {
    if (vil.y > 0.75) {
      col = mix(vec3(0.1, 0.14, 0.25), vec3(0.24, 0.27, 0.34), vil.w); // roofs
      angle = 0.0;
    } else if (vil.y > 0.25) {
      col = vec3(0.16, 0.21, 0.34); // church
      angle = PI * 0.5;
    } else {
      col = mix(vec3(0.2, 0.27, 0.4), vec3(0.42, 0.46, 0.5), vil.w * vil.w); // walls
      angle = PI * 0.5;
    }
    col = mix(col, vec3(1.0, 0.8, 0.3), vil.z);
  }

  // --- cypress, front-most: dark flames licking upward
  vec3 cy = cypress(p);
  if (cy.x > 0.0) {
    float streak = sin(cy.y * 5.0 + p.y * 30.0 + snoise(p * 12.0) * 2.0);
    col = mix(vec3(0.025, 0.04, 0.035), vec3(0.08, 0.12, 0.08), 0.5 + 0.5 * streak);
    col = mix(col, vec3(0.2, 0.26, 0.14), smoothstep(0.8, 1.0, streak) * 0.55 * (1.0 - cy.z));
    col = mix(col, vec3(0.17, 0.11, 0.06), smoothstep(0.55, 0.9, snoise(p * 10.0)) * 0.6);
    // the flame's rim catches the blue of the sky
    col = mix(col, vec3(0.12, 0.2, 0.3), smoothstep(0.7, 1.0, abs(cy.y)) * 0.5);
    angle = PI * 0.5 + cy.y * 0.35 + 0.45 * sin(p.y * 17.0 + cy.y * 2.0 + uTime * 0.4);
  }

  // used only as a fallback reference for scene 2 when the painting image is
  // missing: linear colour, like a sampled sRGB texture
  gl_FragColor = vec4(pow(col, vec3(2.2)), 1.0);
}
