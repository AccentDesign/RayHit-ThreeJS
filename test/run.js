/**
 * Pure-Node kernel tests — no three.js, no physics. Validates the fracture
 * geometry (the reimplemented native kernel) is correct: fragments are
 * non-degenerate and conserve volume (sum of fragment volumes ≈ original).
 *
 * Run: npm test   (or: node test/run.js)
 */
import { MeshData } from '../src/fragment/MeshData.js';
import { fragment } from '../src/fragment/fragmenter.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('  ✗ FAIL:', msg); } };
const approx = (a, b, tol) => Math.abs(a - b) <= tol;

/** Build a box MeshData centered at origin. */
function box(sx = 1, sy = 1, sz = 1) {
  const md = new MeshData();
  const hx = sx / 2, hy = sy / 2, hz = sz / 2;
  // 6 faces, 4 verts each, outward normals, uv
  const faces = [
    { n: [0, 0, 1], v: [[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]] },
    { n: [0, 0, -1], v: [[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]] },
    { n: [1, 0, 0], v: [[hx, -hy, hz], [hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz]] },
    { n: [-1, 0, 0], v: [[-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz]] },
    { n: [0, 1, 0], v: [[-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz], [-hx, hy, -hz]] },
    { n: [0, -1, 0], v: [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz]] },
  ];
  for (const f of faces) {
    const base = md.vertCount;
    const uvs = [[0, 0], [1, 0], [1, 1], [0, 1]];
    for (let i = 0; i < 4; i++) md.addVertex(f.v[i][0], f.v[i][1], f.v[i][2], f.n[0], f.n[1], f.n[2], uvs[i][0], uvs[i][1]);
    md.addTriangle(base, base + 1, base + 2, 0);
    md.addTriangle(base, base + 2, base + 3, 0);
  }
  return md;
}

function hasNaN(md) {
  for (const x of md.positions) if (!Number.isFinite(x)) return true;
  return false;
}

function sumVolume(frags) { return frags.reduce((s, f) => s + f.mesh.volume(), 0); }

console.log('— rayhit-three kernel tests —\n');

// 1. Box volume sanity
{
  const md = box(2, 2, 2);
  ok(approx(md.volume(), 8, 1e-6), `box volume should be 8, got ${md.volume()}`);
  console.log(`box(2,2,2) volume = ${md.volume().toFixed(4)} ✓`);
}

// 2. Voronoi fracture conserves volume & produces valid fragments
for (const amount of [5, 20, 60]) {
  const md = box(2, 2, 2);
  const orig = md.volume();
  const { fragments } = fragment(md, { type: 'voronoi', amount, seed: 12345 });
  const vol = sumVolume(fragments);
  console.log(`voronoi amount=${amount}: ${fragments.length} fragments, volume ${vol.toFixed(4)} / ${orig}`);
  ok(fragments.length >= amount * 0.5, `expected ~${amount} fragments, got ${fragments.length}`);
  ok(approx(vol, orig, orig * 0.02), `volume not conserved: ${vol} vs ${orig}`);
  ok(!fragments.some(f => hasNaN(f.mesh)), 'fragment has NaN positions');
  ok(fragments.every(f => f.mesh.triCount >= 4), 'fragment with <4 triangles (not closed)');
}

// 3. Determinism: same seed -> identical fragment count & volume
{
  const a = fragment(box(2, 2, 2), { type: 'voronoi', amount: 25, seed: 777 });
  const b = fragment(box(2, 2, 2), { type: 'voronoi', amount: 25, seed: 777 });
  ok(a.fragments.length === b.fragments.length, 'determinism: fragment count differs');
  ok(approx(sumVolume(a.fragments), sumVolume(b.fragments), 1e-9), 'determinism: volume differs');
  console.log(`determinism: seed 777 -> ${a.fragments.length} fragments both runs ✓`);
}

// 4. Splinters (anisotropic) — fragments should be elongated along Y on average
{
  const md = box(2, 2, 2);
  const { fragments } = fragment(md, { type: 'splinters', amount: 40, seed: 5, axis: 'y', strength: 0.8 });
  let ySum = 0, xSum = 0;
  for (const f of fragments) { const b = f.mesh.bounds(); ySum += b[4] - b[1]; xSum += b[3] - b[0]; }
  const yAvg = ySum / fragments.length, xAvg = xSum / fragments.length;
  console.log(`splinters: avg fragment extent  Y=${yAvg.toFixed(3)}  X=${xAvg.toFixed(3)} (Y should be larger)`);
  ok(fragments.length > 10, 'splinters produced too few fragments');
  ok(yAvg > xAvg, 'splinters not elongated along Y');
  ok(approx(sumVolume(fragments), 8, 0.2), 'splinters volume not conserved');
}

// 5. Slices — 2 planes -> 4 pieces, volume conserved
{
  const md = box(2, 2, 2);
  const planes = [
    { n: [1, 0, 0], c: 0 },       // x=0
    { n: [0, 1, 0], c: 0 },       // y=0
  ];
  const { fragments } = fragment(md, { type: 'slices', planes });
  console.log(`slices (2 planes): ${fragments.length} pieces, volume ${sumVolume(fragments).toFixed(4)}`);
  ok(fragments.length === 4, `expected 4 pieces, got ${fragments.length}`);
  ok(approx(sumVolume(fragments), 8, 1e-4), 'slices volume not conserved');
}

// 6. Bricks grid
{
  const md = box(2, 2, 2);
  const { fragments } = fragment(md, { type: 'bricks', bricks: { nx: 2, ny: 3, nz: 2 }, seed: 1 });
  console.log(`bricks 2x3x2: ${fragments.length} fragments, volume ${sumVolume(fragments).toFixed(4)}`);
  ok(fragments.length >= 10, `expected ~12 bricks, got ${fragments.length}`);
  ok(approx(sumVolume(fragments), 8, 0.2), 'bricks volume not conserved');
}

// 7. Inner material assignment present on caps
{
  const md = box(2, 2, 2);
  const { fragments } = fragment(md, { type: 'voronoi', amount: 8, seed: 3, innerMatIndex: 1 });
  const anyInner = fragments.some(f => f.mesh.material.includes(1));
  ok(anyInner, 'no inner-material cap faces produced');
  console.log(`inner material: cap faces tagged with material index 1 -> ${anyInner ? 'yes' : 'no'} ✓`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
