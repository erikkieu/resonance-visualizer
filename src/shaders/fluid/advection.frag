// Semi-Lagrangian advection: trace each texel backwards along the velocity
// field and sample the source there (hardware bilinear filtering does the
// interpolation). Dissipation is applied as 1 / (1 + k * dt) per channel.
uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform vec2 texelSize;       // velocity texel size: velocity is in sim texels / second
uniform float dt;
uniform vec4 dissipation;
varying vec2 vUv;

void main() {
  vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
  vec4 result = texture2D(uSource, coord);
  gl_FragColor = result / (1.0 + dissipation * dt);
}
