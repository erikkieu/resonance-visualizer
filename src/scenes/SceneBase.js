/**
 * Base class for scenes. Implements the shared clock so every scene follows
 * the core reactivity rule:
 *
 *   sceneTime += dt * (baseSpeed + speedGain * energy)
 *
 * The speed multiplier itself is lerped toward its target so loudness changes
 * never make motion jerk.
 *
 * Scene contract (used by SceneManager):
 *   async init(renderer)   allocate GPU resources
 *   update(dt, audio)      advance simulation / uniforms
 *   render(target|null)    draw into a render target (null = screen)
 *   resize(w, h)           output size in device pixels
 *   setQuality(level)      0 = best ... 3 = lowest (optional)
 *   dispose()              free everything
 *
 * Static-ish properties read by the manager:
 *   renderScale  fraction of the canvas resolution the output target uses
 *   toneMapped   apply ACES in the final composite
 *   exposure     linear exposure before tone mapping
 */
export class SceneBase {
  constructor({ baseSpeed = 0.5, speedGain = 1.0, speedLerp = 1.6 } = {}) {
    this.baseSpeed = baseSpeed;
    this.speedGain = speedGain;
    this.speedLerp = speedLerp;
    this.speed = baseSpeed;
    this.time = 0;
    this.renderScale = 1;
    this.toneMapped = false;
    this.exposure = 1;
    this.quality = 0;
    this.width = 1;
    this.height = 1;
    this.renderer = null;
  }

  /** Advances the scene clock; call at the start of update(). Returns scaled dt. */
  tick(dt, audio) {
    const target = this.baseSpeed + this.speedGain * audio.energy;
    this.speed += (target - this.speed) * (1 - Math.exp(-dt * this.speedLerp));
    const sdt = dt * this.speed;
    this.time += sdt;
    return sdt;
  }

  async init(renderer) {
    this.renderer = renderer;
  }

  update(dt, audio) {
    this.tick(dt, audio);
  }

  render() {}

  resize(width, height) {
    this.width = width;
    this.height = height;
  }

  setQuality(level) {
    this.quality = level;
  }

  dispose() {}
}
