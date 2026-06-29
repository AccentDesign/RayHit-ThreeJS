/**
 * RayHitConnectivity — structural integrity & progressive collapse.
 *
 * Shards are linked into a connection graph. Some shards are "anchors"
 * (unyielding — the foundation: ground row, fixed supports). Non-anchor shards
 * are held frozen (kinematic) as long as a path of intact connections links
 * them to an anchor. When connections are destroyed, any shard that can no
 * longer reach an anchor loses support and is activated (becomes dynamic and
 * falls) — and because activated shards stop conducting support, the collapse
 * cascades upward, exactly like connectivity structures.
 *
 *   const con = new RayHitConnectivity(man, { connectionType:'boundingBox', overlap:0.05 });
 *   con.setShards(rigids, s => s.mesh.userData.isFoundation);  // anchor predicate
 *   con.build();
 *   con.start();
 *   // later, when the player knocks a shard out:
 *   con.removeShard(shard);     // or con.activateAt([x,y,z], radius)
 */
import { SimType } from '../effects/materials.js';

export class RayHitConnectivity {
  constructor(man, opts = {}) {
    this.man = man;
    this.THREE = man.THREE;
    this.phys = man.physics;
    this.connectionType = opts.connectionType || 'boundingBox'; // 'boundingBox' | 'triangles' | 'both'
    this.overlap = opts.overlap ?? 0.05;        // AABB expansion for adjacency (world units)
    this.minSharedArea = opts.minSharedArea ?? 0; // for triangle/face-based connection
    this.activateImpulse = opts.activateImpulse ?? 0.15; // tiny nudge when a shard lets go
    this.onActivate = opts.onActivate || null;
    // stress (RFStress): a connection bears at most `stressStrength` per support
    // link; load = a shard's own weight + everything routed through it to anchors.
    this.stressStrength = opts.stressStrength ?? 8;
    this.weightByVolume = !!opts.weightByVolume;

    /** @type {ShardNode[]} */ this.shards = [];
    this.byMesh = new Map();
    this._started = false;
  }

  /**
   * Register the shards. `rigids` is an array of RayHitRigid (or {mesh}).
   * anchorPredicate(node) decides foundation shards; if omitted, shards whose
   * `mesh.userData.unyielding` is true (or `rigid.unyielding`) are anchors.
   */
  setShards(rigids, anchorPredicate = null) {
    const THREE = this.THREE;
    this.shards = rigids.map((r, i) => {
      const mesh = r.mesh || r;
      const aabb = new THREE.Box3().setFromObject(mesh);
      const sz = aabb.getSize(new THREE.Vector3());
      const weight = this.weightByVolume ? Math.max(1e-3, sz.x * sz.y * sz.z) : 1;
      const node = { id: i, rigid: r.mesh ? r : null, mesh, aabb, weight, anchor: false, active: false, removed: false, neighbors: new Set() };
      this.byMesh.set(mesh, node);
      return node;
    });
    for (const n of this.shards) {
      n.anchor = anchorPredicate ? !!anchorPredicate(n) : !!(n.mesh.userData.unyielding || (n.rigid && n.rigid.unyielding));
    }
    return this;
  }

