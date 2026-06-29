/**
 * PhysicsAdapter — the abstract physics interface the destruction components
 * talk to. Keeping it abstract means the geometry/destruction logic is engine
 * agnostic: ship the Rapier adapter (default), the cannon-es adapter, or write
 * your own. RayHitMan drives it; RayHitRigid/RayHitBomb call into it.
 *
 * Bodies are associated with THREE.Object3D instances. Implementations store
 * their native handle on `object.userData.__rhbody` and keep a registry so they
 * can sync transforms back to the objects each step.
 *
 * Body descriptor (addBody):
 *   { type:'dynamic'|'static'|'kinematic',
 *     shape:'hull'|'box'|'sphere'|'trimesh',
 *     mass?, density?, friction?, restitution?, linearDamping?, angularDamping?,
 *     linvel?:[x,y,z], angvel?:[x,y,z] }
 */
export class PhysicsAdapter {
  constructor(opts = {}) {
    this.gravity = opts.gravity || [0, -9.81, 0];
    this.contactListeners = [];
  }

  /** async — load the engine and create the world. */
  async init() { throw new Error('PhysicsAdapter.init not implemented'); }

  /** Create a body for object3d. Returns an opaque handle (also on userData). */
  addBody(object3d, desc) { throw new Error('addBody not implemented'); }

  /** Remove the body associated with object3d (or handle). */
  removeBody(object3d) { throw new Error('removeBody not implemented'); }

  /** Step the simulation by dt seconds, fire contact events, sync transforms. */
  step(dt) { throw new Error('step not implemented'); }

  setBodyType(object3d, type) {}
  setLinearVelocity(object3d, v) {}
  setAngularVelocity(object3d, v) {}
  getLinearVelocity(object3d) { return [0, 0, 0]; }
  applyImpulse(object3d, impulse, worldPoint) {}
  applyForce(object3d, force, worldPoint) {}
  setEnabled(object3d, enabled) {}

  /** Raycast; returns { object, point:[x,y,z], normal:[x,y,z], distance } or null. */
  raycast(origin, dir, maxDistance = 1000) { return null; }

  /**
   * Register a contact callback fired during step():
   *   cb(objectA, objectB, impulseMagnitude, contactPoint:[x,y,z])
   * impulseMagnitude is the total contact force/impulse magnitude, used by
   * RayHitRigid to decide whether a collision is strong enough to demolish.
   */
  onContact(cb) { this.contactListeners.push(cb); return () => {
    const i = this.contactListeners.indexOf(cb); if (i >= 0) this.contactListeners.splice(i, 1);
  }; }

  _emitContact(a, b, impulse, point) {
    for (const cb of this.contactListeners) cb(a, b, impulse, point);
  }
}

/** No-op adapter — lets components run without a physics engine (static preview). */
export class NullAdapter extends PhysicsAdapter {
  async init() { return this; }
  addBody() { return null; }
  removeBody() {}
  step() {}
}
