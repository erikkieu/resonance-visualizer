// ---------------------------------------------------------------------------
// Aurora curtains (low resolution, additive HDR output).
//
// Seen from below, as in a long exposure looking up into an aurora overhead
// (reference restyle 2): the rays of every curtain run along straight lines
// toward a vanishing point near the top of the frame (uVp). So the sky is laid
// out around it: the angle picks the place along each curtain, the distance
// from the VP the height on it. Each curtain's lower edge is a curve at
// distance R(angle) from the VP; its light rises from that soft edge toward
// the VP, brightest just above it, fading upward. Shape, light, height and
// colour along each curtain come from the tCurtains lookup table
// (curtains.frag): its meander, folds and the packets' bow move the lower
// edge (uVp.w), the packets light and lift it. A twist around a point in the
// upper left (uCurl) curls the sky into a loop, and folds seen edge-on come
// out brighter.
// Up to 6 ribbons (LOOK.RIBBONS: uRib, uRib2, uRib3) each ride one lookup row
// (0-1 the melody layer, coloured from uRampMel; 2-3 the low layer, from
// uRampLow) with their own edge, length, colour offset, drift and billow (a
// slow domain warp of their own), so they cross and overlap; uRib2.w fades
// each in and out with the loudness. Colour: a near-white core in the bright
// lower part (uCore), the ramp colour shifting up the ramp toward the top
// (uColour.x: green -> cyan -> blue / violet), the crown further along, a
// magenta fringe at the very top of the strongest rays (uFringe), twisted per
// row by the note's pitch class (uHueRot). The two layers are accumulated
// apart and combined by uScreen (0 = add, 1 = screen); a soft per-pixel cap
// (uCap) rolls the HDR peaks off.
// ---------------------------------------------------------------------------

#define RAMP_STOPS 6

uniform sampler2D tCurtains;
uniform vec3 uRampMel[RAMP_STOPS];   // linear colours (unused stops repeat the last)
uniform float uRampMelAt[RAMP_STOPS];
uniform vec3 uRampLow[RAMP_STOPS];
uniform float uRampLowAt[RAMP_STOPS];
uniform vec4 uHueRot;             // radians per curtain
uniform float uCrest;             // ramp offset of the crown
uniform float uScreen;            // 0 = the layers add, 1 = screen blend
uniform float uCap;
uniform float uOn;                // 0..1, the A key fades the aurora out
uniform vec4 uRowZ;               // the curtains' base distance in the lookup table (map units)
#define RIBBONS 6
uniform vec4 uRib[RIBBONS];       // x = lower-edge distance from the VP (screen heights), y = its change across the view (per radian), z = level (0 = an arc around the VP, 1 = parallel to the horizon), w = ray length (screen heights at height 1)
uniform vec4 uRib2[RIBBONS];      // x = lookup row, y = ramp offset, z = lookup shift (drift), w = brightness × shown (0 = off)
uniform vec4 uRib3[RIBBONS];      // x = billow amplitude (radians), y = billow phase, z = soft lower edge (share of the ray length)
uniform vec4 uColour;             // x = ramp shift from the lower edge to the top, y = magenta fringe, z = core amount
uniform vec3 uCore;               // near-white cores (linear)
uniform vec3 uFringe;             // the fringe at the top of the strongest rays (linear)
uniform vec4 uVp;                 // xy = vanishing point (screen x 0..1, height), z = spread (lookup 0..1 = 0.5 + z sin(angle)), w = edge bend (screen heights per map unit)
uniform vec4 uCurl;               // xy = loop centre (screen x 0..1, height), z = twist (radians), w = radius (screen heights)
uniform vec4 uBillow;             // y = billow frequency (per screen height), w = edge-on brightening
uniform vec4 uRays;               // x = climax fan (share of the view angle), y = fade toward the top, w = saturation
uniform vec4 uGlowShape;          // x = glow where the rays converge near the VP, y = fade toward the far left, z = × the low layer's light
uniform vec4 uTex;                // x = ray texture contrast, y = frequency across (per radian), z = along (per screen height), w = curtain light gain
varying vec2 vUv;


