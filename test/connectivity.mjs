/**
 * Headless structural-collapse tests (three.js + NullAdapter, no renderer).
 * Verifies the connection graph and progressive-collapse cascade from values.
 *
 * Run: node test/connectivity.mjs
 */
import * as THREE from 'three';
import { RayHitMan, RayHitConnectivity, NullAdapter } from '../src/index.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  ✗', m); } };

function boxAt(x, y, z, s = 1) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), new THREE.MeshBasicMaterial());
  m.position.set(x, y, z); m.updateMatrixWorld(true);
  return m;
}

async function main() {
  const scene = new THREE.Scene();
  const man = new RayHitMan({ THREE, scene, physics: new NullAdapter() });
  await man.init();
  const anchorPred = n => n.aabb.min.y < 0.01; // anything sitting on the ground

  // --- 1. vertical column: remove the shard above the anchor -> all above fall ---
  {
    const col = [];
    for (let i = 0; i < 5; i++) col.push(boxAt(0, 0.5 + i, 0)); // stacked unit cubes, bottom on ground
    const con = new RayHitConnectivity(man, { connectionType: 'boundingBox', overlap: 0.05 });
    con.setShards(col, anchorPred).build().start();
    let s = con.stats();
    ok(s.anchors === 1 && s.held === 4 && s.active === 0, `column start: ${JSON.stringify(s)}`);
    // graph: each interior box has 2 neighbors, ends have 1
    ok(con.shards[2].neighbors.size === 2, 'middle box has 2 neighbours');
    // remove box index 1 (directly above the anchor) -> boxes 2,3,4 lose support
    con.removeShard(col[1]);
    s = con.stats();
    ok(s.removed === 1 && s.active === 3 && s.held === 0, `after removing base support: ${JSON.stringify(s)}`);
    console.log(`column collapse: removed 1 base shard -> ${s.active} shards fell ✓`);
  }

  // --- 2. wall grid: a single base shard removed is still held (horizontal support) ---
  {
    const grid = [], W = 4, H = 4;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) grid.push(boxAt(x, 0.5 + y, 0));
    const con = new RayHitConnectivity(man, { overlap: 0.05 });
    con.setShards(grid, anchorPred).build().start();
    ok(con.stats().anchors === W, `wall anchors = bottom row (${con.stats().anchors})`);
    // remove ONE bottom-row anchor's neighbour above it -> still supported sideways
    con.removeShard(grid[W + 1]); // row1, col1
    let s = con.stats();
    ok(s.active === 0, `single interior removal stays supported via neighbours: ${JSON.stringify(s)}`);
    console.log(`wall integrity: 1 shard removed, structure holds (active=${s.active}) ✓`);

    // now remove the ENTIRE row above the anchors -> everything above collapses
    for (let x = 0; x < W; x++) if (!grid[W + x].__rm) { con.removeShard(grid[W + x]); grid[W + x].__rm = 1; }
    s = con.stats();
    ok(s.active === W * (H - 2), `cutting the support row collapses all above: ${JSON.stringify(s)}`);
    console.log(`wall collapse: removed support row -> ${s.active} shards fell ✓`);
  }

  // --- 3. activateAt: explosion frees a region and cascades upward ---
  {
    const col = [];
    for (let i = 0; i < 6; i++) col.push(boxAt(0, 0.5 + i, 0));
    const con = new RayHitConnectivity(man, { overlap: 0.05 });
    con.setShards(col, anchorPred).build().start();
    con.activateAt([0, 2.5, 0], 0.6); // free the shard at y~2.5 (index 2)
    const s = con.stats();
    ok(s.active >= 3, `activateAt freed shard + cascade above: ${JSON.stringify(s)}`);
    console.log(`explosion cascade: freeing mid-column dropped ${s.active} shards ✓`);
  }

  // --- 4. RFStress: a weak cantilever snaps near its anchored root ---
  {
    const beam = [];
    for (let i = 0; i < 8; i++) beam.push(boxAt(i, 2, 0)); // horizontal beam, root at x=0
    const con = new RayHitConnectivity(man, { overlap: 0.05, stressStrength: 4 });
    con.setShards(beam, n => n.aabb.min.x < 0.5).build().start();
    ok(con.stats().anchors === 1, `cantilever has one anchored root (${con.stats().anchors})`);
    con.relaxStress();
    const s = con.stats();
    ok(s.active === 7, `weak cantilever collapsed under its own load (active ${s.active}/7)`);
    console.log(`stress: weak cantilever snapped at the root -> ${s.active} shards fell ✓`);
  }

  // --- 5. a strong connection holds the same cantilever ---
  {
    const beam = [];
    for (let i = 0; i < 8; i++) beam.push(boxAt(i, 2, 0));
    const con = new RayHitConnectivity(man, { overlap: 0.05, stressStrength: 50 });
    con.setShards(beam, n => n.aabb.min.x < 0.5).build().start();
    con.relaxStress();
    ok(con.stats().active === 0, `strong cantilever holds (active ${con.stats().active})`);
    console.log(`stress: strong cantilever holds its own weight ✓`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
