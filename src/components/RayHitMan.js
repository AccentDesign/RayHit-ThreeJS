/**
 * RayHitMan — the global manager. One instance owns the
 * physics adapter, advances the simulation, routes collision events to the
 * RayHitRigid objects, enforces the global fragment budget, and runs fades.
 *
 * Typical loop:
 *   const man = new RayHitMan({ THREE, scene, physics });
 *   await man.init();
 *   const rigid = man.addRigid(mesh, { simType:'dynamic', demolition:{...} });
 *   // each frame:
 *   man.update(deltaSeconds);
 */
import { RayHitRigid } from './RayHitRigid.js';
import { FadeType } from '../effects/materials.js';
import { RayHitParticles } from '../effects/particles.js';

export class RayHitMan {
  constructor(opts = {}) {
    this.THREE = opts.THREE;
    this.scene = opts.scene;
    this.physics = opts.physics || null;
    if (this.physics && this.THREE && !this.physics._THREE) this.physics._THREE = this.THREE;

    this.fragmentLimit = opts.fragmentLimit ?? 2000;   // max simulated fragments
    this.quotaAction = opts.quotaAction || 'skip';      // 'skip' | 'postpone'
    this.maxTimeStep = opts.maxTimeStep ?? (1 / 60);
    this.defaultFade = opts.defaultFade || null;        // { type, lifetime, duration }

    this.rigids = new Set();          // all RayHitRigid
    this.fragments = [];              // active fragment entries for fade/limit
    this.groundY = opts.groundY ?? 0; // debris bounce plane
    this.particles = null;            // lazy RayHitParticles
    this._time = 0;
    this._initialized = false;
  }

  _fx() {
    if (!this.particles) this.particles = new RayHitParticles(this.THREE, this.scene);
    return this.particles;
  }

  /** Spawn a dust puff (see RayHitParticles.dust opts). */
  emitDust(pos, opts = {}) { this._fx().dust(pos, opts); }

  /** Spawn debris chips (groundY defaults to the manager's). */
  emitDebris(pos, opts = {}) { this._fx().debris(pos, { groundY: this.groundY, ...opts }); }

  async init() {
    if (this.physics && !this.physics.world && this.physics.init) await this.physics.init();
    if (this.physics) {
      this.physics.onContact((a, b, impulse) => this._onContact(a, b, impulse));
    }
    this._initialized = true;
    return this;
  }

  /** Wrap a THREE.Mesh in a RayHitRigid and register it. */
  addRigid(mesh, options = {}) {
    const rigid = new RayHitRigid(mesh, this, options);
    rigid.init();
    this.rigids.add(rigid);
    return rigid;
  }

  /** Advance physics + effects by dt seconds (clamped). */
  update(dt) {
    this._time += dt;
    if (this.physics) this.physics.step(Math.min(dt, this.maxTimeStep));
    this._updateFades(dt);
    if (this.particles) this.particles.update(dt);
  }

  get now() { return this._time; }

  _onContact(a, b, impulse) {
    if (a && a.userData.rigid) a.userData.rigid._onContact(impulse, b);
    if (b && b.userData.rigid) b.userData.rigid._onContact(impulse, a);
  }

  /** Register a freshly created fragment for fade/limit tracking. */
  registerFragment(rigid) {
    const fadeType = (rigid.fade && rigid.fade.type) || (this.defaultFade && this.defaultFade.type) || FadeType.None;
    const lifetime = (rigid.fade && rigid.fade.lifetime) ?? (this.defaultFade && this.defaultFade.lifetime) ?? 8;
    const duration = (rigid.fade && rigid.fade.duration) ?? (this.defaultFade && this.defaultFade.duration) ?? 2;
    this.fragments.push({ rigid, mesh: rigid.mesh, bornAt: this._time, fadeType, lifetime, duration, fading: false, t0: 0 });
    this._enforceLimit();
  }

  _enforceLimit() {
    // Over budget: retire the oldest fragments first (fragment quota).
    const over = this.fragments.length - this.fragmentLimit;
    if (over <= 0) return;
    for (let i = 0; i < over; i++) {
      const e = this.fragments[i];
      if (e && !e.removed) this._remove(e);
    }
    this.fragments = this.fragments.filter(e => !e.removed);
  }

  _updateFades(dt) {
    if (!this.fragments.length) return;
    const THREE = this.THREE;
    for (const e of this.fragments) {
      if (e.removed) continue;
      const age = this._time - e.bornAt;
      if (e.fadeType === FadeType.None) continue;
      if (!e.fading) {
        if (age < e.lifetime) continue;
        e.fading = true; e.t0 = this._time;
        // one-shot transitions
        if (e.fadeType === FadeType.SimExclude) { if (this.physics) this.physics.removeBody(e.mesh); e.removed = true; continue; }
        if (e.fadeType === FadeType.SetKinematic) { this.physics?.setBodyType(e.mesh, 'kinematic'); e.removed = true; continue; }
        if (e.fadeType === FadeType.SetStatic) { this.physics?.setBodyType(e.mesh, 'static'); e.removed = true; continue; }
        if (e.fadeType === FadeType.Destroy) { this._remove(e); continue; }
        if (e.fadeType === FadeType.FallDown || e.fadeType === FadeType.MoveDown) { this.physics?.setBodyType(e.mesh, 'kinematic'); }
      }
      const k = (this._time - e.t0) / e.duration;   // 0..1 fade progress
      if (e.fadeType === FadeType.ScaleDown) {
        const s = Math.max(0.0001, 1 - k);
        e.mesh.scale.setScalar(s * (e.baseScale || 1));
        if (k >= 1) this._remove(e);
      } else if (e.fadeType === FadeType.FallDown || e.fadeType === FadeType.MoveDown) {
        e.mesh.position.y -= dt * 1.5;
        if (k >= 1) this._remove(e);
      }
    }
    if (this.fragments.some(e => e.removed)) this.fragments = this.fragments.filter(e => !e.removed);
  }

  _remove(e) {
    e.removed = true;
    if (this.physics) this.physics.removeBody(e.mesh);
    if (e.mesh.parent) e.mesh.parent.remove(e.mesh);
    if (e.rigid) this.rigids.delete(e.rigid);
    e.mesh.geometry?.dispose?.();
  }

  /** Remove everything this manager created (utility). */
  clear() {
    for (const e of this.fragments) if (!e.removed) this._remove(e);
    this.fragments = [];
    if (this.particles) this.particles.clear();
  }
}
