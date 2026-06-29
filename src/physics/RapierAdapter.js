/**
 * RapierAdapter — PhysicsAdapter backed by Dimforge Rapier 3D (WASM).
 * The recommended default: fast, deterministic, great convex-hull colliders and
 * built-in contact-force events (used to trigger collision demolition).
 *
 * Usage:
 *   import RAPIER from '@dimforge/rapier3d-compat';
 *   await RAPIER.init();
 *   const phys = new RapierAdapter(RAPIER, { gravity:[0,-9.81,0] });
 *   await phys.init();
 * (or pass the module via opts.RAPIER and call init()).
 */
import { PhysicsAdapter } from './PhysicsAdapter.js';

export class RapierAdapter extends PhysicsAdapter {
  constructor(RAPIER, opts = {}) {
    super(opts);
    this.RAPIER = RAPIER || opts.RAPIER || null;
    this.world = null;
    this.eventQueue = null;
    this.bodies = new Map();        // object3d -> { rb, collider }
    this.colliderToObj = new Map(); // collider.handle -> object3d
    this._THREE = opts.THREE || null;
    // contact-force threshold below which events are ignored (perf)
    this.contactForceThreshold = opts.contactForceThreshold ?? 0.0;
  }

  async init() {
    const R = this.RAPIER;
    if (!R) throw new Error('RapierAdapter: pass the RAPIER module to the constructor');
    if (R.init && !R.World) await R.init();    // rapier3d-compat needs init()
    const g = this.gravity;
    this.world = new R.World({ x: g[0], y: g[1], z: g[2] });
    this.eventQueue = new R.EventQueue(true);
    return this;
  }

