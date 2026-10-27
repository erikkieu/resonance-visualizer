// ---------------------------------------------------------------------------
// Wet-paint canvas feedback (painting space). Each frame the canvas is
// smeared a little along the flow, then relaxes
// slowly toward a heavily blurred underpainting, so trails linger for a few
// seconds before the strokes painted on top renew them.
// While the painting paints itself it relaxes instead toward what exists so
// far: black, the primer wash, the ground under not-yet-painted layers, and
// the underpainting only where the painter has already been (tRank).
// ---------------------------------------------------------------------------

uniform sampler2D tCanvas;
uniform sampler2D tFlow;
uniform sampler2D tRef;
uniform float uDt;          // scene time step
uniform float uSmear;       // fraction of the flow the paint itself follows
uniform float uFade;        // relaxation toward the underpainting, per scene second
uniform sampler2D tMask;    // a = buildings: a sharper underpainting keeps their edges
uniform sampler2D tRank;    // r = when the painting here is painted, g = its ground, b = land
uniform float uCover;       // coverage now (0 black .. 1 finished)
uniform vec2 uPrimer;       // coverage over which the primer wash fades in
uniform vec2 uSettle;       // the underpainting settles in: lag behind the strokes, softness (coverage)
uniform vec3 uPrimerColor;
uniform vec3 uSkyGround;
uniform vec3 uLandGround;
varying vec2 vUv;

void main() {
  vec2 back = texture2D(tFlow, vUv).xy * uDt * uSmear;
  vec3 c = texture2D(tCanvas, vUv - vec2(back.x / uAspect, back.y)).rgb;
  vec3 under = textureLod(tRef, refUV(vUv), mix(3.8, 1.6, texture2D(tMask, vUv).a)).rgb;
  vec4 rk = texture2D(tRank, vUv);
  vec3 target = uPrimerColor * smoothstep(uPrimer.x, uPrimer.y, uCover);
  target = mix(target, mix(uSkyGround, uLandGround, rk.b), smoothstep(rk.g, rk.g + uSettle.y, uCover));
  float e = min(rk.r + uSettle.x, 1.0 - uSettle.y); // the last strokes settle by coverage 1
  target = mix(target, under, smoothstep(e, e + uSettle.y, uCover));
  c = mix(c, target, 1.0 - exp(-uFade * uDt));
  gl_FragColor = vec4(c, 1.0);
}