float pick(vec4 v, float k) {
  return k < 0.5 ? v.x : k < 1.5 ? v.y : k < 2.5 ? v.z : v.w;
}

vec3 ramp(float h, bool mel) {
  h = clamp(h, 0.0, 1.0);
  vec3 c = mel ? uRampMel[0] : uRampLow[0];
  for (int i = 1; i < RAMP_STOPS; i++) {
    float a = mel ? uRampMelAt[i - 1] : uRampLowAt[i - 1];
    float b = mel ? uRampMelAt[i] : uRampLowAt[i];
    float f = clamp((h - a) / max(b - a, 1e-4), 0.0, 1.0);
    c = mix(c, mel ? uRampMel[i] : uRampLow[i], f * f * (3.0 - 2.0 * f));
  }
  return c;
}

// hue rotation about the grey axis (keeps the brightness, turns the hue)
vec3 hueRotate(vec3 c, float a) {
  float cs = cos(a);
  float sn = sin(a);
  float k = (1.0 - cs) / 3.0;
  float s3 = 0.57735 * sn;
  return max(vec3(
    (cs + k) * c.r + (k - s3) * c.g + (k + s3) * c.b,
    (k + s3) * c.r + (cs + k) * c.g + (k - s3) * c.b,
    (k - s3) * c.r + (k + s3) * c.g + (cs + k) * c.b
  ), 0.0);
}

