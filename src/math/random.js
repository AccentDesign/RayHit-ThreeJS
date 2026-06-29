/**
 * Deterministic seeded PRNG used by the fragmentation engine.
 *
 * A given (seed, parameters) pair always
 * produces the same fragment layout. We can't match Unity's internal RNG bit
 * for bit (it's a proprietary xorshift variant), but we provide the same
 * guarantee: same seed + same params => identical fragments, every run, on
 * every platform. `mulberry32` is tiny, fast and well-distributed.
 */
export class Rng {
  constructor(seed = 1) {
    // Convention: seed 0 means "pick a random seed".
    if (seed === 0) seed = Math.floor(Math.random() * 1_000_000) + 1;
    this._s = seed >>> 0;
  }

  /** Reset to a new seed. */
  seed(s) {
    this._s = (s === 0 ? Math.floor(Math.random() * 1_000_000) + 1 : s) >>> 0;
    return this;
  }

  /** Uniform float in [0, 1). */
  next() {
    let t = (this._s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform float in [min, max). */
  range(min, max) {
    return min + (max - min) * this.next();
  }

  /** Uniform integer in [min, max] inclusive (matches Unity Random.Range(int,int) being max-exclusive => use rangeIntExcl for that). */
  rangeInt(min, max) {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Uniform integer in [min, max) — Unity's Random.Range(int,int) semantics. */
  rangeIntExcl(min, max) {
    return min + Math.floor(this.next() * (max - min));
  }

  /** Random point uniformly inside the unit sphere. */
  insideUnitSphere(out = [0, 0, 0]) {
    let x, y, z, d;
    do {
      x = this.next() * 2 - 1;
      y = this.next() * 2 - 1;
      z = this.next() * 2 - 1;
      d = x * x + y * y + z * z;
    } while (d > 1 || d === 0);
    out[0] = x; out[1] = y; out[2] = z;
    return out;
  }

  /** Random unit-length direction. */
  onUnitSphere(out = [0, 0, 0]) {
    const z = this.next() * 2 - 1;
    const a = this.next() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    out[0] = r * Math.cos(a);
    out[1] = r * Math.sin(a);
    out[2] = z;
    return out;
  }
}