  addBody(object3d, desc = {}) {
    const R = this.RAPIER, world = this.world;
    object3d.updateWorldMatrix(true, false);
    const p = object3d.getWorldPosition(new (this._vec3())());
    const q = object3d.getWorldQuaternion(new (this._quat())());

    let bodyDesc;
    const type = desc.type || 'dynamic';
    if (type === 'static') bodyDesc = R.RigidBodyDesc.fixed();
    else if (type === 'kinematic') bodyDesc = R.RigidBodyDesc.kinematicPositionBased();
    else bodyDesc = R.RigidBodyDesc.dynamic();
    bodyDesc.setTranslation(p.x, p.y, p.z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
    if (desc.linearDamping) bodyDesc.setLinearDamping(desc.linearDamping);
    if (desc.angularDamping) bodyDesc.setAngularDamping(desc.angularDamping);
    if (desc.linvel) bodyDesc.setLinvel(desc.linvel[0], desc.linvel[1], desc.linvel[2]);
    if (desc.angvel) bodyDesc.setAngvel({ x: desc.angvel[0], y: desc.angvel[1], z: desc.angvel[2] });
    if (desc.ccd) bodyDesc.setCcdEnabled(true);
    const rb = world.createRigidBody(bodyDesc);

    const colDesc = this._colliderDesc(object3d, desc);
    if (desc.friction != null) colDesc.setFriction(desc.friction);
    if (desc.restitution != null) colDesc.setRestitution(desc.restitution);
    if (desc.density != null) colDesc.setDensity(desc.density);
    else if (desc.mass != null) colDesc.setMass(desc.mass);
    colDesc.setActiveEvents(R.ActiveEvents.COLLISION_EVENTS | R.ActiveEvents.CONTACT_FORCE_EVENTS);
    if (this.contactForceThreshold > 0) colDesc.setContactForceEventThreshold(this.contactForceThreshold);
    const collider = world.createCollider(colDesc, rb);

    const handle = { rb, collider, type };
    object3d.userData.__rhbody = handle;
    this.bodies.set(object3d, handle);
    this.colliderToObj.set(collider.handle, object3d);
    return handle;
  }

  _colliderDesc(object3d, desc) {
    const R = this.RAPIER;
    const shape = desc.shape || 'hull';
    const geom = object3d.geometry;
    if (shape === 'box' || !geom) {
      const s = this._floorExtents(desc.halfExtents || this._halfExtents(object3d));
      return R.ColliderDesc.cuboid(s[0], s[1], s[2]);
    }
    if (shape === 'sphere') {
      const r = Math.max(1e-3, desc.radius || this._radius(object3d));
      return R.ColliderDesc.ball(r);
    }
    const pos = geom.getAttribute('position');
    const scale = object3d.getWorldScale(new (this._vec3())());
    let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
    const verts = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) * scale.x, y = pos.getY(i) * scale.y, z = pos.getZ(i) * scale.z;
      verts[i * 3] = x; verts[i * 3 + 1] = y; verts[i * 3 + 2] = z;
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
      if (z < minz) minz = z; if (z > maxz) maxz = z;
    }
    if (shape === 'trimesh') {
      const idx = geom.index ? new Uint32Array(geom.index.array) : Uint32Array.from({ length: pos.count }, (_, i) => i);
      return R.ColliderDesc.trimesh(verts, idx);
    }
    // Convex hull, but guard against degenerate (thin/sliver) fragments whose
    // hull has near-zero thickness — those give Rapier a singular inertia tensor
    // and produce NaN. Fall back to a box collider with floored extents.
    const ex = (maxx - minx), ey = (maxy - miny), ez = (maxz - minz);
    const maxE = Math.max(ex, ey, ez) || 1;
    const minE = Math.min(ex, ey, ez);
    if (pos.count >= 4 && minE > 1e-3 * maxE && minE > 1e-5) {
      const hull = R.ColliderDesc.convexHull(verts);
      if (hull) return hull;
    }
    const h = this._floorExtents([ex / 2, ey / 2, ez / 2]);
    const desc2 = R.ColliderDesc.cuboid(h[0], h[1], h[2]);
    desc2.setTranslation((minx + maxx) / 2, (miny + maxy) / 2, (minz + maxz) / 2);
    return desc2;
  }

  _floorExtents(e) {
    const maxE = Math.max(e[0], e[1], e[2], 1e-3);
    const floor = Math.max(1e-3, maxE * 0.02);
    return [Math.max(e[0], floor), Math.max(e[1], floor), Math.max(e[2], floor)];
  }

  removeBody(object3d) {
    const h = this.bodies.get(object3d);
    if (!h) return;
    this.colliderToObj.delete(h.collider.handle);
    this.world.removeRigidBody(h.rb);
    this.bodies.delete(object3d);
    delete object3d.userData.__rhbody;
  }

  setBodyType(object3d, type) {
    const h = this.bodies.get(object3d); if (!h) return;
    const R = this.RAPIER;
    const map = { dynamic: R.RigidBodyType.Dynamic, static: R.RigidBodyType.Fixed, kinematic: R.RigidBodyType.KinematicPositionBased };
    h.rb.setBodyType(map[type] ?? R.RigidBodyType.Dynamic, true);
    h.type = type;
  }

  setLinearVelocity(o, v) { const h = this.bodies.get(o); if (h) h.rb.setLinvel({ x: v[0], y: v[1], z: v[2] }, true); }
  setAngularVelocity(o, v) { const h = this.bodies.get(o); if (h) h.rb.setAngvel({ x: v[0], y: v[1], z: v[2] }, true); }
  getLinearVelocity(o) { const h = this.bodies.get(o); if (!h) return [0, 0, 0]; const v = h.rb.linvel(); return [v.x, v.y, v.z]; }
  applyImpulse(o, imp, point) {
    const h = this.bodies.get(o); if (!h) return;
    if (point) h.rb.applyImpulseAtPoint({ x: imp[0], y: imp[1], z: imp[2] }, { x: point[0], y: point[1], z: point[2] }, true);
    else h.rb.applyImpulse({ x: imp[0], y: imp[1], z: imp[2] }, true);
  }
  applyForce(o, f, point) {
    const h = this.bodies.get(o); if (!h) return;
    if (point) h.rb.addForceAtPoint({ x: f[0], y: f[1], z: f[2] }, { x: point[0], y: point[1], z: point[2] }, true);
    else h.rb.addForce({ x: f[0], y: f[1], z: f[2] }, true);
  }
  setEnabled(o, en) { const h = this.bodies.get(o); if (h) h.rb.setEnabled(en); }

  step(dt) {
    const world = this.world;
    if (dt) world.timestep = dt;
    world.step(this.eventQueue);

    // Contact events -> demolition / fx triggers. EDGE-TRIGGERED: fire only when
    // a pair STARTS touching, not every frame they stay in contact (a body
    // resting on another would otherwise spam events forever). The contact-force
    // magnitude for that step is matched in by collider-pair key.
    if (this.contactListeners.length) {
      const forceMap = new Map();
      this.eventQueue.drainContactForceEvents(e => {
        const c1 = e.collider1(), c2 = e.collider2();
        const k = c1 < c2 ? c1 + '_' + c2 : c2 + '_' + c1;
        const m = e.totalForceMagnitude();
        const cur = forceMap.get(k);
        if (cur === undefined || m > cur) forceMap.set(k, m);
      });
      this.eventQueue.drainCollisionEvents((h1, h2, started) => {
        if (!started) return;                 // ignore separation; only initial contact
        const a = this.colliderToObj.get(h1);
        const b = this.colliderToObj.get(h2);
        if (!a && !b) return;
        const k = h1 < h2 ? h1 + '_' + h2 : h2 + '_' + h1;
        this._emitContact(a, b, forceMap.get(k) || 0, null);
      });
    }

    // sync transforms back to objects (non-static, awake)
    const THREE = this._THREE;
    for (const [obj, h] of this.bodies) {
      if (h.type === 'static') continue;
      const t = h.rb.translation();
      const r = h.rb.rotation();
      obj.position.set(t.x, t.y, t.z);
      obj.quaternion.set(r.x, r.y, r.z, r.w);
    }
  }

  raycast(origin, dir, maxDistance = 1000) {
    const R = this.RAPIER;
    const ray = new R.Ray({ x: origin[0], y: origin[1], z: origin[2] }, { x: dir[0], y: dir[1], z: dir[2] });
    const hit = this.world.castRayAndGetNormal(ray, maxDistance, true);
    if (!hit) return null;
    const obj = this.colliderToObj.get(hit.collider.handle);
    const t = hit.timeOfImpact;
    return {
      object: obj,
      distance: t,
      point: [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t],
      normal: hit.normal ? [hit.normal.x, hit.normal.y, hit.normal.z] : [0, 1, 0],
    };
  }

  // tiny helpers so we don't hard-import three here
  _vec3() { return (this._THREE && this._THREE.Vector3) || _Vec3; }
  _quat() { return (this._THREE && this._THREE.Quaternion) || _Quat; }
  _halfExtents(o) {
    const g = o.geometry; if (!g) return [0.5, 0.5, 0.5];
    if (!g.boundingBox) g.computeBoundingBox();
    const s = o.getWorldScale(new (this._vec3())());
    const bb = g.boundingBox;
    return [(bb.max.x - bb.min.x) / 2 * s.x, (bb.max.y - bb.min.y) / 2 * s.y, (bb.max.z - bb.min.z) / 2 * s.z];
  }
  _radius(o) { const e = this._halfExtents(o); return Math.max(e[0], e[1], e[2]); }
}

// minimal fallbacks if THREE not provided (used only for math helpers)
class _Vec3 { constructor() { this.x = 0; this.y = 0; this.z = 0; } }
class _Quat { constructor() { this.x = 0; this.y = 0; this.z = 0; this.w = 1; } }