  /** Build the connection graph from shard adjacency. */
  build() {
    const n = this.shards.length;
    const exp = this.overlap;
    // expanded AABBs
    const boxes = this.shards.map(s => s.aabb.clone().expandByScalar(exp));
    // O(n^2) adjacency (fine for typical structures; swap for a grid if huge)
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (!boxes[i].intersectsBox(boxes[j])) continue;
        if (this.connectionType === 'triangles' || this.connectionType === 'both') {
          if (!this._sharedSurface(this.shards[i], this.shards[j])) continue;
        }
        this.shards[i].neighbors.add(j);
        this.shards[j].neighbors.add(i);
      }
    }
    return this;
  }

  // Cheap face-adjacency proxy: do the (un-expanded) AABBs nearly touch along a
  // face? (Full shared-area test would intersect meshes; this is the practical
  // approximation the ByBoundingBox+Triangles uses for speed.)
  _sharedSurface(a, b) {
    const t = this.overlap * 2 + 1e-4;
    const A = a.aabb, B = b.aabb;
    const gapX = Math.max(A.min.x - B.max.x, B.min.x - A.max.x);
    const gapY = Math.max(A.min.y - B.max.y, B.min.y - A.max.y);
    const gapZ = Math.max(A.min.z - B.max.z, B.min.z - A.max.z);
    // adjacent if they only just separate on at most one axis (a shared face)
    const gaps = [gapX, gapY, gapZ].filter(g => g > 0);
    return gaps.length <= 1 && (gaps[0] ?? 0) <= t;
  }

  /** Freeze the structure: anchors static, supported shards kinematic. */
  start() {
    for (const s of this.shards) {
      if (s.removed) continue;
      if (s.anchor) this._setType(s, SimType.Static);
      else this._setType(s, SimType.Kinematic);
    }
    this._started = true;
    return this;
  }

  /** Remove a shard from the structure (it was destroyed/demolished), then recompute. */
  removeShard(rigidOrMesh) {
    const node = this._node(rigidOrMesh);
    if (!node || node.removed) return;
    node.removed = true;
    for (const j of node.neighbors) this.shards[j].neighbors.delete(node.id);
    node.neighbors.clear();
    this.recompute();
  }

  /** Activate (free) a shard so it falls; cascades support loss. */
  activate(rigidOrMesh, impulse = null) {
    const node = this._node(rigidOrMesh);
    if (!node || node.active || node.removed || node.anchor) return;
    this._activate(node, impulse);
    this.recompute();
  }

  /** Free every shard within `radius` of `point` (e.g. an explosion), then cascade. */
  activateAt(point, radius, impulse = 0) {
    const THREE = this.THREE;
    const p = new THREE.Vector3(point[0], point[1], point[2]);
    const r2 = radius * radius;
    let any = false;
    for (const s of this.shards) {
      if (s.removed || s.active || s.anchor) continue;
      const c = s.aabb.getCenter(new THREE.Vector3());
      if (c.distanceToSquared(p) <= r2) {
        const dir = c.clone().sub(p); const d = dir.length() || 1; dir.multiplyScalar(impulse / d);
        this._activate(s, impulse ? [dir.x, dir.y + impulse * 0.3, dir.z] : null);
        any = true;
      }
    }
    if (any) this.recompute();
  }

  /**
   * Core integrity pass: flood from anchors through intact (held, non-active,
   * non-removed) shards. Any held shard not reached has lost its support path
   * and is activated. Repeats to convergence so collapse cascades in one call.
   */
  recompute() {
    let changed = true;
    let guard = 0;
    while (changed && guard++ < this.shards.length + 2) {
      changed = false;
      const reached = new Uint8Array(this.shards.length);
      const stack = [];
      for (const s of this.shards) if (s.anchor && !s.removed) { reached[s.id] = 1; stack.push(s.id); }
      while (stack.length) {
        const id = stack.pop();
        for (const j of this.shards[id].neighbors) {
          const nb = this.shards[j];
          if (reached[j] || nb.removed || nb.active) continue; // support flows only through held/anchor shards
          reached[j] = 1; stack.push(j);
        }
      }
      for (const s of this.shards) {
        if (s.removed || s.active || s.anchor) continue;
        if (!reached[s.id]) { this._activate(s); changed = true; }
      }
    }
  }

  /**
   * RFStress — one load-stress pass. Each held shard carries its own weight plus
   * everything routed down through it toward the anchors; a shard whose carried
   * load exceeds its strength (stressStrength × number of supporting links) is
   * the weakest point and fails. Fails the single most-overloaded shard and
   * cascades, so calling this repeatedly produces progressive collapse:
   * cantilevers snap near their root, overloaded towers buckle at the base.
   * Returns the number of shards that failed this pass (0 = stable).
   */
  stressStep(opt = {}) {
    const strengthScale = opt.strength ?? this.stressStrength;
    const n = this.shards.length;
    const dist = new Float64Array(n).fill(Infinity);
    // BFS distance to nearest anchor through intact (anchor/held) shards
    const q = [];
    for (const s of this.shards) if (s.anchor && !s.removed && !s.active) { dist[s.id] = 0; q.push(s.id); }
    for (let head = 0; head < q.length; head++) {
      const id = q[head];
      for (const j of this.shards[id].neighbors) {
        const nb = this.shards[j];
        if (nb.removed || nb.active) continue;
        if (dist[j] > dist[id] + 1) { dist[j] = dist[id] + 1; q.push(j); }
      }
    }
    // held shards, processed top-down (farthest from anchor first)
    const held = this.shards.filter(s => !s.removed && !s.active && !s.anchor && dist[s.id] < Infinity);
    held.sort((a, b) => dist[b.id] - dist[a.id]);
    const load = new Float64Array(n);
    for (const s of this.shards) if (!s.removed && !s.active && dist[s.id] < Infinity) load[s.id] = s.weight;
    const supOf = new Map();
    for (const s of held) {
      const sup = [];
      for (const j of s.neighbors) { const nb = this.shards[j]; if (!nb.removed && !nb.active && dist[j] < dist[s.id]) sup.push(j); }
      supOf.set(s.id, sup);
      if (sup.length) { const share = load[s.id] / sup.length; for (const j of sup) load[j] += share; }
    }
    // fail the most overloaded shard
    let worst = null, worstOver = 1e-9;
    for (const s of held) {
      const sup = supOf.get(s.id);
      const strength = strengthScale * Math.max(1, sup.length);
      const over = load[s.id] - strength;
      if (over > worstOver) { worstOver = over; worst = s; }
    }
    if (worst) { this._activate(worst); this.recompute(); return 1; }
    return 0;
  }

  /** Run stress passes until the structure is stable (or maxSteps reached). */
  relaxStress(maxSteps = 500, opt = {}) {
    let total = 0, c;
    do { c = this.stressStep(opt); total += c; } while (c > 0 && total < maxSteps);
    return total;
  }

  _activate(node, impulse = null) {
    node.active = true;
    this._setType(node, SimType.Dynamic);
    if (this.phys) {
      const imp = impulse || [0, -this.activateImpulse, 0];
      // wake the body so it starts falling immediately
      this.phys.setLinearVelocity(node.mesh, imp);
    }
    if (node.rigid) node.rigid.simType = SimType.Dynamic;
    if (this.onActivate) this.onActivate(node);
  }

  _setType(node, type) {
    if (node.rigid) node.rigid.simType = type;
    if (this.phys) this.phys.setBodyType(node.mesh, type);
  }

  _node(x) { return this.byMesh.get(x.mesh || x) || (x.id != null && this.shards[x.id]) || null; }

  /** Stats (for debugging/tests): {total, anchors, held, active, removed}. */
  stats() {
    let anchors = 0, held = 0, active = 0, removed = 0;
    for (const s of this.shards) {
      if (s.removed) removed++;
      else if (s.anchor) anchors++;
      else if (s.active) active++;
      else held++;
    }
    return { total: this.shards.length, anchors, held, active, removed };
  }
}

/** @typedef {{id:number,rigid:any,mesh:any,aabb:any,anchor:boolean,active:boolean,removed:boolean,neighbors:Set<number>}} ShardNode */
