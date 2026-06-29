/**
 * CannonAdapter — PhysicsAdapter backed by cannon-es (pure JS, no WASM).
 * A lighter-weight alternative to Rapier when you don't want a WASM dependency.
 * Convex-hull colliders are built with ConvexPolyhedron from each fragment's
 * geometry; collision demolition uses cannon's `collide` events with the
 * contact impulse (`contactEquation.getImpactVelocityAlongNormal`).
 *
 * Usage:
 *   import * as CANNON from 'cannon-es';
 *   const phys = new CannonAdapter(CANNON, { gravity:[0,-9.81,0], THREE });
 *   await phys.init();
 */
import { PhysicsAdapter } from './PhysicsAdapter.js';

export class CannonAdapter extends PhysicsAdapter {
  constructor(CANNON, opts = {}) {
    super(opts);
    this.CANNON = CANNON || opts.CANNON;
    this._THREE = opts.THREE || null;
    this.world = null;
    this.bodies = new Map();          // object3d -> CANNON.Body
    this.bodyToObj = new Map();       // CANNON.Body.id -> object3d
    this.impactThreshold = opts.impactThreshold ?? 0; // m/s along normal
  }

  async init() {
    const C = this.CANNON;
    if (!C) throw new Error('CannonAdapter: pass the cannon-es module');
    this.world = new C.World({ gravity: new C.Vec3(...this.gravity) });
    this.world.broadphase = new C.SAPBroadphase(this.world);
    this.world.allowSleep = true;
    return this;
  }

  _shape(object3d, desc) {
    const C = this.CANNON;
    const shape = desc.shape || 'hull';
    const geom = object3d.geometry;
    const s = object3d.getWorldScale(new (this._vec3())());
    if (shape === 'box' || !geom) {
      const e = this._halfExtents(object3d);
      return new C.Box(new C.Vec3(Math.max(1e-3, e[0]), Math.max(1e-3, e[1]), Math.max(1e-3, e[2])));
    }
    if (shape === 'sphere') return new C.Sphere(Math.max(1e-3, desc.radius || this._radius(object3d)));
    // convex hull from geometry vertices
    const pos = geom.getAttribute('position');
    const verts = [], faces = [];
    for (let i = 0; i < pos.count; i++) verts.push(new C.Vec3(pos.getX(i) * s.x, pos.getY(i) * s.y, pos.getZ(i) * s.z));
    const idx = geom.index ? geom.index.array : null;
    if (idx) for (let i = 0; i < idx.length; i += 3) faces.push([idx[i], idx[i + 1], idx[i + 2]]);
    else for (let i = 0; i < pos.count; i += 3) faces.push([i, i + 1, i + 2]);
    try {
      const poly = new C.ConvexPolyhedron({ vertices: verts, faces });
      return poly;
    } catch (e) {
      const ee = this._halfExtents(object3d);
      return new C.Box(new C.Vec3(Math.max(1e-3, ee[0]), Math.max(1e-3, ee[1]), Math.max(1e-3, ee[2])));
    }
  }

  addBody(object3d, desc = {}) {
    const C = this.CANNON;
    object3d.updateWorldMatrix(true, false);
    const p = object3d.getWorldPosition(new (this._vec3())());
    const q = object3d.getWorldQuaternion(new (this._quat())());
    const type = desc.type || 'dynamic';
    const shape = this._shape(object3d, desc);
    let mass = desc.mass;
    if (mass == null && desc.density != null) mass = Math.max(1e-3, desc.density * (object3d.userData.rayhit?.volume || 1));
    if (type !== 'dynamic') mass = 0;
    const body = new C.Body({
      mass: mass ?? 1,
      type: type === 'kinematic' ? C.Body.KINEMATIC : type === 'static' ? C.Body.STATIC : C.Body.DYNAMIC,
      position: new C.Vec3(p.x, p.y, p.z),
      quaternion: new C.Quaternion(q.x, q.y, q.z, q.w),
      linearDamping: desc.linearDamping || 0.01,
      angularDamping: desc.angularDamping || 0.05,
      material: new C.Material({ friction: desc.friction ?? 0.5, restitution: desc.restitution ?? 0.2 }),
    });
    body.addShape(shape);
    if (desc.linvel) body.velocity.set(desc.linvel[0], desc.linvel[1], desc.linvel[2]);
    if (desc.angvel) body.angularVelocity.set(desc.angvel[0], desc.angvel[1], desc.angvel[2]);
    this.world.addBody(body);
    object3d.userData.__rhbody = body;
    body.__type = type;
    this.bodies.set(object3d, body);
    this.bodyToObj.set(body.id, object3d);
    if (this.contactListeners.length) {
      body.addEventListener('collide', (e) => {
        const other = this.bodyToObj.get(e.body.id);
        const imp = e.contact ? Math.abs(e.contact.getImpactVelocityAlongNormal()) : 0;
        this._emitContact(object3d, other, imp, null);
      });
    }
    return body;
  }

