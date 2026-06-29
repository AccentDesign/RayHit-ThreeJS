/**
 * ConvexCell — a convex polyhedron represented as a set of planar faces, with
 * a `clip(plane)` operation. This is the data structure behind a Voronoi cell.
 *
 * Algorithm: a Voronoi cell is the intersection of half-spaces — one per
 * neighbouring seed, the perpendicular bisector. We start from the bounding
 * box and successively clip by each bisector plane. This is exactly what
 * Voro++ does internally (it identifies as `voro::voronoicell` cell-clipping
 * method); we reimplement the same math in plain JS.
 *
 * Each face stores its outward plane {n,c} (points x with n·x <= c are inside)
 * and an ordered loop of 3D points (CCW seen from outside). Faces created by
 * the initial box are flagged `boundary`; faces created by clipping are `cut`.
 * The slicer only needs the `cut` planes when the AABB encloses the mesh.
 */
const EPS = 1e-7;

export class ConvexCell {
  constructor() {
    /** @type {{n:number[], c:number, pts:number[][], boundary:boolean, id:number}[]} */
    this.faces = [];
  }

  /** Build an axis-aligned box cell from min/max corners. */
  static box(min, max) {
    const cell = new ConvexCell();
    const [x0, y0, z0] = min;
    const [x1, y1, z1] = max;
    // 8 corners
    const v = [
      [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
      [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
    ];
    // faces: outward normal, CCW from outside
    const addFace = (n, c, idx) => cell.faces.push({ n, c, pts: idx.map(i => v[i].slice()), boundary: true, id: -1 });
    addFace([-1, 0, 0], -x0, [0, 4, 7, 3]); // -X
    addFace([1, 0, 0], x1, [1, 2, 6, 5]);   // +X
    addFace([0, -1, 0], -y0, [0, 1, 5, 4]); // -Y
    addFace([0, 1, 0], y1, [3, 7, 6, 2]);   // +Y
    addFace([0, 0, -1], -z0, [0, 3, 2, 1]); // -Z
    addFace([0, 0, 1], z1, [4, 5, 6, 7]);   // +Z
    return cell;
  }

  /**
   * Clip this cell in place by the half-space n·x <= c (keep the inside).
   * `id` lets a Voronoi build tag which neighbour produced this face.
   * Returns true if the cell still has volume, false if fully clipped away.
   */
  clip(n, c, id = -1) {
    const cutPts = [];
    const newFaces = [];

    for (const f of this.faces) {
      const pts = f.pts;
      const m = pts.length;
      const dist = new Array(m);
      let nIn = 0;
      for (let i = 0; i < m; i++) {
        dist[i] = n[0] * pts[i][0] + n[1] * pts[i][1] + n[2] * pts[i][2] - c;
        if (dist[i] <= EPS) nIn++;
      }
      if (nIn === 0) continue;          // face entirely outside -> dropped
      if (nIn === m) { newFaces.push(f); continue; } // entirely inside -> kept

      // Face straddles plane: clip the loop (Sutherland–Hodgman).
      const out = [];
      for (let i = 0; i < m; i++) {
        const j = (i + 1) % m;
        const di = dist[i], dj = dist[j];
        const pi = pts[i], pj = pts[j];
        const inI = di <= EPS;
        if (inI) out.push(pi);
        if ((di < -EPS && dj > EPS) || (di > EPS && dj < -EPS)) {
          const t = di / (di - dj);
          const ip = [pi[0] + t * (pj[0] - pi[0]), pi[1] + t * (pj[1] - pi[1]), pi[2] + t * (pj[2] - pi[2])];
          out.push(ip);
          cutPts.push(ip);
        }
      }
      if (out.length >= 3) newFaces.push({ n: f.n, c: f.c, pts: out, boundary: f.boundary, id: f.id });
    }

    // Build the new cap face from the cut points.
    const cap = ConvexCell._orderLoop(cutPts, n);
    if (cap && cap.length >= 3) newFaces.push({ n: n.slice(), c, pts: cap, boundary: false, id });

    this.faces = newFaces;
    return this.faces.length >= 4;
  }

  /** Order a set of coplanar points into a convex CCW loop (outward normal n). */
  static _orderLoop(pts, n) {
    // dedup
    const uniq = [];
    for (const p of pts) {
      let dup = false;
      for (const q of uniq) {
        const dx = p[0] - q[0], dy = p[1] - q[1], dz = p[2] - q[2];
        if (dx * dx + dy * dy + dz * dz < 1e-12) { dup = true; break; }
      }
      if (!dup) uniq.push(p);
    }
    if (uniq.length < 3) return null;
    // centroid
    const ctr = [0, 0, 0];
    for (const p of uniq) { ctr[0] += p[0]; ctr[1] += p[1]; ctr[2] += p[2]; }
    ctr[0] /= uniq.length; ctr[1] /= uniq.length; ctr[2] /= uniq.length;
    // plane basis (u,v) with (u,v,n) right-handed
    let ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
    let t = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1];
    const u = cross(t, n); normalize(u);
    const vv = cross(n, u);
    return uniq
      .map(p => {
        const d = [p[0] - ctr[0], p[1] - ctr[1], p[2] - ctr[2]];
        return { p, a: Math.atan2(dot(d, vv), dot(d, u)) };
      })
      .sort((A, B) => A.a - B.a)
      .map(o => o.p);
  }

  /** Max distance from a point to any vertex of the cell (the cell radius). */
  maxRadius(from) {
    let r2 = 0;
    for (const f of this.faces) for (const p of f.pts) {
      const dx = p[0] - from[0], dy = p[1] - from[1], dz = p[2] - from[2];
      const d = dx * dx + dy * dy + dz * dz;
      if (d > r2) r2 = d;
    }
    return Math.sqrt(r2);
  }

  /** The cut-face planes (those produced by clipping, not the box boundary). */
  cutPlanes() {
    return this.faces.filter(f => !f.boundary).map(f => ({ n: f.n, c: f.c }));
  }

  /** All face planes including the box boundary (used when AABB crops the mesh). */
  allPlanes() {
    return this.faces.map(f => ({ n: f.n, c: f.c }));
  }

  /** Triangulate the cell into a flat {positions, indices} mesh (for debug viz). */
  toMesh() {
    const positions = [];
    const indices = [];
    for (const f of this.faces) {
      const base = positions.length / 3;
      for (const p of f.pts) positions.push(p[0], p[1], p[2]);
      for (let i = 1; i < f.pts.length - 1; i++) indices.push(base, base + i, base + i + 1);
    }
    return { positions, indices };
  }
}

function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function normalize(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; a[0] /= l; a[1] /= l; a[2] /= l; return a; }
