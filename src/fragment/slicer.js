/**
 * slicer — cut a MeshData by a plane, keep the inside half-space, and cap the
 * opening with a new "inner" surface. This is the JS reimplementation of
 * native `Mesh_Slice` + cap step.
 *
 * Plane convention: {n:[x,y,z], c}. A point p is INSIDE when n·p <= c. The
 * removed material is on the +n side, so the cap's outward normal is +n.
 *
 * The kept geometry stays watertight: original vertices are de-duplicated, and
 * intersection vertices are shared between the two triangles of each cut edge
 * (keyed by edge). Cap polygons are rebuilt from the cut segments, supporting
 * concave cross-sections and holes via earcut.
 */
import earcut from '../math/earcut.js';
import { MeshData } from './MeshData.js';

const DEFAULT_EPS = 1e-6;

/**
 * @param {MeshData} md
 * @param {{n:number[],c:number}} plane
 * @param {object} [opt]
 * @param {number} [opt.innerMat=0] material index for cap faces
 * @param {boolean} [opt.cap=true]
 * @param {number} [opt.capUvScale=1]
 * @param {number} [opt.eps]
 * @returns {MeshData|null} inside part (null if nothing remains)
 */
export function sliceMesh(md, plane, opt = {}) {
  const innerMat = opt.innerMat ?? 0;
  const cap = opt.cap !== false;
  const uvScale = opt.capUvScale ?? 1;
  const eps = opt.eps ?? DEFAULT_EPS;
  const n = plane.n, c = plane.c;
  const nx = n[0], ny = n[1], nz = n[2];

  const P = md.positions, N = md.normals, U = md.uvs;
  const hasN = md.hasNormals && N.length > 0;
  const hasU = md.hasUvs && U.length > 0;

  const out = new MeshData();
  out.hasNormals = hasN;
  out.hasUvs = hasU;

  // signed distance per original vertex
  const vcount = md.vertCount;
  const dist = new Float64Array(vcount);
  for (let i = 0; i < vcount; i++) dist[i] = nx * P[i * 3] + ny * P[i * 3 + 1] + nz * P[i * 3 + 2] - c;

  const vmap = new Int32Array(vcount).fill(-1);   // orig vert -> new vert
  const emap = new Map();                          // edge "i_j" -> new vert
  const segments = [];                             // cut segments [ax,ay,az,bx,by,bz]

  const copyVert = (i) => {
    let ni = vmap[i];
    if (ni !== -1) return ni;
    ni = out.addVertex(
      P[i * 3], P[i * 3 + 1], P[i * 3 + 2],
      hasN ? N[i * 3] : 0, hasN ? N[i * 3 + 1] : 0, hasN ? N[i * 3 + 2] : 0,
      hasU ? U[i * 2] : 0, hasU ? U[i * 2 + 1] : 0,
    );
    vmap[i] = ni;
    return ni;
  };

  const cutVert = (i, j) => {
    const a = i < j ? i : j, b = i < j ? j : i;
    const key = a * vcount + b;
    let ni = emap.get(key);
    if (ni !== undefined) return ni;
    const da = dist[a], db = dist[b];
    const t = da / (da - db); // a -> b
    const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
    const bx = P[b * 3], by = P[b * 3 + 1], bz = P[b * 3 + 2];
    const px = ax + t * (bx - ax), py = ay + t * (by - ay), pz = az + t * (bz - az);
    let vnx = 0, vny = 0, vnz = 0, vu = 0, vv = 0;
    if (hasN) {
      vnx = N[a * 3] + t * (N[b * 3] - N[a * 3]);
      vny = N[a * 3 + 1] + t * (N[b * 3 + 1] - N[a * 3 + 1]);
      vnz = N[a * 3 + 2] + t * (N[b * 3 + 2] - N[a * 3 + 2]);
      const l = Math.hypot(vnx, vny, vnz) || 1; vnx /= l; vny /= l; vnz /= l;
    }
    if (hasU) {
      vu = U[a * 2] + t * (U[b * 2] - U[a * 2]);
      vv = U[a * 2 + 1] + t * (U[b * 2 + 1] - U[a * 2 + 1]);
    }
    ni = out.addVertex(px, py, pz, vnx, vny, vnz, vu, vv);
    emap.set(key, ni);
    return ni;
  };

  const tri = md.index, mat = md.material;
  for (let t = 0; t < tri.length; t += 3) {
    const ia = tri[t], ib = tri[t + 1], ic = tri[t + 2];
    const da = dist[ia], db = dist[ib], dc = dist[ic];
    const inA = da <= eps, inB = db <= eps, inC = dc <= eps;
    const m = mat[t / 3];

    if (inA && inB && inC) {
      out.addTriangle(copyVert(ia), copyVert(ib), copyVert(ic), m);
      continue;
    }
    if (!inA && !inB && !inC) continue;

    // Clip the triangle loop a->b->c against the plane. Every triangle reaching
    // here straddles (>=1 vertex strictly outside, >=1 inside). Build the inside
    // polygon, tracking which vertices lie ON the plane (|d|<=eps) so cap edges
    // touching on-plane vertices are captured (the axis-aligned degeneracy).
    const verts = [ia, ib, ic];
    const ds = [da, db, dc];
    const polyIdx = [];     // new vertex indices of the inside polygon
    const polyOn = [];      // is that polygon vertex on the plane?
    for (let e = 0; e < 3; e++) {
      const vi = verts[e], vj = verts[(e + 1) % 3];
      const di = ds[e], dj = ds[(e + 1) % 3];
      if (di <= eps) { polyIdx.push(copyVert(vi)); polyOn.push(di >= -eps); }
      if ((di < -eps && dj > eps) || (di > eps && dj < -eps)) { polyIdx.push(cutVert(vi, vj)); polyOn.push(true); }
    }
    if (polyIdx.length >= 3) {
      for (let k = 1; k < polyIdx.length - 1; k++) out.addTriangle(polyIdx[0], polyIdx[k], polyIdx[k + 1], m);
    }
    // Emit every polygon edge that lies on the cut plane as a cap segment.
    const op = out.positions;
    for (let e = 0; e < polyIdx.length; e++) {
      const a = polyIdx[e], b = polyIdx[(e + 1) % polyIdx.length];
      if (polyOn[e] && polyOn[(e + 1) % polyIdx.length] && a !== b) {
        segments.push(op[a * 3], op[a * 3 + 1], op[a * 3 + 2], op[b * 3], op[b * 3 + 1], op[b * 3 + 2]);
      }
    }
  }

  if (out.triCount === 0) return null;

  if (cap && segments.length) buildCap(out, segments, n, innerMat, uvScale);

  return out;
}

