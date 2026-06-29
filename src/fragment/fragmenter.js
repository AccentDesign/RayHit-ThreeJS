/**
 * fragmenter — the geometry engine. Given a MeshData and fragmentation options,
 * it generates seed points, builds Voronoi cells (or slice planes) and carves
 * the mesh into fragment MeshData pieces with capped inner surfaces.
 *
 * This is the JS equivalent of RFEngine + native Utils kernel:
 *   scatter points → Voronoi.build → per cell: slice mesh by cell planes → cap.
 *
 * `fragment()` is synchronous; `fragmentAsync()` does the same work but yields to
 * the event loop every `batch` cells so a large shatter doesn't hitch the frame.
 *
 * Returns { fragments: [{ mesh, pivot, volume }], cells }; `pivot` is the
 * fragment centroid in mesh-local space (the fragment mesh is recentered to its
 * own origin so it can be placed/simulated independently, with their own pivot).
 */
import { MeshData } from './MeshData.js';
import { Voronoi } from '../core/Voronoi.js';
import { sliceMesh } from './slicer.js';
import { Rng } from '../math/random.js';
import {
  randomPoints, gridPoints, radialPoints, tetPoints, hexPoints,
  applyCenterBias, splinterWeights, sampleInsidePoints,
} from './scatter.js';

export const FragType = Object.freeze({
  Voronoi: 'voronoi', Splinters: 'splinters', Slabs: 'slabs', Radial: 'radial',
  Hexagon: 'hexagon', Bricks: 'bricks', Voxels: 'voxels', Tets: 'tets',
  Custom: 'custom', Slices: 'slices',
});

/** Build the slice plan (cells or planes) + slice options. Shared sync/async. */
function prepare(md, opt) {
  const type = opt.type || 'voronoi';
  const rng = new Rng(opt.seed ?? 1);

  const b = md.bounds();
  const size = [b[3] - b[0], b[4] - b[1], b[5] - b[2]];
  const diag = Math.hypot(size[0], size[1], size[2]) || 1;
  const pad = diag * 0.01 + 1e-5;
  const min = [b[0] - pad, b[1] - pad, b[2] - pad];
  const max = [b[3] + pad, b[4] + pad, b[5] + pad];
  const center = opt.biasCenter || [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2];
  const eps = diag * 1e-7 + 1e-9;

  let innerMat = opt.innerMatIndex;
  if (innerMat == null) { let m = 0; for (const x of md.material) if (x > m) m = x; innerMat = m + 1; }
  const sliceOpt = { innerMat, capUvScale: opt.capUvScale ?? (1 / diag), eps };

  if (type === 'slices') return { mode: 'slices', planes: opt.planes || [], sliceOpt };

  let points;
  let weights = [1, 1, 1];
  const rand = (n) => opt.seedInside ? sampleInsidePoints(rng, md, min, max, n) : randomPoints(rng, min, max, n);
  switch (type) {
    case 'voronoi': points = rand(opt.amount ?? 30); break;
    case 'splinters': points = rand(opt.amount ?? 30); weights = splinterWeights(opt.axis ?? 'y', opt.strength ?? 0.7, 'splinter'); break;
    case 'slabs': points = rand(opt.amount ?? 30); weights = splinterWeights(opt.axis ?? 'y', opt.strength ?? 0.7, 'slab'); break;
    case 'radial': points = radialPoints(rng, min, max, { ...opt.radial, center: opt.biasCenter || undefined }); break;
    case 'hexagon': points = hexPoints(rng, min, max, opt.hexagon || {}); break;
    case 'tets': points = tetPoints(rng, min, max, opt.tets || {}); break;
    case 'bricks': {
      const p = opt.bricks || {};
      let nx = p.nx, ny = p.ny, nz = p.nz;
      if (p.size) { nx = Math.max(1, Math.round(size[0] / p.size[0])); ny = Math.max(1, Math.round(size[1] / p.size[1])); nz = Math.max(1, Math.round(size[2] / p.size[2])); }
      points = gridPoints(rng, min, max, { nx: nx || 3, ny: ny || 6, nz: nz || 1, jitter: p.jitter || [0, 0, 0], offset: p.offset || [0.5, 0, 0] });
      break;
    }
    case 'voxels': {
      const s = (opt.voxels && opt.voxels.size) || diag / 8;
      const nx = Math.max(1, Math.round(size[0] / s)), ny = Math.max(1, Math.round(size[1] / s)), nz = Math.max(1, Math.round(size[2] / s));
      points = gridPoints(rng, min, max, { nx, ny, nz });
      break;
    }
    case 'custom': points = (opt.points || []).map(p => Array.isArray(p) ? p.slice() : [p.x, p.y, p.z]); break;
    default: points = randomPoints(rng, min, max, opt.amount ?? 30);
  }

  if (opt.centerBias) applyCenterBias(points, center, opt.centerBias);
  if (points.length < 1) return { mode: 'cells', cells: [], sliceOpt };

  const cells = new Voronoi(points, min, max, weights).build({ includeBoundary: !!opt.includeBoundary });
  return { mode: 'cells', cells, sliceOpt };
}

