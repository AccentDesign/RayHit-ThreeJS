/**
 * Voronoi — build 3D Voronoi cells from seed points inside an AABB.
 *
 * Faithful to Voro++'s approach (the engine native lib is built on):
 * each cell is the bounding box clipped by the perpendicular-bisector plane of
 * every neighbouring seed, processed nearest-first with a "security radius"
 * early-out: once the nearest unprocessed neighbour is farther than twice the
 * current cell radius, no remaining bisector can touch the cell, so we stop.
 *
 * Anisotropic metric: an optional per-axis weight vector `w` warps the distance
 * metric — d²(x,p) = Σ wₐ(xₐ-pₐ)². Small weight on an axis stretches cells along
 * it. This reproduces Splinters (one stretched axis) and Slabs (two)
 * fragmentation, which the native lib implements via SliceData_SetAxisScale.
 */
import { ConvexCell } from './ConvexCell.js';

export class Voronoi {
  /**
   * @param {number[][]} points seed points (cell sites)
   * @param {number[]} min AABB min corner
   * @param {number[]} max AABB max corner
   * @param {number[]} [weights=[1,1,1]] anisotropic metric weights
   */
  constructor(points, min, max, weights = [1, 1, 1]) {
    this.points = points;
    this.min = min;
    this.max = max;
    this.w = weights;
  }

  build(opt = {}) {
    const includeBoundary = !!opt.includeBoundary;
    const pts = this.points;
    const n = pts.length;
    const [wx, wy, wz] = this.w;
    const aniso = wx !== 1 || wy !== 1 || wz !== 1;
    const cells = [];
    const grid = (!aniso && n > 400) ? new Grid(pts, this.min, this.max) : null;

    const wradius = (cell, s) => {
      let r2 = 0;
      for (const f of cell.faces) for (const p of f.pts) {
        const dx = p[0] - s[0], dy = p[1] - s[1], dz = p[2] - s[2];
        const d = wx * dx * dx + wy * dy * dy + wz * dz * dz;
        if (d > r2) r2 = d;
      }
      return Math.sqrt(r2);
    };

    for (let i = 0; i < n; i++) {
      const site = pts[i];
      const cell = ConvexCell.box(this.min, this.max);

      let order;
      if (grid) order = grid.neighborsByDistance(i);
      else {
        order = [];
        for (let j = 0; j < n; j++) if (j !== i) {
          const dx = pts[j][0] - site[0], dy = pts[j][1] - site[1], dz = pts[j][2] - site[2];
          order.push([wx * dx * dx + wy * dy * dy + wz * dz * dz, j]);
        }
        order.sort((a, b) => a[0] - b[0]);
      }

      let radius = wradius(cell, site);
      for (let k = 0; k < order.length; k++) {
        const dist = Math.sqrt(order[k][0]);   // metric distance to neighbour
        if (dist > 2 * radius) break;          // security radius early-out
        const p = pts[order[k][1]];
        const dx = p[0] - site[0], dy = p[1] - site[1], dz = p[2] - site[2];
        // weighted bisector: g = w∘(p - site); plane g·x = g·midpoint
        let gx = wx * dx, gy = wy * dy, gz = wz * dz;
        const glen = Math.hypot(gx, gy, gz);
        if (glen < 1e-9) continue;
        gx /= glen; gy /= glen; gz /= glen;
        const mx = (p[0] + site[0]) * 0.5, my = (p[1] + site[1]) * 0.5, mz = (p[2] + site[2]) * 0.5;
        const c = gx * mx + gy * my + gz * mz;
        cell.clip([gx, gy, gz], c, order[k][1]);
        radius = wradius(cell, site);
      }

      cells.push({ site, planes: includeBoundary ? cell.allPlanes() : cell.cutPlanes(), cell });
    }
    return cells;
  }
}

/** Uniform spatial grid for nearest-neighbour ordering when seed count is high. */
class Grid {
  constructor(points, min, max) {
    this.points = points;
    this.min = min;
    const n = points.length;
    const res = Math.max(1, Math.cbrt(n) | 0);
    this.res = res;
    this.size = [(max[0] - min[0]) / res || 1, (max[1] - min[1]) / res || 1, (max[2] - min[2]) / res || 1];
    this.cells = new Map();
    for (let i = 0; i < n; i++) {
      const key = this._key(points[i]);
      let a = this.cells.get(key);
      if (!a) this.cells.set(key, (a = []));
      a.push(i);
    }
  }
  _coord(p) {
    return [
      Math.min(this.res - 1, Math.max(0, ((p[0] - this.min[0]) / this.size[0]) | 0)),
      Math.min(this.res - 1, Math.max(0, ((p[1] - this.min[1]) / this.size[1]) | 0)),
      Math.min(this.res - 1, Math.max(0, ((p[2] - this.min[2]) / this.size[2]) | 0)),
    ];
  }
  _key(p) { const c = this._coord(p); return c[0] + this.res * (c[1] + this.res * c[2]); }
  neighborsByDistance(i) {
    const site = this.points[i];
    const [cx, cy, cz] = this._coord(site);
    const out = [];
    let collected = 0;
    for (let r = 0; r <= this.res; r++) {
      for (let z = cz - r; z <= cz + r; z++)
        for (let y = cy - r; y <= cy + r; y++)
          for (let x = cx - r; x <= cx + r; x++) {
            if (r > 0 && Math.abs(x - cx) !== r && Math.abs(y - cy) !== r && Math.abs(z - cz) !== r) continue;
            if (x < 0 || y < 0 || z < 0 || x >= this.res || y >= this.res || z >= this.res) continue;
            const arr = this.cells.get(x + this.res * (y + this.res * z));
            if (!arr) continue;
            for (const j of arr) if (j !== i) {
              const dx = this.points[j][0] - site[0], dy = this.points[j][1] - site[1], dz = this.points[j][2] - site[2];
              out.push([dx * dx + dy * dy + dz * dz, j]); collected++;
            }
          }
      if (collected > 26 && r >= 2) break;
    }
    out.sort((a, b) => a[0] - b[0]);
    return out;
  }
}