  removeBody(object3d) {
    const b = this.bodies.get(object3d); if (!b) return;
    this.world.removeBody(b); this.bodies.delete(object3d); this.bodyToObj.delete(b.id);
    delete object3d.userData.__rhbody;
  }
  setBodyType(o, type) { const b = this.bodies.get(o); if (!b) return; const C = this.CANNON; b.type = type === 'kinematic' ? C.Body.KINEMATIC : type === 'static' ? C.Body.STATIC : C.Body.DYNAMIC; if (type !== 'dynamic') b.mass = 0; b.updateMassProperties(); b.__type = type; }
  setLinearVelocity(o, v) { const b = this.bodies.get(o); if (b) { b.wakeUp(); b.velocity.set(v[0], v[1], v[2]); } }
  setAngularVelocity(o, v) { const b = this.bodies.get(o); if (b) b.angularVelocity.set(v[0], v[1], v[2]); }
  getLinearVelocity(o) { const b = this.bodies.get(o); return b ? [b.velocity.x, b.velocity.y, b.velocity.z] : [0, 0, 0]; }
  applyImpulse(o, imp, point) { const b = this.bodies.get(o); if (!b) return; const C = this.CANNON; b.wakeUp(); b.applyImpulse(new C.Vec3(imp[0], imp[1], imp[2]), point ? new C.Vec3(point[0], point[1], point[2]) : b.position); }
  applyForce(o, f, point) { const b = this.bodies.get(o); if (!b) return; const C = this.CANNON; b.applyForce(new C.Vec3(f[0], f[1], f[2]), point ? new C.Vec3(point[0], point[1], point[2]) : b.position); }
  setEnabled(o, en) { const b = this.bodies.get(o); if (b) b.sleepState = en ? 0 : 2; }

  step(dt) {
    this.world.step(1 / 60, dt, 3);
    for (const [obj, b] of this.bodies) {
      if (b.__type === 'static') continue;
      obj.position.set(b.position.x, b.position.y, b.position.z);
      obj.quaternion.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
    }
  }

  raycast(origin, dir, maxDistance = 1000) {
    const C = this.CANNON;
    const from = new C.Vec3(origin[0], origin[1], origin[2]);
    const to = new C.Vec3(origin[0] + dir[0] * maxDistance, origin[1] + dir[1] * maxDistance, origin[2] + dir[2] * maxDistance);
    const res = new C.RaycastResult();
    this.world.raycastClosest(from, to, {}, res);
    if (!res.hasHit) return null;
    return { object: this.bodyToObj.get(res.body.id), point: [res.hitPointWorld.x, res.hitPointWorld.y, res.hitPointWorld.z], normal: [res.hitNormalWorld.x, res.hitNormalWorld.y, res.hitNormalWorld.z], distance: res.distance };
  }

  _vec3() { return (this._THREE && this._THREE.Vector3) || _Vec3; }
  _quat() { return (this._THREE && this._THREE.Quaternion) || _Quat; }
  _halfExtents(o) { const g = o.geometry; if (!g) return [0.5, 0.5, 0.5]; if (!g.boundingBox) g.computeBoundingBox(); const s = o.getWorldScale(new (this._vec3())()); const bb = g.boundingBox; return [(bb.max.x - bb.min.x) / 2 * s.x, (bb.max.y - bb.min.y) / 2 * s.y, (bb.max.z - bb.min.z) / 2 * s.z]; }
  _radius(o) { const e = this._halfExtents(o); return Math.max(e[0], e[1], e[2]); }
}

class _Vec3 { constructor() { this.x = 0; this.y = 0; this.z = 0; } }
class _Quat { constructor() { this.x = 0; this.y = 0; this.z = 0; this.w = 1; } }