/**
 * Build cap faces on the slice plane from the cut segments.
 *
 * Robust planar face-tracing: the cut segments form a planar straight-line
 * graph on the slice plane. We weld endpoints, build a DCEL-style half-edge
 * structure, and trace its bounded faces using the angular "next edge"
 * rule. Each bounded interior face is the solid cross-section, triangulated
 * with earcut. Unlike naive loop-walking, this is correct at degree>2
 * junctions (which arise on axis-aligned cuts and where one plane re-cuts a
 * previous cap) — the case that was leaking volume on brick/voxel/slice cuts.
 */
function buildCap(out, segments, n, innerMat, uvScale) {
  // plane basis (u,v) with (u,v,n) right-handed -> CCW in (u,v) faces +n
  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
  const t = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1];
  const u = cross(t, n); norm(u);
  const v = cross(n, u);

  // weld endpoints; store both 3D and 2D coords
  const QUANT = 1e5;
  const key = (x, y, z) => `${Math.round(x * QUANT)}_${Math.round(y * QUANT)}_${Math.round(z * QUANT)}`;
  const p3 = [];                          // welded 3D points
  const p2 = [];                          // welded 2D coords (plane space)
  const map = new Map();
  const getPt = (x, y, z) => {
    const k = key(x, y, z);
    let i = map.get(k);
    if (i === undefined) {
      i = p3.length;
      p3.push([x, y, z]);
      p2.push([x * u[0] + y * u[1] + z * u[2], x * v[0] + y * v[1] + z * v[2]]);
      map.set(k, i);
    }
    return i;
  };

  const nbr = [];                         // adjacency set per vertex
  const addEdge = (a, b) => {
    if (a === b) return;
    (nbr[a] || (nbr[a] = new Set())).add(b);
    (nbr[b] || (nbr[b] = new Set())).add(a);
  };
  for (let s = 0; s < segments.length; s += 6) {
    addEdge(getPt(segments[s], segments[s + 1], segments[s + 2]),
            getPt(segments[s + 3], segments[s + 4], segments[s + 5]));
  }
  if (!p3.length) return;

  // sort each vertex's neighbours CCW by angle; record index lookup
  const sorted = [];                      // sorted[v] = [neighbour ids]
  const pos = [];                         // pos[v] = Map neighbour -> index
  for (let i = 0; i < p3.length; i++) {
    const set = nbr[i];
    if (!set) { sorted[i] = []; pos[i] = new Map(); continue; }
    const arr = [...set].sort((a, b) =>
      Math.atan2(p2[a][1] - p2[i][1], p2[a][0] - p2[i][0]) -
      Math.atan2(p2[b][1] - p2[i][1], p2[b][0] - p2[i][0]));
    sorted[i] = arr;
    const m = new Map(); arr.forEach((w, k) => m.set(w, k));
    pos[i] = m;
  }

  // trace faces via half-edges: next(u->v) leaves v toward the neighbour
  // immediately clockwise from u (predecessor in CCW order).
  const used = new Set();                 // directed half-edges "u_v"
  const addCapVert = (i) => {
    const p = p3[i];
    return out.addVertex(p[0], p[1], p[2], n[0], n[1], n[2],
      p2[i][0] * uvScale, p2[i][1] * uvScale);
  };

  for (let a = 0; a < p3.length; a++) {
    for (const b of sorted[a]) {
      if (used.has(a + '_' + b)) continue;
      // walk the face
      const face = [];
      let pu = a, pv = b, guard = 0;
      while (guard++ < p3.length * 4) {
        used.add(pu + '_' + pv);
        face.push(pu);
        const arr = sorted[pv];
        const idx = pos[pv].get(pu);
        const w = arr[(idx - 1 + arr.length) % arr.length];   // clockwise neighbour
        pu = pv; pv = w;
        if (pu === a && pv === b) break;
      }
      if (face.length < 3) continue;

      // signed area in plane space; keep CCW (interior) faces, drop the outer
      let area = 0;
      for (let i = 0, j = face.length - 1; i < face.length; j = i++)
        area += (p2[face[j]][0] + p2[face[i]][0]) * (p2[face[j]][1] - p2[face[i]][1]);
      area *= 0.5;
      if (area <= 1e-12) continue;        // outer face (CW) or degenerate

      // triangulate this face
      const flat = [];
      for (const id of face) { flat.push(p2[id][0], p2[id][1]); }
      const tris = earcut(flat, null, 2);
      const capVert = new Map();
      const cv = (faceLocal) => {
        const pid = face[faceLocal];
        let nv = capVert.get(pid);
        if (nv === undefined) { nv = addCapVert(pid); capVert.set(pid, nv); }
        return nv;
      };
      for (let k = 0; k < tris.length; k += 3) {
        let ia = cv(tris[k]), ib = cv(tris[k + 1]), ic = cv(tris[k + 2]);
        if (triNormalDot(out.positions, ia, ib, ic, n) < 0) { const tmp = ib; ib = ic; ic = tmp; }
        out.addTriangle(ia, ib, ic, innerMat);
      }
    }
  }
}

function signedArea(poly2d) {
  let s = 0;
  for (let i = 0, j = poly2d.length - 1; i < poly2d.length; j = i++) s += (poly2d[j][0] + poly2d[i][0]) * (poly2d[j][1] - poly2d[i][1]);
  return s * 0.5;
}
function pointInPoly(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if (((yi > pt[1]) !== (yj > pt[1])) && (pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function triNormalDot(P, a, b, c, n) {
  const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
  const bx = P[b * 3], by = P[b * 3 + 1], bz = P[b * 3 + 2];
  const cx = P[c * 3], cy = P[c * 3 + 1], cz = P[c * 3 + 2];
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  const cxn = uy * vz - uz * vy, cyn = uz * vx - ux * vz, czn = ux * vy - uy * vx;
  return cxn * n[0] + cyn * n[1] + czn * n[2];
}
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; a[0] /= l; a[1] /= l; a[2] /= l; return a; }
