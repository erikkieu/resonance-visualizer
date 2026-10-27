// ---------------------------------------------------------------------------
// Starry Night: shared helpers.
// Painting space: x = u * uAspect, y = v (0 at the bottom), where (u, v) are
// the reference painting's coordinates with the unpainted border trimmed.
// All distances (stroke sizes, radii, flow) are in painting heights.
// ---------------------------------------------------------------------------

uniform float uAspect; // painting width / height
uniform vec4 uTrim;    // reference uv = uTrim.xy + uv * uTrim.zw

vec2 toUV(vec2 p) {
  return vec2(p.x / uAspect, p.y);
}

vec2 refUV(vec2 uv) {
  return uTrim.xy + uv * uTrim.zw;
}

float luma(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}
