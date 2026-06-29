/**
 * MeshData — a lightweight, engine-agnostic triangle mesh used by the slicer.
 * Pure arrays (no three.js dependency) so the geometry kernel can be unit
 * tested in plain Node
 * Bridges to/from THREE.BufferGeometry are provided
 * separately (see toBufferGeometry / fromBufferGeometry) and lazily import three.
 *
 * Per-triangle `material` indices preserve multi-material meshes; the slicer
 * appends cap triangles tagged with the dedicated "inner" material index.
 */
export class MeshData {
  constructor() {
    /** flat xyz */         this.positions = [];
    /** flat xyz | null */  this.normals = [];
    /** flat uv  | null */  this.uvs = [];
    /** triangle vertex indices */ this.index = [];
    /** material index per triangle (length = index.length/3) */ this.material = [];
    this.hasNormals = true;
    this.hasUvs = true;
  }

  get triCount() { return this.index.length / 3; }
  get vertCount() { return this.positions.length / 3; }

  /** Append a vertex, return its index. */
  addVertex(px, py, pz, nx, ny, nz, u, v) {
    const i = this.positions.length / 3;
    this.positions.push(px, py, pz);
    if (this.hasNormals) this.normals.push(nx || 0, ny || 0, nz || 0);
    if (this.hasUvs) this.uvs.push(u || 0, v || 0);
    return i;
  }

  addTriangle(a, b, c, mat) {
    this.index.push(a, b, c);
    this.material.push(mat);
  }

