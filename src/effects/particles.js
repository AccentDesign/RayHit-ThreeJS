/**
 * RayHitParticles — debris & dust emitters (port of RayHitDebris + RayHitDust).
 *
 * Both are self-simulated (no physics bodies — debris/dust are
 * particle effects, not rigids), so a demolition can spray hundreds of chips and
 * dust puffs cheaply:
 *   - DUST  : a soft THREE.Points puff that drifts up, expands and fades.
 *   - DEBRIS: an InstancedMesh of small chips with ballistic motion + ground
 *             bounce, scaling out at end of life.
 *
 * Usage (usually via RayHitMan.emitDust / emitDebris):
 *   const fx = new RayHitParticles(THREE, scene);
 *   fx.dust([x,y,z], { amount: 30, color: 0x9b8e7a });
 *   fx.debris([x,y,z], { amount: 24, color: 0x8a7a66, groundY: 0 });
 *   // each frame: fx.update(dt);
 */
export class RayHitParticles {
  constructor(THREE, scene, opts = {}) {
    this.THREE = THREE;
    this.scene = scene;
    this.bursts = [];
    this.maxBursts = opts.maxBursts ?? 160; // safety cap: retire oldest beyond this
    this._dustTex = null;
    this._debrisGeo = null;
  }

  // Drop the oldest bursts if we somehow exceed the cap (defensive against
  // callers that emit every frame, e.g. a body resting in continuous contact).
  _cap() {
    while (this.bursts.length > this.maxBursts) this._dispose(this.bursts.shift());
  }

  _dustTexture() {
    if (this._dustTex || typeof document === 'undefined') return this._dustTex;
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.4, 'rgba(255,255,255,0.6)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
    this._dustTex = new this.THREE.CanvasTexture(c);
    return this._dustTex;
  }