/** Carve one fragment by intersecting the mesh with a cell's planes. */
function sliceByPlanes(md, planes, sliceOpt) {
  let piece = md;
  for (const pl of planes) { piece = sliceMesh(piece, pl, sliceOpt); if (!piece) return null; }
  return piece;
}

/** Recursive plane splitting for FragType.Slices (each plane doubles the pieces). */
function slicesSplit(md, planes, sliceOpt) {
  let pieces = [md];
  for (const pl of planes) {
    const next = [];
    for (const piece of pieces) {
      const inside = sliceMesh(piece, { n: pl.n, c: pl.c }, sliceOpt);
      const outside = sliceMesh(piece, { n: [-pl.n[0], -pl.n[1], -pl.n[2]], c: -pl.c }, sliceOpt);
      if (inside) next.push(inside);
      if (outside) next.push(outside);
    }
    pieces = next;
  }
  return pieces.map(m => ({ mesh: m }));
}

/** @returns {{fragments:{mesh:MeshData,pivot:number[],volume:number}[], cells:any[]}} */
export function fragment(md, opt = {}) {
  const prep = prepare(md, opt);
  if (prep.mode === 'slices') return finalize(slicesSplit(md, prep.planes, prep.sliceOpt));
  const out = [];
  for (const cell of prep.cells) {
    if (!cell.planes.length) continue;
    const piece = sliceByPlanes(md, cell.planes, prep.sliceOpt);
    if (piece && piece.triCount > 0) out.push({ mesh: piece, site: cell.site });
  }
  return finalize(out);
}

/**
 * Async fragmentation — identical result to fragment(), but yields to the event
 * loop every `opt.batch` cells (default 8) so big shatters don't block a frame.
 * `opt.onProgress(t)` is called with 0..1 between batches.
 */
export async function fragmentAsync(md, opt = {}) {
  const prep = prepare(md, opt);
  if (prep.mode === 'slices') return finalize(slicesSplit(md, prep.planes, prep.sliceOpt));
  const batch = Math.max(1, opt.batch ?? 8);
  const out = [];
  const cells = prep.cells;
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    if (cell.planes.length) {
      const piece = sliceByPlanes(md, cell.planes, prep.sliceOpt);
      if (piece && piece.triCount > 0) out.push({ mesh: piece, site: cell.site });
    }
    if ((i + 1) % batch === 0) {
      if (opt.onProgress) opt.onProgress((i + 1) / cells.length);
      await new Promise(r => setTimeout(r, 0));
    }
  }
  return finalize(out);
}

function finalize(items) {
  const fragments = [];
  for (const it of items) {
    const m = it.mesh;
    if (!m || m.triCount === 0) continue;
    const vol = m.volume();
    if (vol < 1e-12) continue;
    const pivot = m.recenter();
    fragments.push({ mesh: m, pivot, volume: vol });
  }
  return { fragments, cells: items.map(i => i.site).filter(Boolean) };
}
