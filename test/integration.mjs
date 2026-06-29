/**
 * Integration test: geometry kernel -> three.js -> Rapier physics.
 * Runs headless in Node (three + rapier3d-compat). Verifies shatter(),
 * RayHitMan/RayHitRigid simulation + demolition, and RayHitBomb.
 *
 * Run: node test/integration.mjs
 */
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  shatter, RayHitMan, RayHitRigid, RayHitBomb, RapierAdapter,
  RayHitGun, RayHitBlade, MeshData, fragment, fragmentAsync,
  MaterialType, SimType,
} from '../src/index.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  ✗', m); } };

async function main() {
  await RAPIER.init();

  // --- 1. shatter() produces fragment meshes with inner material ---
  {
    const mat = new THREE.MeshStandardMaterial({ color: 0x44aa88 });
    const inner = new THREE.MeshStandardMaterial({ color: 0xaa4444 });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), mat);
    const { group, fragments } = await shatter(mesh, { type: 'voronoi', amount: 24, seed: 9, THREE, innerMaterial: inner });
    ok(fragments.length >= 18, `shatter fragment count ${fragments.length}`);
    ok(group.children.length === fragments.length, 'group children match fragments');
    const f0 = fragments[0].mesh;
    ok(Array.isArray(f0.material) && f0.material.length === 2, 'fragment has [outer, inner] material array');
    ok(f0.geometry.getAttribute('position').count > 0, 'fragment geometry has vertices');
    ok(f0.geometry.groups.length >= 1, 'fragment geometry has material groups');
    console.log(`shatter(): ${fragments.length} fragments, materials=[outer,inner] ✓`);
  }

  // --- 2. physics simulation: a box falls onto the ground ---
  {
    const scene = new THREE.Scene();
    const phys = new RapierAdapter(RAPIER, { THREE, gravity: [0, -9.81, 0] });
    const man = new RayHitMan({ THREE, scene, physics: phys });
    await man.init();

    const ground = new THREE.Mesh(new THREE.BoxGeometry(20, 1, 20), new THREE.MeshStandardMaterial());
    ground.position.set(0, -0.5, 0); scene.add(ground);
    man.addRigid(ground, { simType: SimType.Static });

    const cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
    cube.position.set(0, 6, 0); scene.add(cube);
    man.addRigid(cube, { simType: SimType.Dynamic, material: MaterialType.Wood });

    const y0 = cube.position.y;
    for (let i = 0; i < 120; i++) man.update(1 / 60);
    const y1 = cube.position.y;
    ok(y1 < y0 - 2, `cube fell under gravity (${y0.toFixed(2)} -> ${y1.toFixed(2)})`);
    ok(y1 > -1, `cube rested on ground, didn't tunnel (${y1.toFixed(2)})`);
    console.log(`physics: cube fell ${(y0 - y1).toFixed(2)}m and rested at y=${y1.toFixed(2)} ✓`);
  }

  // --- 3. runtime demolition: force demolish a rigid, fragments spawn as bodies ---
  {
    const scene = new THREE.Scene();
    const phys = new RapierAdapter(RAPIER, { THREE });
    const man = new RayHitMan({ THREE, scene, physics: phys });
    await man.init();
    const cube = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshStandardMaterial());
    cube.position.set(0, 3, 0); scene.add(cube);
    const rigid = man.addRigid(cube, {
      simType: SimType.Dynamic, material: MaterialType.Glass,
      demolition: { type: 'voronoi', amount: 20, seed: 3, depth: 1, scatter: 1 },
    });
    const before = phys.bodies.size;
    const frags = await rigid.demolish({ point: [0, 3, 0] });
    ok(frags.length >= 15, `demolition produced ${frags.length} fragments`);
    ok(!scene.children.includes(cube), 'original mesh removed from scene');
    ok(phys.bodies.size >= before + 10, `fragment bodies added to physics world (${before} -> ${phys.bodies.size})`);
    // step and ensure fragments move
    const p0 = frags[0].mesh.position.clone();
    for (let i = 0; i < 30; i++) man.update(1 / 60);
    ok(frags[0].mesh.position.distanceTo(p0) > 0.01, 'fragment moved after demolition');
    console.log(`demolition: ${frags.length} simulated fragments spawned and moving ✓`);
  }

  // --- 4. bomb throws bodies outward ---
  {
    const scene = new THREE.Scene();
    const phys = new RapierAdapter(RAPIER, { THREE });
    const man = new RayHitMan({ THREE, scene, physics: phys });
    await man.init();
    const cubes = [];
    for (let i = 0; i < 8; i++) {
      const c = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), new THREE.MeshStandardMaterial());
      const a = (i / 8) * Math.PI * 2;
      c.position.set(Math.cos(a) * 2, 1, Math.sin(a) * 2); scene.add(c);
      man.addRigid(c, { simType: SimType.Dynamic, material: MaterialType.Brick });
      cubes.push(c);
    }
    const bomb = new RayHitBomb(man, { radius: 6, strength: 25, demolish: false });
    await bomb.explode([0, 1, 0]);
    man.update(1 / 60);
    const speeds = cubes.map(c => phys.getLinearVelocity(c)).map(v => Math.hypot(...v));
    const avg = speeds.reduce((a, b) => a + b, 0) / speeds.length;
    ok(avg > 2, `bomb imparted outward velocity (avg speed ${avg.toFixed(2)})`);
    console.log(`bomb: avg fragment speed after blast ${avg.toFixed(2)} m/s ✓`);
  }

  // --- 5. contact events are edge-triggered (resting body must not spam) ---
  {
    const scene = new THREE.Scene();
    const phys = new RapierAdapter(RAPIER, { THREE, gravity: [0, -9.81, 0] });
    const man = new RayHitMan({ THREE, scene, physics: phys });
    await man.init();
    let contacts = 0;
    phys.onContact(() => { contacts++; });
    const ground = new THREE.Mesh(new THREE.BoxGeometry(20, 1, 20), new THREE.MeshStandardMaterial());
    ground.position.set(0, -0.5, 0); scene.add(ground);
    man.addRigid(ground, { simType: SimType.Static });
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
    box.position.set(0, 2, 0); scene.add(box);
    man.addRigid(box, { simType: SimType.Dynamic });
    for (let i = 0; i < 240; i++) man.update(1 / 60); // 4s: drop, land, rest
    ok(contacts >= 1 && contacts <= 8, `resting box fired few contact events, not per-frame (${contacts} over 240 frames)`);
    console.log(`contact edge-trigger: ${contacts} events over 240 frames (resting box does NOT spam) ✓`);
  }

  // --- 6. impact demolishes, but resting/stacking must NOT self-demolish ---
  {
    const scene = new THREE.Scene();
    const phys = new RapierAdapter(RAPIER, { THREE, gravity: [0, -20, 0] });
    const man = new RayHitMan({ THREE, scene, physics: phys, groundY: 0 });
    await man.init();
    const tick = () => new Promise(r => setTimeout(r, 0)); // let async demolish() resolve
    const ground = new THREE.Mesh(new THREE.BoxGeometry(40, 1, 40), new THREE.MeshStandardMaterial());
    ground.position.set(0, -0.5, 0); scene.add(ground);
    man.addRigid(ground, { simType: SimType.Static });

    // a) a stack of dynamic blocks resting on each other must not self-demolish
    const stack = [];
    for (let i = 0; i < 4; i++) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
      b.position.set(0, 0.5 + i, 0); scene.add(b);
      stack.push(man.addRigid(b, { simType: SimType.Dynamic, material: MaterialType.Concrete, collider: 'box',
        demolition: { type: 'voronoi', amount: 8, depth: 1 } }));
    }
    for (let i = 0; i < 90; i++) { man.update(1 / 60); await tick(); }
    ok(stack.every(b => !b.demolished), `stacked blocks did NOT self-demolish on settling (${stack.filter(b => b.demolished).length}/4 broke)`);
    console.log(`stacking: a resting stack stays intact (no self-demolition) ✓`);

    // b) a fast ball still demolishes a block via contact
    const target = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshStandardMaterial());
    target.position.set(12, 1, 0); scene.add(target);
    const rg = man.addRigid(target, { simType: SimType.Kinematic, material: MaterialType.Glass, collider: 'box',
      demolition: { type: 'voronoi', amount: 12, depth: 1, collisionThreshold: 5 } });
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.6, 16, 12), new THREE.MeshStandardMaterial());
    ball.position.set(12, 1, -6); ball.userData.isBall = true; scene.add(ball);
    man.addRigid(ball, { simType: SimType.Dynamic, material: MaterialType.HeavyMetal, collider: 'sphere' });
    phys.setLinearVelocity(ball, [0, 0, 40]);
    for (let i = 0; i < 60 && !rg.demolished; i++) { man.update(1 / 60); await tick(); }
    ok(rg.demolished, 'fast ball demolished the target via contact');
    console.log(`impact: a fast ball still demolishes on contact ✓`);
  }

  // --- 7. fragmentAsync produces the same result as fragment ---
  {
    const opts = { type: 'voronoi', amount: 30, seed: 5 };
    const a = fragment(MeshData.fromBufferGeometry(new THREE.BoxGeometry(2, 2, 2)), opts);
    const b = await fragmentAsync(MeshData.fromBufferGeometry(new THREE.BoxGeometry(2, 2, 2)), { ...opts, batch: 4 });
    const va = a.fragments.reduce((s, f) => s + f.volume, 0);
    const vb = b.fragments.reduce((s, f) => s + f.volume, 0);
    ok(a.fragments.length === b.fragments.length, `async fragment count matches sync (${a.fragments.length} vs ${b.fragments.length})`);
    ok(Math.abs(va - vb) < 1e-6, `async volume matches sync (${va.toFixed(4)} vs ${vb.toFixed(4)})`);
    console.log(`async fragmentation: identical to sync (${b.fragments.length} fragments, yields between batches) ✓`);
  }

  // --- 8. RayHitGun raycast demolishes a target ---
  {
    const scene = new THREE.Scene();
    const phys = new RapierAdapter(RAPIER, { THREE });
    const man = new RayHitMan({ THREE, scene, physics: phys });
    await man.init();
    const target = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshStandardMaterial());
    target.position.set(0, 1.5, 0); scene.add(target);
    const rg = man.addRigid(target, { simType: SimType.Kinematic, material: MaterialType.Glass, collider: 'box',
      demolition: { type: 'voronoi', amount: 12, depth: 1, collisionThreshold: 1 } });
    man.update(1 / 60); // step once so the ray-query pipeline is populated
    const gun = new RayHitGun(man, { impulse: 10, demolish: true });
    const hit = gun.shoot([0, 1.5, -6], [0, 0, 1]);
    ok(hit && hit.object === target, 'gun ray hit the target');
    ok(rg.demolished, 'gun demolished the target on hit');
    await new Promise(r => setTimeout(r, 50));
    ok(rg.fragments && rg.fragments.length > 0, `gun produced fragments (${rg.fragments ? rg.fragments.length : 0})`);
    console.log(`gun: raycast hit and demolished the target into ${rg.fragments.length} fragments ✓`);
  }

  // --- 9. RayHitBlade slices a rigid into two halves ---
  {
    const scene = new THREE.Scene();
    const phys = new RapierAdapter(RAPIER, { THREE });
    const man = new RayHitMan({ THREE, scene, physics: phys });
    await man.init();
    const box = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshStandardMaterial());
    box.position.set(0, 1, 0); scene.add(box);
    const rg = man.addRigid(box, { simType: SimType.Kinematic, material: MaterialType.Concrete, collider: 'box' });
    const blade = new RayHitBlade(man);
    const halves = await blade.cut(rg, [0, 1, 0], [1, 0, 0]); // cut along world X=0
    ok(halves && halves.length === 2, `blade produced two halves (${halves ? halves.length : 0})`);
    ok(!scene.children.includes(box), 'blade removed the original mesh');
    console.log(`blade: sliced a box into ${halves.length} simulated halves ✓`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
