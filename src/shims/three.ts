/**
 * `three` is aliased to this module (see next.config.ts) so the whole app —
 * including @react-three/fiber's internal `import * as THREE from "three"` —
 * shares the single WebGPU build of three.js.
 *
 * R3F statically references `THREE.WebGLRenderer` in its default-renderer
 * code path (never taken here, we always supply a `gl` factory), and
 * Turbopack rejects statically-missing exports. WebGPURenderer doubles as
 * that export: it *is* the universal renderer, with a WebGL2 fallback inside.
 */
export * from "three/webgpu";
export { WebGPURenderer as WebGLRenderer } from "three/webgpu";
