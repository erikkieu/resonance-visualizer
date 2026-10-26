import * as THREE from 'three';
import fullscreenVert from '../shaders/fullscreen.vert?raw';

/**
 * One oversized triangle that covers clip space. Cheaper than a quad (no
 * diagonal seam, fewer helper invocations) and shared by every pass.
 * uv runs 0..1 across the visible screen.
 */
const geometry = new THREE.BufferGeometry();
geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));

const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

export { fullscreenVert };

/**
 * renderer.compileAsync with a time limit. Parallel shader compilation can
 * stall indefinitely while the GPU is saturated (seen on ANGLE/Metal with an
 * uncapped frame rate), so after `ms` we stop waiting; any shader that is
 * still pending simply finishes compiling on its first draw.
 */
export async function precompile(renderer, scene, cam = camera, ms = 1500) {
  let timer;
  const timeout = new Promise((resolve) => (timer = setTimeout(resolve, ms)));
  try {
    await Promise.race([renderer.compileAsync(scene, cam), timeout]);
  } catch {
    /* compile on first use instead */
  } finally {
    clearTimeout(timer);
  }
}

/** Creates a ShaderMaterial for a fullscreen pass with sane defaults. */
export function passMaterial({ fragmentShader, vertexShader = fullscreenVert, uniforms = {}, defines = {}, blending }) {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms,
    defines,
    depthTest: false,
    depthWrite: false,
    blending: blending ?? THREE.NoBlending,
  });
}

/**
 * Renders a material over the whole target. The material can be swapped per
 * call, which is how the fluid solver chains its many passes through one mesh.
 */
export class FullscreenPass {
  constructor(material = null) {
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
  }

  render(renderer, material, target) {
    if (material) this.mesh.material = material;
    renderer.setRenderTarget(target ?? null);
    renderer.render(this.mesh, camera);
  }

  /** Compiles materials ahead of time so the first frame does not hitch. */
  async compile(renderer, materials) {
    const scene = new THREE.Scene();
    for (const m of materials) {
      const mesh = new THREE.Mesh(geometry, m);
      mesh.frustumCulled = false;
      scene.add(mesh);
    }
    await precompile(renderer, scene);
  }
}
