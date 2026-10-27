// ---------------------------------------------------------------------------
// Stroke simulation (one texel per stroke): xy = position in painting
// space, z = life phase 0..1. Strokes drift along the flow; when a life ends
// they are reborn near their home, so the painting stays recognisable while
// everything keeps moving. The pointer pushes nearby strokes aside like a
// finger dragged through wet paint.
// ---------------------------------------------------------------------------

uniform sampler2D tState;
uniform sampler2D tHome;   // xy home, z size, w random
uniform sampler2D tFlow;
uniform float uDt;         // scene time step (already speed-scaled)
uniform vec2 uLife;        // min / max life in scene seconds
uniform float uSeed;
uniform vec2 uPointer;     // painting space
uniform vec2 uPointerMove; // movement this frame, painting space
uniform float uPointerRadius;
varying vec2 vUv;

void main() {
  ivec2 ij = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(tState, ij, 0);
  vec4 home = texelFetch(tHome, ij, 0);
  vec2 pos = s.xy;

  pos += texture2D(tFlow, toUV(pos)).xy * uDt;

  vec2 d = pos - uPointer;
  float f = exp(-dot(d, d) / (uPointerRadius * uPointerRadius));
  float moved = length(uPointerMove);
  pos += (uPointerMove * 0.8 + normalize(d + 1e-5) * moved * 0.5) * f;

  float life = mix(uLife.x, uLife.y, home.w);
  float phase = s.z + uDt / life;
  if (phase >= 1.0) {
    phase = fract(phase);
    pos = home.xy + (hash22(vec2(ij) + uSeed) - 0.5) * 0.012;
  }
  gl_FragColor = vec4(pos, phase, 1.0);
}
