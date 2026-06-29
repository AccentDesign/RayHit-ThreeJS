/**
 * RayHitBomb — radial explosion force. Applies an
 * outward impulse to every physics body within `radius`, with distance falloff
 * and randomised "chaos", and can demolish demolishable RayHitRigid objects in
 * range before throwing the resulting fragments outward.
 *
 *   const bomb = new RayHitBomb(man, { radius: 6, strength: 20, demolish: true });
 *   await bomb.explode([x, y, z]);
 */
export class RayHitBomb {
  constructor(man, options = {}) {
    this.man = man;
    this.radius = options.radius ?? 5;
    this.strength = options.strength ?? 15;       // impulse magnitude at epicentre
    this.falloff = options.falloff || 'linear';   // 'linear' | 'none' | 'exponential'
    this.chaos = options.chaos ?? 0.3;            // 0..1 random variation
    this.upwardBias = options.upwardBias ?? 0.2;  // extra upward push
    this.demolish = options.demolish !== false;   // demolish demolishable targets
    this.affectFragments = options.affectFragments !== false;
  }

  _factor(dist) {
    const t = Math.min(1, dist / this.radius);
    if (this.falloff === 'none') return 1;
    if (this.falloff === 'exponential') return (1 - t) * (1 - t);
    return 1 - t; // linear
  }

  async explode(position) {
    const man = this.man, phys = man.physics, THREE = man.THREE;
    if (!phys) return;
    const pos = new THREE.Vector3(position[0], position[1], position[2]);

    // 1. demolish demolishable rigids whose centre is in range
    if (this.demolish) {
      const targets = [];
      for (const r of man.rigids) {
        if (!r.demolition || !r.demolition.enabled || r.demolished) continue;
        const p = r.mesh.getWorldPosition(new THREE.Vector3());
        if (p.distanceTo(pos) <= this.radius) targets.push(r);
      }
      for (const r of targets) await r.demolish({ point: position, velocity: [0, 0, 0] });
    }

    // 2. apply outward impulse to all bodies in range
    const bodies = phys.bodies ? [...phys.bodies.keys()] : [];
    for (const obj of bodies) {
      const p = obj.getWorldPosition(new THREE.Vector3());
      const dir = p.clone().sub(pos);
      const dist = dir.length();
      if (dist > this.radius) continue;
      if (dist < 1e-5) { dir.set(0, 1, 0); } else dir.multiplyScalar(1 / dist);
      dir.y += this.upwardBias;
      dir.normalize();
      const chaos = 1 + (Math.random() - 0.5) * 2 * this.chaos;
      const mag = this.strength * this._factor(dist) * chaos;
      phys.applyImpulse(obj, [dir.x * mag, dir.y * mag, dir.z * mag], [p.x, p.y, p.z]);
    }
  }
}
