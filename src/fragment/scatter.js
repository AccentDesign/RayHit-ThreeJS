/**
 * scatter — seed-point generators for each fragmentation type.
 *
 * All generators return points in real (mesh-local) space inside the given AABB
 * and are driven by a seeded Rng for determinism. The fragmenter feeds these
 * points to the Voronoi engine. The mapping mirrors RFEngine point
 * generation (GenRandomPoints / GenRadialPoints / GenBricks / GenTetrahedrons /
 * SetCustomPoints), and Splinters/Slabs reuse uniform points with an
 * anisotropic Voronoi metric (computed by the fragmenter from `strength`).
 */

const AXIS = { x: 0, y: 1, z: 2 };

/** Uniform random points inside the AABB. Used by Voronoi / Splinters / Slabs. */
export function randomPoints(rng, min, max, amount) {
  const pts = [];
  for (let i = 0; i < amount; i++) {
    pts.push([
      rng.range(min[0], max[0]),
      rng.range(min[1], max[1]),
      rng.range(min[2], max[2]),
    ]);
  }
  return pts;
}

/**
 * Rejection-sample `amount` points that lie INSIDE the mesh (md.containsPoint).
 * Falls back to leftover bbox points if the mesh is too thin to hit. Keeps
 * Voronoi seeds in the solid so concave/thin meshes (characters!) fracture into
 * the requested number of fragments instead of wasting cells on empty space.
 */
export function sampleInsidePoints(rng, md, min, max, amount, attemptsMul = 30) {
  const pts = [];
  const maxAttempts = amount * attemptsMul + 100;
  let a = 0;
  while (pts.length < amount && a++ < maxAttempts) {
    const p = [rng.range(min[0], max[0]), rng.range(min[1], max[1]), rng.range(min[2], max[2])];
    if (md.containsPoint(p)) pts.push(p);
  }
  // top up with bbox points if we couldn't find enough interior ones
  while (pts.length < amount) pts.push([rng.range(min[0], max[0]), rng.range(min[1], max[1]), rng.range(min[2], max[2])]);
  return pts;
}

/**
 * Apply a "center bias" toward a point: pulls seeds toward `center` so fragments
 * get smaller near it (centerBias / ApplyCenterBias, strength ~1.3).
 * bias in [0,1]; 0 = no effect.
 */
export function applyCenterBias(points, center, bias, strength = 1.3) {
  if (!bias) return points;
  const b = Math.min(1, Math.max(0, bias));
  for (const p of points) {
    const t = Math.pow(b, strength) * 1.0;
    p[0] += (center[0] - p[0]) * t * b;
    p[1] += (center[1] - p[1]) * t * b;
    p[2] += (center[2] - p[2]) * t * b;
  }
  return points;
}

/**
 * Regular grid points — used for Bricks and Voxels. Their Voronoi cells are
 * axis-aligned boxes. Supports per-axis counts, jitter (size variation) and row
 * stagger (offset), reproducing RFBricks/RFVoxels.
 */
export function gridPoints(rng, min, max, { nx, ny, nz, jitter = [0, 0, 0], offset = [0, 0, 0] }) {
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const step = [size[0] / nx, size[1] / ny, size[2] / nz];
  const pts = [];
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        // brick stagger: shift alternate rows along X by offset, etc.
        const ox = (j % 2) * offset[0] * step[0];
        const oz = (j % 2) * offset[2] * step[2];
        let x = min[0] + (i + 0.5) * step[0] + ox;
        let y = min[1] + (j + 0.5) * step[1];
        let z = min[2] + (k + 0.5) * step[2] + oz;
        if (jitter[0]) x += (rng.next() - 0.5) * jitter[0] * step[0];
        if (jitter[1]) y += (rng.next() - 0.5) * jitter[1] * step[1];
        if (jitter[2]) z += (rng.next() - 0.5) * jitter[2] * step[2];
        pts.push([x, y, z]);
      }
    }
  }
  return pts;
}

/**
 * Radial points around a center axis — RFRadial. Produces fragments that
 * radiate from an impact point (good for bullet holes / glass).
 * params: { axis:'x'|'y'|'z', center, radius, rings, rays, twist, divergence,
 *           focus, randomRings, randomRays, restrictToPlane }
 * radius/divergence are fractions of the AABB extent.
 */
