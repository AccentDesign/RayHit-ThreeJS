/**
 * RayHitRigid — per-object simulation + runtime demolition
 * Attach to a THREE.Mesh
 * via man.addRigid(mesh, opts). On a strong enough collision the mesh is
 * fractured into fragments that inherit its motion and simulate independently.
 *
 * options:
 *   simType: 'dynamic'|'static'|'kinematic'   (default 'dynamic')
 *   material: MaterialType                      (default 'Concrete')
 *   collider: 'hull'|'box'|'sphere'|'trimesh'  (default 'hull')
 *   mass: number                               (override; else density*volume)
 *   demolition: {
 *     type: 'voronoi'|'splinters'|...          fragmentation type
 *     amount, seed, ...frag opts               passed to the fragmenter
 *     depth: number      (max recursive demolition depth, default 1)
 *     collisionThreshold: number  (contact impulse to demolish; else from solidity)
 *     scatter: number    (extra outward fragment velocity, default 0.5)
 *   }
 *   fade: { type, lifetime, duration }
 */
import { MeshData } from '../fragment/MeshData.js';
import { fragment as fractureGeometry } from '../fragment/fragmenter.js';
import { getMaterial, MaterialType, SimType, DemolitionType } from '../effects/materials.js';

export class RayHitRigid {
  constructor(mesh, man, options = {}) {
    this.mesh = mesh;
    this.man = man;
    this.THREE = man.THREE;
    this.simType = options.simType || SimType.Dynamic;
    this.materialType = options.material || MaterialType.Concrete;
    this.colliderShape = options.collider || 'hull';
    this.massOverride = options.mass ?? null;

    const d = options.demolition || {};
    this.demolition = {
      enabled: !!options.demolition && (d.type !== DemolitionType.None),
      fragOptions: d,
      depth: d.depth ?? 1,
      scatter: d.scatter ?? 0.5,
      collisionThreshold: d.collisionThreshold ?? null,
      // demolition needs a real IMPACT, not steady resting/stacking contact.
      // Require this relative speed (m/s) between the two bodies, else ignore —
      // this is what stops a stacked wall from shattering itself on spawn.
      minImpactSpeed: d.minImpactSpeed ?? 2.5,
    };
    this.fade = options.fade || null;
    this.debris = options.debris || null;   // {amount,color,size,...} emitted on demolish
    this.dust = options.dust || null;       // {amount,color,size,...} emitted on demolish
    this.depth = options.__depth ?? this.demolition.depth;
    this.demolished = false;

    // material arrays for fragments (computed lazily on first demolition)
    this._matArray = options.__matArray || null;

    // events
    this.onDemolish = options.onDemolish || null;
  }

  get mat() { return getMaterial(this.materialType); }

  /** local-space solid volume (cached). */
  _volume() {
    if (this._vol == null) {
      const md = MeshData.fromBufferGeometry(this.mesh.geometry);
      const s = this.mesh.getWorldScale(new this.THREE.Vector3());
      this._vol = md.volume() * Math.abs(s.x * s.y * s.z);
    }
    return this._vol;
  }

  get demolishImpulse() {
    if (this.demolition.collisionThreshold != null) return this.demolition.collisionThreshold;
    // derive from material solidity (tougher material resists more)
    return Math.max(1, this.mat.solidity * 0.25);
  }

  init() {
    this.mesh.userData.rigid = this;
    if (!this.man.physics) return this;
    const m = this.mat;
    // Drive mass via density so the engine derives a consistent mass + inertia
    // tensor from the actual collider volume (also uses density*volume).
    const density = this.massOverride != null
      ? this.massOverride / Math.max(1e-6, this._volume())
      : m.density;
    this.man.physics.addBody(this.mesh, {
      type: this.simType === SimType.Static ? 'static' : this.simType === SimType.Kinematic ? 'kinematic' : 'dynamic',
      shape: this.colliderShape,
      density,
      friction: m.dynamicFriction,
      restitution: m.bounciness,
      linearDamping: m.drag,
      angularDamping: m.angularDrag,
    });
    return this;
  }

  _onContact(impulse, other) {
    if (this.demolished) return;
    if (!this.demolition.enabled) return;
    if (this.depth <= 0) return;
    if (impulse < this.demolishImpulse) return;
    const phys = this.man.physics;
    // Require a genuine impact: the relative speed between the two bodies must
    // exceed minImpactSpeed. Stacked/resting blocks have ~0 relative velocity
    // (even though their contact force is large), so the wall no longer shatters
    // itself on spawn — only a fast projectile/bomb has the speed to demolish.
    const v1 = phys ? phys.getLinearVelocity(this.mesh) : [0, 0, 0];
    const v2 = (phys && other) ? phys.getLinearVelocity(other) : [0, 0, 0];
    const rel = Math.hypot(v1[0] - v2[0], v1[1] - v2[1], v1[2] - v2[2]);
    if (rel < this.demolition.minImpactSpeed) return;
    // capture velocity before demolition, then fracture
    this.demolished = true;
    this._inheritVel = v1;
    this.demolish();
  }

