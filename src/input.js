/**
 * Shared pointer state, written by main.js and read by scenes.
 * x/y are 0..1 with y pointing up (GL convention); nx/ny are -1..1.
 * dx/dy accumulate movement since the last frame and are reset by main.js
 * after scenes have updated.
 */
export const pointer = {
  x: 0.5,
  y: 0.5,
  nx: 0,
  ny: 0,
  dx: 0,
  dy: 0,
  down: false,
  /** increments on every pointerdown, so scenes can react once per press */
  pressId: 0,
  /** set by main.js: true once the pointer has moved over the canvas at all */
  active: false,
};

export function resetPointerDeltas() {
  pointer.dx = 0;
  pointer.dy = 0;
}
