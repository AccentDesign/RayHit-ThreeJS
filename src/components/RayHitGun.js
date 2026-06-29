/**
 * RayHitGun — raycast shooting. Casts a ray through the
 * physics world; on hit it demolishes a demolishable RayHitRigid at the impact
 * point (or knocks a connectivity shard loose) and applies an impulse.
 *
 *   const gun = new RayHitGun(man, { impulse: 25, demolish: true, connectivity: con });
 *   gun.shoot([camX,camY,camZ], [dirX,dirY,dirZ]);   // returns the hit or null
 */
export class RayHitGun {
  constructor(man, opts = {}) {
    this.man = man;
    this.phys = man.physics;
    this.impulse = opts.impulse ?? 20;
    this.maxDistance = opts.maxDistance ?? 1000;
    this.demolish = opts.demolish !== false;
    this.connectivity = opts.connectivity || null;
    this.knockRadius = opts.knockRadius ?? 1;
  }

  /** Fire from `origin` along `dir`. Returns { object, point, normal, distance } or null. */
  shoot(origin, dir) {
    if (!this.phys) return null;
    let dx = dir[0], dy = dir[1], dz = dir[2];
    const l = Math.hypot(dx, dy, dz) || 1; dx /= l; dy /= l; dz /= l;
    const hit = this.phys.raycast(origin, [dx, dy, dz], this.maxDistance);
    if (!hit || !hit.object) return null;
    const obj = hit.object;
    const rg = obj.userData.rigid;

    if (this.demolish && rg && rg.demolition && rg.demolition.enabled && !rg.demolished) {
      // blow the fragments through in the shot direction so the hit leaves a hole
      rg.demolish({ point: hit.point, velocity: [dx * this.impulse, dy * this.impulse, dz * this.impulse] });
    } else if (this.connectivity && this.connectivity.byMesh.has(obj)) {
      this.connectivity.activateAt(hit.point, this.knockRadius, 4);
    }
    if (obj.userData.__rhbody) {
      this.phys.applyImpulse(obj, [dx * this.impulse, dy * this.impulse, dz * this.impulse], hit.point);
    }
    return hit;
  }
}