export function radialPoints(rng, min, max, params) {
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const ext = Math.max(size[0], size[1], size[2]) * 0.5;
  const ax = AXIS[params.axis ?? 'y'];
  const u = (ax + 1) % 3, v = (ax + 2) % 3;
  const center = params.center ?? [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const rings = Math.max(1, params.rings ?? 10);
  const rays = Math.max(1, params.rays ?? 10);
  const radius = (params.radius ?? 1) * ext;
  const twist = (params.twist ?? 0) * Math.PI / 180;
  const divergence = (params.divergence ?? 1);
  const focus = (params.focus ?? 0) * 0.01;          // 0..1 pull toward center
  const randRings = (params.randomRings ?? 0) * 0.01;
  const randRays = (params.randomRays ?? 0) * 0.01;
  const flat = params.restrictToPlane !== false;

  const pts = [];
  pts.push(center.slice()); // central seed
  for (let r = 0; r < rings; r++) {
    let rt = (r + 1) / rings;
    rt = Math.pow(rt, 1 + focus * 3);                // focus concentrates inner rings
    if (randRings) rt += (rng.next() - 0.5) * randRings / rings;
    const ringR = rt * radius;
    const ringTwist = twist * (r + 1);
    for (let a = 0; a < rays; a++) {
      let ang = (a / rays) * Math.PI * 2 + ringTwist;
      if (randRays) ang += (rng.next() - 0.5) * randRays * (Math.PI * 2 / rays);
      const p = [0, 0, 0];
      p[u] = Math.cos(ang) * ringR;
      p[v] = Math.sin(ang) * ringR;
      p[ax] = flat ? 0 : (rng.next() - 0.5) * divergence * ext;
      pts.push([center[0] + p[0], center[1] + p[1], center[2] + p[2]]);
    }
  }
  return pts;
}

/**
 * Tetrahedral / BCC lattice points — RFTets. `density` ≈ subdivisions, `noise`
 * 0..1 jitter, `lattice` 'uniform'|'curved'. Voronoi of a BCC lattice gives
 * truncated-octahedron fragments resembling crystalline tets.
 */
export function tetPoints(rng, min, max, { density = 7, noise = 1, lattice = 'uniform' }) {
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const n = Math.max(2, density);
  const step = [size[0] / n, size[1] / n, size[2] / n];
  const pts = [];
  for (let k = 0; k <= n; k++)
    for (let j = 0; j <= n; j++)
      for (let i = 0; i <= n; i++) {
        const add = (di, dj, dk) => {
          let x = min[0] + (i + di) * step[0];
          let y = min[1] + (j + dj) * step[1];
          let z = min[2] + (k + dk) * step[2];
          if (lattice === 'curved') { // bend lattice for organic look
            const t = (y - min[1]) / (size[1] || 1);
            x += Math.sin(t * Math.PI) * step[0] * 0.5;
          }
          if (noise) {
            x += (rng.next() - 0.5) * noise * step[0];
            y += (rng.next() - 0.5) * noise * step[1];
            z += (rng.next() - 0.5) * noise * step[2];
          }
          if (x >= min[0] && x <= max[0] && y >= min[1] && y <= max[1] && z >= min[2] && z <= max[2])
            pts.push([x, y, z]);
        };
        add(0, 0, 0);
        if (i < n && j < n && k < n) add(0.5, 0.5, 0.5); // BCC body centre
      }
  return pts;
}

/**
 * Hexagonal point lattice on a plane perpendicular to `axis` — approximates
 * RFHexagon (honeycomb columns). Columns run along `axis`.
 */
export function hexPoints(rng, min, max, { axis = 'z', rings = 6, columns = 1, noise = 0 }) {
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const ax = AXIS[axis];
  const u = (ax + 1) % 3, v = (ax + 2) % 3;
  const cu = (min[u] + max[u]) / 2, cv = (min[v] + max[v]) / 2;
  const r = Math.max(size[u], size[v]) / (2 * rings);
  const dx = r * 1.5, dy = r * Math.sqrt(3);
  const pts = [];
  const cols = Math.max(1, columns);
  for (let c = 0; c < cols; c++) {
    const along = min[ax] + (c + 0.5) / cols * size[ax];
    for (let q = -rings; q <= rings; q++) {
      for (let s = -rings; s <= rings; s++) {
        const pu = cu + q * dx;
        const pv = cv + s * dy + (q % 2) * dy * 0.5;
        if (pu < min[u] - r || pu > max[u] + r || pv < min[v] - r || pv > max[v] + r) continue;
        const p = [0, 0, 0];
        p[u] = pu + (noise ? (rng.next() - 0.5) * noise * r : 0);
        p[v] = pv + (noise ? (rng.next() - 0.5) * noise * r : 0);
        p[ax] = along;
        pts.push(p);
      }
    }
  }
  return pts;
}

/** Anisotropy weights for Splinters/Slabs from strength + axis. */
export function splinterWeights(axis, strength, mode /* 'splinter'|'slab' */) {
  const stretch = Math.min(1, Math.max(0.005, Math.pow(1 - strength, 1.5)));
  const w = [1, 1, 1];
  const a = AXIS[axis];
  if (mode === 'splinter') {
    w[a] = stretch;                       // elongate along `axis`
  } else { // slab: stretch the two axes perpendicular to `axis`
    for (let i = 0; i < 3; i++) if (i !== a) w[i] = stretch;
  }
  return w;
}
