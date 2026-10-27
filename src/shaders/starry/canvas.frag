// ---------------------------------------------------------------------------
// Wet-paint canvas feedback (painting space). Each frame the canvas is
// smeared a little along the flow (and along the pointer), then relaxes
// slowly toward a heavily blurred underpainting, so trails linger for a few
// seconds before the strokes painted on top renew them.
// ---------------------------------------------------------------------------

uniform sampler2D tCanvas;
uniform sampler2D tFlow;
uniform sampler2D tRef;
uniform float uDt;          // scene time step
uniform float uSmear;       // fraction of the flow the paint itself follows
uniform float uFade;        // relaxation toward the underpainting, per scene second
uniform vec2 uPointer;
uniform vec2 uPointerMove;
uniform float uPointerRadius;
varying vec2 vUv;

void main() {
  vec2 p = vec2(vUv.x * uAspect, vUv.y);
  vec2 back = texture2D(tFlow, vUv).xy * uDt * uSmear;
  vec2 d = p - uPointer;
  back += uPointerMove * 0.9 * exp(-dot(d, d) / (uPointerRadius * uPointerRadius));
  vec3 c = texture2D(tCanvas, vUv - vec2(back.x / uAspect, back.y)).rgb;
  vec3 under = textureLod(tRef, refUV(vUv), 3.8).rgb;
  c = mix(c, under, 1.0 - exp(-uFade * uDt));
  gl_FragColor = vec4(c, 1.0);
}
