// Background stars behind the galaxy: the disk (centred at the origin, normal
// uDiskNormal, radius uDiskRadius in world units) hides what lies behind it.
// Additive points can't occlude each other, so each star casts its own ray
// to the camera and dims if that ray crosses the disk, softly toward the
// rim where the galaxy thins out.
uniform vec3 uDiskNormal;
uniform float uDiskRadius;
uniform float uOcclude;

float diskShadow(vec3 worldPos) {
  vec3 d = worldPos - cameraPosition;
  float denom = dot(d, uDiskNormal);
  if (abs(denom) < 1e-5) return 0.0;
  float s = -dot(cameraPosition, uDiskNormal) / denom;
  if (s <= 0.0 || s >= 1.0) return 0.0;
  float r = length(cameraPosition + d * s) / uDiskRadius;
  return uOcclude * (1.0 - smoothstep(0.45, 1.0, r));
}
