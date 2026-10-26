// Camera-facing quad used for the core glow, distant galaxies and rings.
varying vec2 vUv;

void main() {
  vUv = uv * 2.0 - 1.0;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
