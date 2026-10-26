// Nebula backdrop at runtime: a lookup into the cubemap baked from sky.frag.
uniform samplerCube tSky;
uniform float uBass;
varying vec3 vDir;

void main() {
  vec3 c = textureCube(tSky, normalize(vDir)).rgb;
  gl_FragColor = vec4(c * (1.0 + 0.15 * uBass), 1.0);
}
