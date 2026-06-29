/**
 * shatter() — the high-level Three.js entry point, equivalent to dropping a
 * RayHitShatter component on an object and pressing "Fragment".
 *
 * Converts a THREE.Mesh into a Group of fragment meshes. Each fragment gets its
 * own geometry (recentered to its pivot) and a material array equal to the
 * original materials plus an appended "inner" material applied to the cut
 * surfaces — exactly like inner-material workflow.
 *
 * Returns { group, fragments } where `fragments` is an array of
 * { mesh, pivot, volume } in the original mesh's local space; the group is
 * placed at the original mesh's world transform so fragments overlay it.
 */
import { MeshData } from '../fragment/MeshData.js';
import { fragment as fractureGeometry, fragmentAsync } from '../fragment/fragmenter.js';

let _THREE = null;
export function setThree(THREE) { _THREE = THREE; }
async function getThree(opt) {
  if (opt && opt.THREE) return opt.THREE;
  if (_THREE) return _THREE;
  _THREE = await import('three');
  return _THREE;
}

export async function shatter(mesh, options = {}) {
  const THREE = await getThree(options);
  const geom = mesh.geometry;
  if (!geom) throw new Error('shatter: mesh has no geometry');
  const md = MeshData.fromBufferGeometry(geom);
  const origMats = Array.isArray(mesh.material) ? mesh.material.slice() : [mesh.material];
  md.clampMaterials(origMats.length - 1);
  const result = fractureGeometry(md, { ...options, innerMatIndex: origMats.length });
  return _buildGroup(THREE, mesh, result, origMats, options);
}

/**
 * Async variant — fractures off the critical path, yielding to the event loop so
 * a large shatter doesn't freeze the frame. `options.onProgress(t)` reports 0..1.
 * Same return shape as shatter().
 */
export async function shatterAsync(mesh, options = {}) {
  const THREE = await getThree(options);
  const geom = mesh.geometry;
  if (!geom) throw new Error('shatterAsync: mesh has no geometry');
  const md = MeshData.fromBufferGeometry(geom);
  const origMats = Array.isArray(mesh.material) ? mesh.material.slice() : [mesh.material];
  md.clampMaterials(origMats.length - 1);
  const result = await fragmentAsync(md, { ...options, innerMatIndex: origMats.length });
  return _buildGroup(THREE, mesh, result, origMats, options, true);
}

/** Shared: turn a kernel fragment result into a Group of THREE fragment meshes. */
async function _buildGroup(THREE, mesh, result, origMats, options, yieldEvery = false) {
  const innerMaterial = options.innerMaterial
    || (origMats[0] ? origMats[0] : new THREE.MeshStandardMaterial({ color: 0x886655 }));
  const matArray = [...origMats, innerMaterial];

  mesh.updateWorldMatrix(true, false);
  // Bake the original mesh's WORLD transform into each fragment so fragments can
  // be re-parented into any container and stay correctly placed (and so physics,
  // which reads world transforms, sees the right positions).
  const worldQuat = mesh.getWorldQuaternion(new THREE.Quaternion());
  const worldScale = mesh.getWorldScale(new THREE.Vector3());

  const group = new THREE.Group();
  group.name = (mesh.name || 'mesh') + '_fragments';

  const fragments = [];
  for (let i = 0; i < result.fragments.length; i++) {
    const f = result.fragments[i];
    const g = await f.mesh.toBufferGeometry(THREE);
    const fm = new THREE.Mesh(g, matArray);
    fm.name = `${mesh.name || 'frag'}_${i + 1}`;
    fm.position.copy(mesh.localToWorld(new THREE.Vector3(f.pivot[0], f.pivot[1], f.pivot[2])));
    fm.quaternion.copy(worldQuat);
    fm.scale.copy(worldScale);
    fm.castShadow = mesh.castShadow;
    fm.receiveShadow = mesh.receiveShadow;
    fm.userData.rayhit = { pivot: f.pivot, volume: f.volume, index: i };
    group.add(fm);
    fragments.push({ mesh: fm, pivot: f.pivot, volume: f.volume });
    if (yieldEvery && (i & 15) === 15) await new Promise(r => setTimeout(r, 0));
  }
  return { group, fragments, materials: matArray };
}

/**
 * Convenience: fragment a geometry into an array of plain BufferGeometries
 * (no THREE.Mesh wrappers, no materials). Useful for instancing/custom pipelines.
 */
export async function fractureToGeometries(geometry, options = {}) {
  const THREE = await getThree(options);
  const md = MeshData.fromBufferGeometry(geometry);
  const result = fractureGeometry(md, options);
  const out = [];
  for (const f of result.fragments) {
    const g = await f.mesh.toBufferGeometry(THREE);
    out.push({ geometry: g, pivot: f.pivot, volume: f.volume });
  }
  return out;
}
