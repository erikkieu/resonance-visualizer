// Scales a texture (used to partially keep last frame's pressure as a warm
// start for the Jacobi solver).
uniform sampler2D uTexture;
uniform float value;
varying vec2 vUv;

void main() {
  gl_FragColor = value * texture2D(uTexture, vUv);
}
