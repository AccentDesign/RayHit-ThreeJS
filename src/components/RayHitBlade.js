/**
 * RayHitBlade — slice an object in two along a plane.
 * Reuses the geometry kernel's plane-slice (FragType.Slices) to split the mesh,
 * caps both new faces with the inner material, spawns the two halves as dynamic
 * rigids that push apart along the cut, and removes the original.
 *
 *   const blade = new RayHitBlade(man);
 *   await blade.cut(rigid, worldPoint, worldNormal);   // returns [rigidA, rigidB]
 */
import { MeshData } from '../fragment/MeshData.js';
import { fragment as fractureGeometry } from '../fragment/fragmenter.js';
import { getMaterial, massFor, MaterialType, SimType } from '../effects/materials.js';
import { RayHitRigid } from './RayHitRigid.js';

export class RayHitBlade {
  constructor(man, opts = {}) {
    this.man = man;
    this.phys = man.physics;
    this.THREE = man.THREE;
    this.innerMaterial = opts.innerMaterial || null;
    this.separation = opts.separation ?? 1.0; // outward push speed of the halves
  }

  /** Slice `rigid` by the world-space plane (point, normal). Returns new rigids. */
  async cut(rigid, point, normal, opts = {}) {
    const THREE = this.THREE, man = this.man, phys = this.phys;
    const mesh = rigid.mesh || rigid;
    const rg = mesh.userData.rigid || (rigid.mesh ? rigid : null);
    mesh.updateWorldMatrix(true, false);

    // plane to local space (point + direction)
    const lp = mesh.worldToLocal(new THREE.Vector3(point[0], point[1], point[2]));
    const lp2 = mesh.worldToLocal(new THREE.Vector3(point[0] + normal[0], point[1] + normal[1], point[2] + normal[2]));
    const ln = new THREE.Vector3().subVectors(lp2, lp).normalize();
    const c = ln.dot(lp);

    const md = MeshData.fromBufferGeometry(mesh.geometry);
    const origMats = Array.isArray(mesh.material) ? mesh.material.slice() : [mesh.material];
    md.clampMaterials(origMats.length - 1);
    const innerIndex = origMats.length;
    const res = fractureGeometry(md, { type: 'slices', planes: [{ n: [ln.x, ln.y, ln.z], c }], innerMatIndex: innerIndex });
    if (res.fragments.length < 2) return null; // plane missed the mesh

    const inner = this.innerMaterial || origMats[0] || new THREE.MeshStandardMaterial({ color: 0x888888 });
    const matArray = [...origMats, inner];
    const wq = mesh.getWorldQuaternion(new THREE.Quaternion());
    const ws = mesh.getWorldScale(new THREE.Vector3());
    const parent = mesh.parent || man.scene;
    const vel = (rg && phys) ? phys.getLinearVelocity(mesh) : [0, 0, 0];
    const materialType = (rg && rg.materialType) || opts.material || MaterialType.Concrete;
    const worldNormal = new THREE.Vector3(normal[0], normal[1], normal[2]).normalize();

    const created = [];
    for (const f of res.fragments) {
      const g = await f.mesh.toBufferGeometry(THREE);
      const fm = new THREE.Mesh(g, matArray);
      fm.castShadow = mesh.castShadow; fm.receiveShadow = mesh.receiveShadow;
      fm.position.copy(mesh.localToWorld(new THREE.Vector3(f.pivot[0], f.pivot[1], f.pivot[2])));
      fm.quaternion.copy(wq); fm.scale.copy(ws);
      parent.add(fm);
      const child = new RayHitRigid(fm, man, { simType: SimType.Dynamic, material: materialType, collider: 'hull' });
      child.init(); man.rigids.add(child);
      if (phys) {
        // which side of the cut plane is this half on? push it that way.
        const side = Math.sign(worldNormal.dot(fm.position.clone().sub(new THREE.Vector3(point[0], point[1], point[2])))) || 1;
        phys.setLinearVelocity(fm, [
          vel[0] + worldNormal.x * this.separation * side,
          vel[1] + worldNormal.y * this.separation * side,
          vel[2] + worldNormal.z * this.separation * side,
        ]);
      }
      man.registerFragment(child);
      created.push(child);
    }

    if (rg) rg.demolished = true;
    if (phys) phys.removeBody(mesh);
    if (mesh.parent) mesh.parent.remove(mesh);
    man.rigids.delete(rg);
    return created;
  }
}