  /** Dust puff. opts: amount, color, size, lifetime, speed, rise, spread. */
  dust(pos, opts = {}) {
    const THREE = this.THREE;
    const n = opts.amount ?? 30;
    const lifetime = opts.lifetime ?? 1.4;
    const speed = opts.speed ?? 1.2;
    const rise = opts.rise ?? 0.8;
    const spread = opts.spread ?? 0.4;
    const positions = new Float32Array(n * 3);
    const vel = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      positions[i * 3] = pos[0] + (Math.random() - 0.5) * spread;
      positions[i * 3 + 1] = pos[1] + (Math.random() - 0.5) * spread;
      positions[i * 3 + 2] = pos[2] + (Math.random() - 0.5) * spread;
      const a = Math.random() * Math.PI * 2, r = Math.random() * speed;
      vel[i * 3] = Math.cos(a) * r;
      vel[i * 3 + 1] = rise * (0.5 + Math.random());
      vel[i * 3 + 2] = Math.sin(a) * r;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const tex = this._dustTexture();
    const mat = new THREE.PointsMaterial({
      color: opts.color ?? 0x9b8e7a, size: opts.size ?? 0.5, map: tex || null,
      transparent: true, opacity: 0.55, depthWrite: false, sizeAttenuation: true,
      blending: THREE.NormalBlending,
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    this.scene.add(points);
    this.bursts.push({ kind: 'dust', obj: points, vel, n, age: 0, lifetime, baseSize: mat.size, baseOpacity: 0.55 });
    this._cap();
  }

  /** Debris chips. opts: amount, color, size, lifetime, speed, gravity, bounce, groundY, spread. */
  debris(pos, opts = {}) {
    const THREE = this.THREE;
    const n = opts.amount ?? 24;
    const lifetime = opts.lifetime ?? 2.2;
    const speed = opts.speed ?? 4;
    const gravity = opts.gravity ?? 14;
    const bounce = opts.bounce ?? 0.35;
    const groundY = opts.groundY ?? 0;
    const size = opts.size ?? 0.08;
    const spread = opts.spread ?? 0.2;
    if (!this._debrisGeo) this._debrisGeo = new THREE.TetrahedronGeometry(1, 0);
    const mat = new THREE.MeshStandardMaterial({ color: opts.color ?? 0x8a7a66, roughness: 1, flatShading: true });
    const inst = new THREE.InstancedMesh(this._debrisGeo, mat, n);
    inst.frustumCulled = false; inst.castShadow = !!opts.castShadow;
    const data = [];
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, up = 0.4 + Math.random() * 0.9, r = Math.random();
      data.push({
        p: [pos[0] + (Math.random() - 0.5) * spread, pos[1] + (Math.random() - 0.5) * spread, pos[2] + (Math.random() - 0.5) * spread],
        v: [Math.cos(a) * speed * r, speed * up, Math.sin(a) * speed * r],
        rot: [Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI],
        av: [(Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8],
        s: size * (0.5 + Math.random()),
        rest: false,
      });
    }
    this.scene.add(inst);
    this.bursts.push({ kind: 'debris', obj: inst, data, n, age: 0, lifetime, gravity, bounce, groundY,
      _m: new THREE.Matrix4(), _q: new THREE.Quaternion(), _e: new THREE.Euler(), _v: new THREE.Vector3(), _s: new THREE.Vector3() });
    this._cap();
  }

  update(dt) {
    if (!this.bursts.length) return;
    const keep = [];
    for (const b of this.bursts) {
      b.age += dt;
      const t = b.age / b.lifetime;
      if (t >= 1) { this._dispose(b); continue; }
      if (b.kind === 'dust') this._updateDust(b, dt, t);
      else this._updateDebris(b, dt, t);
      keep.push(b);
    }
    this.bursts = keep;
  }

  _updateDust(b, dt, t) {
    const pos = b.obj.geometry.attributes.position.array;
    const v = b.vel;
    for (let i = 0; i < b.n; i++) {
      v[i * 3] *= 0.92; v[i * 3 + 1] = v[i * 3 + 1] * 0.96 + 0.05; v[i * 3 + 2] *= 0.92;
      pos[i * 3] += v[i * 3] * dt; pos[i * 3 + 1] += v[i * 3 + 1] * dt; pos[i * 3 + 2] += v[i * 3 + 2] * dt;
    }
    b.obj.geometry.attributes.position.needsUpdate = true;
    b.obj.material.opacity = b.baseOpacity * (1 - t * t);
    b.obj.material.size = b.baseSize * (1 + t * 1.5);
  }

  _updateDebris(b, dt, t) {
    const { data, _m, _q, _e, _v, _s } = b;
    const fade = t > 0.8 ? (1 - t) / 0.2 : 1;
    for (let i = 0; i < b.n; i++) {
      const d = data[i];
      if (!d.rest) {
        d.v[1] -= b.gravity * dt;
        d.p[0] += d.v[0] * dt; d.p[1] += d.v[1] * dt; d.p[2] += d.v[2] * dt;
        if (d.p[1] <= b.groundY + d.s) {
          d.p[1] = b.groundY + d.s;
          if (Math.abs(d.v[1]) < 0.6) { d.rest = true; d.v[0] = d.v[1] = d.v[2] = 0; d.av = [0, 0, 0]; }
          else { d.v[1] = -d.v[1] * b.bounce; d.v[0] *= 0.6; d.v[2] *= 0.6; }
        }
        d.rot[0] += d.av[0] * dt; d.rot[1] += d.av[1] * dt; d.rot[2] += d.av[2] * dt;
      }
      _e.set(d.rot[0], d.rot[1], d.rot[2]); _q.setFromEuler(_e);
      _v.set(d.p[0], d.p[1], d.p[2]); _s.setScalar(d.s * fade);
      _m.compose(_v, _q, _s);
      b.obj.setMatrixAt(i, _m);
    }
    b.obj.instanceMatrix.needsUpdate = true;
  }

  _dispose(b) {
    this.scene.remove(b.obj);
    b.obj.geometry?.dispose?.();
    if (b.kind === 'dust') b.obj.material?.dispose?.();
    else b.obj.material?.dispose?.();
  }

  clear() { for (const b of this.bursts) this._dispose(b); this.bursts = []; }
}
