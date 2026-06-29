/**
 * rayhit-three — runtime mesh fracturing & physics destruction for three.js.
 * Voronoi/slice fragmentation + a pluggable-physics destruction toolkit.
 *
 * Two layers:
 *  1. Geometry kernel (no three.js, no physics) — Voronoi/slice fracturing.
 *  2. three.js + pluggable-physics layer — shatter(), RayHitMan, RayHitRigid,
 *     RayHitBomb, fade.
 */

// ---- geometry kernel (engine-agnostic) ----
export { MeshData } from './fragment/MeshData.js';
export { fragment, fragmentAsync, FragType } from './fragment/fragmenter.js';
export { sliceMesh } from './fragment/slicer.js';
export { Voronoi } from './core/Voronoi.js';
export { ConvexCell } from './core/ConvexCell.js';
export { Rng } from './math/random.js';
export {
  randomPoints, gridPoints, radialPoints, tetPoints, hexPoints,
  applyCenterBias, splinterWeights, sampleInsidePoints,
} from './fragment/scatter.js';

// ---- three.js high-level API ----
export { shatter, shatterAsync, fractureToGeometries, setThree } from './api/shatter.js';

// ---- components ----
export { RayHitMan } from './components/RayHitMan.js';
export { RayHitRigid } from './components/RayHitRigid.js';
export { RayHitBomb } from './components/RayHitBomb.js';
export { RayHitConnectivity } from './components/RayHitConnectivity.js';
export { RayHitGun } from './components/RayHitGun.js';
export { RayHitBlade } from './components/RayHitBlade.js';
export { RayHitParticles } from './effects/particles.js';

// ---- physics adapters ----
export { PhysicsAdapter, NullAdapter } from './physics/PhysicsAdapter.js';
export { RapierAdapter } from './physics/RapierAdapter.js';
export { CannonAdapter } from './physics/CannonAdapter.js';

// ---- data / enums ----
export {
  MaterialType, MATERIALS, getMaterial, massFor,
  FadeType, SimType, DemolitionType,
} from './effects/materials.js';
