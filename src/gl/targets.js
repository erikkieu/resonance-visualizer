import * as THREE from 'three';

/** Creates an HDR-capable render target without mipmaps or (by default) depth. */
export function createTarget(width, height, opts = {}) {
  const {
    type = THREE.HalfFloatType,
    format = THREE.RGBAFormat,
    filter = THREE.LinearFilter,
    depth = false,
    wrap = THREE.ClampToEdgeWrapping,
  } = opts;
  const rt = new THREE.WebGLRenderTarget(Math.max(1, width | 0), Math.max(1, height | 0), {
    type,
    format,
    minFilter: filter,
    magFilter: filter,
    wrapS: wrap,
    wrapT: wrap,
    depthBuffer: depth,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  rt.texture.colorSpace = THREE.NoColorSpace;
  return rt;
}

/**
 * A ping-pong pair: read from `read`, render into `write`, then swap().
 * Used by every stateful pass of the fluid simulation.
 */
export class DoubleTarget {
  constructor(width, height, opts) {
    this.opts = opts;
    this.read = createTarget(width, height, opts);
    this.write = createTarget(width, height, opts);
  }

  get width() {
    return this.read.width;
  }

  get height() {
    return this.read.height;
  }

  swap() {
    const t = this.read;
    this.read = this.write;
    this.write = t;
  }

  dispose() {
    this.read.dispose();
    this.write.dispose();
  }
}

/** True when the GPU can render into half-float textures (needed by the fluid sim and HDR). */
export function supportsHalfFloatTargets(renderer) {
  const ext = renderer.extensions;
  return ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float');
}
