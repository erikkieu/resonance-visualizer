// Light-point quad: centred coordinates (-1..1) and the world position, for
// the galaxy disk's occlusion in light.frag.
varying vec2 vUv;
varying vec3 vWorld;

void main() {
  vUv = uv * 2.0 - 1.0;
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