  /** Axis-aligned bounds [minx,miny,minz,maxx,maxy,maxz]. */
  bounds() {
    const p = this.positions;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < p.length; i += 3) {
      if (p[i] < x0) x0 = p[i]; if (p[i] > x1) x1 = p[i];
      if (p[i + 1] < y0) y0 = p[i + 1]; if (p[i + 1] > y1) y1 = p[i + 1];
      if (p[i + 2] < z0) z0 = p[i + 2]; if (p[i + 2] > z1) z1 = p[i + 2];
    }
    return [x0, y0, z0, x1, y1, z1];
  }

  /** Volume-weighted centroid (uses signed tetra volumes; good for solids). */
  centroid() {
    const p = this.positions, idx = this.index;
    let vol = 0, cx = 0, cy = 0, cz = 0;
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      const ax = p[a], ay = p[a + 1], az = p[a + 2];
      const bx = p[b], by = p[b + 1], bz = p[b + 2];
      const cx2 = p[c], cy2 = p[c + 1], cz2 = p[c + 2];
      const v = (ax * (by * cz2 - bz * cy2) - ay * (bx * cz2 - bz * cx2) + az * (bx * cy2 - by * cx2)) / 6;
      vol += v;
      cx += (ax + bx + cx2) * 0.25 * v;
      cy += (ay + by + cy2) * 0.25 * v;
      cz += (az + bz + cz2) * 0.25 * v;
    }
    if (Math.abs(vol) < 1e-12) {
      // Fallback: bbox centre (degenerate / open mesh)
      const b = this.bounds();
      return [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2];
    }
    return [cx / vol, cy / vol, cz / vol];
  }

  /** Approximate solid volume. */
  volume() {
    const p = this.positions, idx = this.index;
    let vol = 0;
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      vol += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
        - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c])
        + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6;
    }
    return Math.abs(vol);
  }

  /**
   * Is a point inside this (closed) mesh? Casts a +X ray and counts triangle
   * crossings (odd = inside) via Möller–Trumbore. Used for interior seed
   * sampling so fracture seeds land in the solid, not in empty bbox space
   * around concave/thin meshes.
   */
  containsPoint(p) {
    const P = this.positions, idx = this.index;
    const ox = p[0], oy = p[1], oz = p[2];
    let crossings = 0;
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      // edges
      const e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2], e1x = P[b] - P[a];
      const e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2], e2x = P[c] - P[a];
      // dir = (1,0,0); h = dir x e2 = (0*e2z-0*e2y, 0*e2x-1*e2z, 1*e2y-0*e2x) = (0, -e2z, e2y)
      const hx = 0, hy = -e2z, hz = e2y;
      const det = e1x * hx + e1y * hy + e1z * hz;
      if (det > -1e-12 && det < 1e-12) continue;
      const inv = 1 / det;
      const sx = ox - P[a], sy = oy - P[a + 1], sz = oz - P[a + 2];
      const u = (sx * hx + sy * hy + sz * hz) * inv;
      if (u < 0 || u > 1) continue;
      // q = s x e1
      const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
      // v = dir . q = qx
      const v = qx * inv;
      if (v < 0 || u + v > 1) continue;
      const tHit = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (tHit > 1e-9) crossings++;
    }
    return (crossings & 1) === 1;
  }

  /** Translate all vertices so the centroid sits at the origin; returns the offset. */
  recenter(c = this.centroid()) {
    const p = this.positions;
    for (let i = 0; i < p.length; i += 3) { p[i] -= c[0]; p[i + 1] -= c[1]; p[i + 2] -= c[2]; }
    return c;
  }

  /**
   * Clamp every triangle's material index into [0, maxIndex]. Needed because
   * some geometries (notably THREE.BoxGeometry) declare more material groups
   * (indices 0-5, one per face) than the mesh actually has materials. Without
   * this, fragment faces reference materials that don't exist and render
   * invisible or with the wrong (inner) material.
   */
  clampMaterials(maxIndex) {
    for (let i = 0; i < this.material.length; i++)
      if (this.material[i] > maxIndex) this.material[i] = maxIndex;
    return this;
  }

  /** Build per-triangle material groups (sorted), like THREE geometry groups. */
  buildGroups() {
    // Reorder index by material so each material is a contiguous group.
    const order = [];
    for (let t = 0; t < this.material.length; t++) order.push(t);
    order.sort((a, b) => this.material[a] - this.material[b]);
    const newIndex = new Array(this.index.length);
    const groups = [];
    let cur = -1, start = 0;
    for (let k = 0; k < order.length; k++) {
      const t = order[k];
      newIndex[k * 3] = this.index[t * 3];
      newIndex[k * 3 + 1] = this.index[t * 3 + 1];
      newIndex[k * 3 + 2] = this.index[t * 3 + 2];
      const m = this.material[t];
      if (m !== cur) {
        if (cur !== -1) groups.push({ start, count: k * 3 - start, materialIndex: cur });
        cur = m; start = k * 3;
      }
    }
    if (cur !== -1) groups.push({ start, count: order.length * 3 - start, materialIndex: cur });
    this.index = newIndex;
    return groups;
  }

  /** Convert to a THREE.BufferGeometry (with material groups). */
  async toBufferGeometry(THREE) {
    if (!THREE) THREE = await import('three');
    const groups = this.buildGroups();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    if (this.hasNormals && this.normals.length) g.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    if (this.hasUvs && this.uvs.length) g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    g.setIndex(this.index);
    for (const grp of groups) g.addGroup(grp.start, grp.count, grp.materialIndex);
    if (!this.hasNormals || !this.normals.length) g.computeVertexNormals();
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }

  /**
   * Build a MeshData from a THREE.BufferGeometry. Non-indexed geometry is
   * given a trivial index. Material groups map to per-triangle material ids.
   */
  static fromBufferGeometry(geom) {
    const md = new MeshData();
    const pos = geom.getAttribute('position');
    const nor = geom.getAttribute('normal');
    const uv = geom.getAttribute('uv');
    md.hasNormals = !!nor;
    md.hasUvs = !!uv;
    for (let i = 0; i < pos.count; i++) {
      md.positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      if (nor) md.normals.push(nor.getX(i), nor.getY(i), nor.getZ(i));
      if (uv) md.uvs.push(uv.getX(i), uv.getY(i));
    }
    let index;
    if (geom.index) index = geom.index.array;
    else { index = new Uint32Array(pos.count); for (let i = 0; i < pos.count; i++) index[i] = i; }
    const groups = (geom.groups && geom.groups.length)
      ? geom.groups.slice().sort((a, b) => a.start - b.start)
      : [{ start: 0, count: index.length, materialIndex: 0 }];
    for (const grp of groups) {
      const end = grp.start + grp.count;
      for (let i = grp.start; i < end; i += 3) {
        md.index.push(index[i], index[i + 1], index[i + 2]);
        md.material.push(grp.materialIndex || 0);
      }
    }
    return md;
  }
}
