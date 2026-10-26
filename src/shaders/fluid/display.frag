// Acrylic-pour display for a colour dye.
//
// uDye holds premultiplied Oklab colour (L, a, b in rgb) and the paint
// amount (a). Every pour brings its own colour (from the pitch-height ramp)
// and the advection mixes them perceptually, so mixes stay colourful and the
// canvas is a record of the melody. To keep the acrylic look:
//   - an unsharp mask against the neighbours keeps borders between pours crisp
//   - dark "lacing" veins are drawn where the colour changes quickly
//   - the paint amount is a height field for glossy lighting
// uGold is a separate metallic layer (r = bright gold, g = deep gold) drawn
// on top, so gold stays brilliant instead of mixing into the blues.

uniform sampler2D uDye;
uniform sampler2D uGold;
uniform vec3 cGold;
uniform vec3 cGoldDeep;
uniform float uSheen;     // gilded highlights, brighter when the music is loud
uniform float uVibrance;  // chroma boost (1 = as stored)
uniform vec2 uDyeTexel;
uniform float uAspect;
uniform float uTime;
uniform float uTreble;
uniform float uBeat;
uniform vec3 cWhite;
uniform vec3 cNavy;
uniform vec3 cDeep;
varying vec2 vUv;

vec4 dyeAt(vec2 uv) {
  vec4 d = texture2D(uDye, uv);
  return vec4(d.rgb, max(d.a, 0.0));
}

// Oklab colour of the paint (premultiplied storage)
vec3 colourOf(vec4 d) {
  return d.rgb / max(d.a, 1e-3);
}

// Oklab -> linear sRGB (Björn Ottosson)
vec3 oklabToLinear(vec3 c) {
  float l = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  float m = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  float s = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;
  l = l * l * l;
  m = m * m * m;
  s = s * s * s;
  return max(vec3(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076926660 * s
  ), 0.0);
}

float goldAt(vec2 uv) {
  vec2 g = max(texture2D(uGold, uv).rg, 0.0);
  return g.x + g.y;
}

// Paint thickness (0..1) from the paint amount.
float thickness(float a) {
  return 1.0 - exp(-a * 1.4);
}

void main() {
  vec4 d = dyeAt(vUv);
  vec2 e = uDyeTexel * 1.25;
  vec4 dL = dyeAt(vUv - vec2(e.x, 0.0));
  vec4 dR = dyeAt(vUv + vec2(e.x, 0.0));
  vec4 dB = dyeAt(vUv - vec2(0.0, e.y));
  vec4 dT = dyeAt(vUv + vec2(0.0, e.y));

  // --- height field and normal (central differences on paint thickness)
  vec2 g = max(texture2D(uGold, vUv).rg, 0.0);
  float gold = g.x + g.y;
  // gold is a little thicker than the acrylic, so it stands proud of it
  float h = thickness(d.a + gold * 1.2);
  float hL = thickness(dL.a + goldAt(vUv - vec2(e.x, 0.0)) * 1.2);
  float hR = thickness(dR.a + goldAt(vUv + vec2(e.x, 0.0)) * 1.2);
  float hB = thickness(dB.a + goldAt(vUv - vec2(0.0, e.y)) * 1.2);
  float hT = thickness(dT.a + goldAt(vUv + vec2(0.0, e.y)) * 1.2);
  vec3 n = normalize(vec3((hL - hR) * 5.0, (hB - hT) * 5.0, 1.0));

  // --- paint colour, with crisper borders between pours
  vec3 c = colourOf(d);
  vec3 cL = colourOf(dL), cR = colourOf(dR), cB = colourOf(dB), cT = colourOf(dT);
  vec3 mean = (cL + cR + cB + cT) * 0.25;
  vec3 lab = c + (c - mean) * 0.9;
  lab.x = clamp(lab.x, 0.0, 1.0);
  lab.yz *= uVibrance;
  vec3 paint = oklabToLinear(lab);

  // gold covers the acrylic where there is about as much of it as paint
  // (a crisp edge, and thin traces not at all, so it never tints into beige)
  float metal = smoothstep(0.36, 0.5, gold / (gold + 0.5 * d.a + 0.03)) * smoothstep(0.06, 0.16, gold);
  vec3 goldCol = mix(cGold, cGoldDeep, g.y / max(gold, 1e-4));

  // --- lacing: veins where the colour changes quickly between pours
  // (measured in Oklab, so the veins follow perceived colour differences)
  float edge = length(cR - cL) + length(cT - cB);
  float lace = smoothstep(0.06, 0.3, edge);
  // thin dark rim where paint thins out over the ground
  float rim = smoothstep(0.16, 0.36, h) * smoothstep(0.58, 0.36, h);

  // --- ground: deep navy with a faint, slowly drifting mottling
  vec2 q = vUv * vec2(uAspect, 1.0);
  float mottle = 0.5 + 0.5 * snoise(vec3(q * 2.2, uTime * 0.03));
  vec3 ground = mix(cDeep, cNavy, 0.35 + 0.5 * mottle);

  float cover = smoothstep(0.22, 0.7, h);
  vec3 col = mix(ground, paint, cover);
  float veins = clamp(lace * 0.8 + rim * 0.7, 0.0, 1.0) * smoothstep(0.08, 0.35, h);
  // veins are a dark ultramarine, faintly tinted by the paint around them
  vec3 veinCol = mix(cDeep, mix(cNavy, paint, 0.3) * 0.5, 0.5);
  veinCol = mix(veinCol, cGoldDeep * 0.35, smoothstep(0.1, 0.5, gold) * 0.5); // bronze next to gold
  col = mix(col, veinCol, veins);

  // --- glossy acrylic lighting
  vec3 L = normalize(vec3(-0.5, 0.65, 0.8));
  vec3 V = vec3(0.0, 0.0, 1.0);
  vec3 H = normalize(L + V);
  float diff = 0.82 + 0.3 * dot(n, L);
  float spec = pow(max(dot(n, H), 0.0), 70.0);
  float sheen = pow(1.0 - n.z, 1.5); // grazing slopes catch a soft sheen of their own colour
  col *= diff;
  col += vec3(0.85, 0.95, 1.0) * spec * 0.55 * cover * (1.0 - metal);
  col += paint * sheen * 0.25 * cover * (1.0 - metal);

  // gilded metal: a reflection that shifts with the surface slope plus a
  // broad warm highlight, so the gold glints as the paint flows
  float env = 0.5 + 0.5 * sin(dot(n.xy, vec2(9.0, 13.0)) + q.y * 3.0 + uTime * 0.2);
  vec3 goldLit = goldCol * (0.85 + 0.55 * env) + cGold * pow(max(dot(n, H), 0.0), 24.0) * (0.6 + 0.8 * uSheen);
  goldLit += vec3(1.0, 0.93, 0.72) * spec * (0.5 + 0.7 * uSheen);
  col = mix(col, goldLit * diff, metal * cover);

  // treble makes the brightest paint glint
  float bright = dot(paint, vec3(0.2126, 0.7152, 0.0722));
  float glint = cover * uTreble * 0.12 * (0.5 + 0.5 * sin(uTime * 7.0 + q.x * 40.0));
  col += (cWhite * bright + cGold * metal * 1.5) * glint;

  // gentle vignette keeps the eye in the centre
  vec2 vq = vUv - 0.5;
  col *= 1.0 - 0.35 * dot(vq, vq) * 2.0;

  gl_FragColor = vec4(max(col, 0.0), 1.0);
}