  /** Force a demolition now (e.g. from a bomb or scripted event). */
  async demolish(opts = {}) {
    if (this._done) return [];
    this._done = true;
    this.demolished = true;
    const THREE = this.THREE;
    const mesh = this.mesh;
    const man = this.man;
    const phys = man.physics;

    const inheritVel = opts.velocity || this._inheritVel || (phys ? phys.getLinearVelocity(mesh) : [0, 0, 0]);

    // material array (originals + inner)
    const origMats = Array.isArray(mesh.material) ? mesh.material.slice() : [mesh.material];
    if (!this._matArray) {
      const inner = this.demolition.fragOptions.innerMaterial || origMats[0] || new THREE.MeshStandardMaterial({ color: 0x6b5a48 });
      this._matArray = [...origMats, inner];
    }
    const innerIndex = origMats.length;

    // fracture in local space (clamp face materials to those that exist)
    const md = MeshData.fromBufferGeometry(mesh.geometry);
    md.clampMaterials(origMats.length - 1);
    const fragOpt = { ...this.demolition.fragOptions, innerMatIndex: innerIndex };
    // bias fragmentation toward contact point if provided (local space)
    if (opts.point) {
      mesh.updateWorldMatrix(true, false);
      const local = mesh.worldToLocal(new THREE.Vector3(opts.point[0], opts.point[1], opts.point[2]));
      fragOpt.biasCenter = [local.x, local.y, local.z];
      if (fragOpt.centerBias == null) fragOpt.centerBias = 0.3;
    }
    const result = fractureGeometry(md, fragOpt);
    if (!result.fragments.length) { this._done = false; this.demolished = false; return []; }

    mesh.updateWorldMatrix(true, false);
    const parent = mesh.parent || man.scene;
    const worldScale = mesh.getWorldScale(new THREE.Vector3());
    const worldQuat = mesh.getWorldQuaternion(new THREE.Quaternion());
    const center = mesh.getWorldPosition(new THREE.Vector3());

    const childDensity = this.mat.density;
    const created = [];
    for (let i = 0; i < result.fragments.length; i++) {
      const f = result.fragments[i];
      const g = await f.mesh.toBufferGeometry(THREE);
      const fm = new THREE.Mesh(g, this._matArray);
      fm.castShadow = mesh.castShadow; fm.receiveShadow = mesh.receiveShadow;
      // place at world transform of original applied to the fragment pivot
      const worldPos = mesh.localToWorld(new THREE.Vector3(f.pivot[0], f.pivot[1], f.pivot[2]));
      fm.position.copy(worldPos);
      fm.quaternion.copy(worldQuat);
      fm.scale.copy(worldScale);
      parent.add(fm);

      // child rigid (can re-demolish until depth exhausted)
      const childRigid = new RayHitRigid(fm, man, {
        simType: SimType.Dynamic,
        material: this.materialType,
        collider: 'hull',
        demolition: this.depth - 1 > 0 ? { ...this.demolition.fragOptions, depth: this.depth - 1 } : undefined,
        fade: this.fade,
        debris: this.debris,
        dust: this.dust,
        __depth: this.depth - 1,
        __matArray: this._matArray,
      });
      childRigid.init();
      man.rigids.add(childRigid);

      // inherit velocity + outward scatter from demolition center
      if (phys) {
        const dir = worldPos.clone().sub(center);
        const dist = dir.length() || 1; dir.multiplyScalar(1 / dist);
        const scat = this.demolition.scatter;
        phys.setLinearVelocity(fm, [
          inheritVel[0] + dir.x * scat,
          inheritVel[1] + dir.y * scat,
          inheritVel[2] + dir.z * scat,
        ]);
        phys.setAngularVelocity(fm, [(Math.random() - 0.5) * scat, (Math.random() - 0.5) * scat, (Math.random() - 0.5) * scat]);
      }
      man.registerFragment(childRigid);
      created.push(childRigid);
    }

    // debris & dust at the break point (RayHitDebris / RayHitDust)
    const fxAt = opts.point || [center.x, center.y, center.z];
    if (this.dust) man.emitDust(fxAt, { color: 0xb3a890, ...this.dust });
    if (this.debris) man.emitDebris(fxAt, { color: this.mat ? 0x8a7a66 : 0x8a7a66, ...this.debris });

    // remove the original
    if (phys) phys.removeBody(mesh);
    if (mesh.parent) mesh.parent.remove(mesh);
    man.rigids.delete(this);
    this.fragments = created;
    if (this.onDemolish) this.onDemolish(this, created);
    return created;
  }
}