void main() {
  if (uOn <= 0.0 || vUv.y < HORIZON) {
    gl_FragColor = vec4(0.0);
    return;
  }
  float t = uTime;
  vec2 p = vec2(vUv.x * uAspect, vUv.y);

  // the loop: the sky twisted around a point in the upper left, most at its centre
  vec2 cc = vec2(uCurl.x * uAspect, uCurl.y);
  vec2 dc = p - cc;
  float tw = uCurl.z * exp(-dot(dc, dc) / (uCurl.w * uCurl.w));
  p = cc + mat2(cos(tw), sin(tw), -sin(tw), cos(tw)) * dc;

  // around the vanishing point: r = distance (height on a curtain), th0 = angle (place along it)
  vec2 d = p - vec2(uVp.x * uAspect, uVp.y);
  float r = length(d);
  float th0 = atan(d.x, -d.y);

  vec3 accMel = vec3(0.0);
  vec3 accLow = vec3(0.0);
  for (int k = 0; k < RIBBONS; k++) {
    vec4 A = uRib[k];
    vec4 B = uRib2[k];
    vec4 C = uRib3[k];
    if (B.w <= 1e-3) continue;
    float fk = B.x; // its lookup row
    bool mel = fk < 1.5;
    float row = (fk + 0.5) / 4.0;
    float base = pick(uRowZ, fk);
    // its own large, slow billows: the angle bends with the distance, so the sheet curves and folds
    float th = th0 + C.x * snoise(vec3(r * uBillow.y, th0 * 0.9 + float(k) * 3.7, C.y));
    th = clamp(th, -1.5, 1.5);
    // (the climax fans the ribbons wide: each spans more of the view; the thin ones drift past)
    float su = 0.5 + uVp.z * sin(th) * (1.0 - uRays.x) + B.z;
    // the lookup table runs over map x (-50..50); this screen place sits at x = (su - 0.5) base aspect / FOCAL
    float toLu = base * uAspect / (FOCAL * 100.0);
    float lu = 0.5 + (su - 0.5) * toLu;
    vec4 c = texture2D(tCurtains, vec2(lu, row));
    if (c.y <= 1e-4) continue;
    float bend = uVp.w;
    float level = mix(1.0, 1.0 / max(cos(th), 0.25), A.z);
    float R = A.x * level + A.y * th - (c.x - base) * bend;
    // the neighbours one pixel footprint away (at least 0.006): toward the VP a pixel spans more
    // of the curtain, so the light is filtered over it there (no aliasing of the fine rays)
    float fp = uVp.z * max(cos(th), 0.05) * (2.5 / uResolution.y) / max(r, 0.02);
    float e = max(0.006, fp);
    vec4 cl = texture2D(tCurtains, vec2(lu - e * toLu, row));
    vec4 cr = texture2D(tCurtains, vec2(lu + e * toLu, row));
    c.y = 0.5 * c.y + 0.25 * (cl.y + cr.y);
    // folds seen edge-on: where the lower edge runs steeply toward the VP
    float dz = cr.x - cl.x;
    float dth = 2.0 * e / max(uVp.z * cos(th), 0.05);
    float steep = abs(dz * bend) / max(R * dth, 1e-3);
    float edgeOn = 1.0 + uBillow.w * smoothstep(0.4, 2.5, steep);

    float H = A.w * max(c.b, 0.05);
    float lf = (R - r) / H; // 0 at the lower edge, 1 at the top of the rays
    float soft = C.z;
    if (lf < -2.0 * soft || lf > 1.3) continue;
    // a soft lower edge, brightest just above it, fading smoothly up to the top
    float fade = smoothstep(-soft, soft, lf) * exp(-max(lf, 0.0) * uRays.y) * (1.0 - smoothstep(0.75, 1.3, lf));
    // colour: near-white core in the bright lower part -> the ramp, shifting along it toward
    // the top (colour zones) -> the crown further up -> a fringe at the top of strong rays
    float h = c.a + B.y + uColour.x * smoothstep(0.2, 1.0, lf);
    vec3 col = mix(ramp(h, mel), uCore, uColour.z * (1.0 - smoothstep(0.0, 0.35, lf)) * smoothstep(0.1, 1.2, c.y));
    col = mix(col, ramp(h + uCrest, mel), smoothstep(0.35, 0.9, lf));
    col = hueRotate(col, pick(uHueRot, fk));
    col = mix(col, uFringe, uColour.y * smoothstep(0.6, 1.0, lf) * smoothstep(0.4, 1.4, c.y));
    // broad soft rays: low-frequency noise across the rays (per ribbon), stretched along them,
    // drifting slowly along the curtain
    float rn = 0.65 * vnoise(vec2(th * uTex.y + float(k) * 17.0 - t * 0.012, r * uTex.z + float(k) * 3.0))
             + 0.35 * vnoise(vec2(th * uTex.y * 2.3 + float(k) * 5.0 + t * 0.008, r * uTex.z * 1.4));
    float rays = max(1.0 + uTex.x * (2.0 * rn - 1.0) * 1.6, 0.0);
    vec3 light = col * c.y * fade * edgeOn * rays * B.w;
    if (mel) accMel += light;
    else accLow += light;
  }

  float brightness = (0.8 + 0.5 * uEnergy) * (1.0 + 0.25 * uBass) * (1.0 + 0.4 * uSurge) * uBright;
  float gain = brightness * uTex.w * uOn;
  // the rays bunch up toward the vanishing point (a soft corona); the far left stays dark
  gain *= 1.0 + uGlowShape.x * (1.0 - smoothstep(0.05, 0.75, r));
  accMel *= gain;
  accLow *= gain * uGlowShape.z;
  // where the layers cross their light adds up (screen: softer where both are bright)
  vec3 col = accMel + accLow - uScreen * accMel * accLow / (accMel + accLow + 1e-4);
  col = max(mix(vec3(dot(col, vec3(0.2126, 0.7152, 0.0722))), col, uRays.w), 0.0); // natural, not neon (the climax opens it up)
  col *= smoothstep(HORIZON, HORIZON + 0.03, vUv.y);
  // soft cap: bright pixels saturate toward uCap instead of clipping to white
  float m = max(max(col.r, col.g), col.b);
  col *= uCap * (1.0 - exp(-m / uCap)) / max(m, 1e-4);
  col *= 1.0 - uGlowShape.y * smoothstep(0.3, 0.02, vUv.x) * smoothstep(0.85, 0.6, vUv.y);
  gl_FragColor = vec4(col, 1.0);
}
