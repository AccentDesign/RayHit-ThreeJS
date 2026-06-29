/**
 * Headless particle-sim tests (three.js, no renderer). Verifies dust/debris
 * motion + lifetime from values: debris falls and rests on the ground, dust
 * drifts and both bursts expire on schedule.
 *
 * Run: node test/particles.mjs
 */
import * as THREE from 'three';
import { RayHitParticles } from '../src/index.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  ✗', m); } };

const scene = new THREE.Scene();
const fx = new RayHitParticles(THREE, scene);

// --- debris falls under gravity and rests on the ground ---
{
  fx.debris([0, 5, 0], { amount: 20, lifetime: 10, speed: 2, gravity: 14, groundY: 0, size: 0.1 });
  const burst = fx.bursts[fx.bursts.length - 1];
  const y0 = burst.data[0].p[1];
  for (let i = 0; i < 120; i++) fx.update(1 / 60); // 2s
  const ys = burst.data.map(d => d.p[1]);
  const minY = Math.min(...ys);
  ok(minY < y0, `debris fell (start ${y0.toFixed(2)} -> min ${minY.toFixed(2)})`);
  ok(ys.every(y => y >= -0.01), 'debris did not fall through the ground');
  const resting = burst.data.filter(d => d.rest).length;
  ok(resting > 0, `some debris came to rest on the ground (${resting}/20)`);
  console.log(`debris: fell and ${resting}/20 chips settled on the ground ✓`);
}

// --- dust drifts upward/outward and the burst expires ---
{
  fx.clear();
  fx.dust([0, 1, 0], { amount: 30, lifetime: 1, speed: 1, rise: 1 });
  const burst = fx.bursts[fx.bursts.length - 1];
  const p0 = burst.obj.geometry.attributes.position.array.slice();
  for (let i = 0; i < 20; i++) fx.update(1 / 60); // 0.33s
  const p1 = burst.obj.geometry.attributes.position.array;
  let moved = 0;
  for (let i = 0; i < burst.n; i++) if (Math.abs(p1[i * 3 + 1] - p0[i * 3 + 1]) > 1e-3) moved++;
  ok(moved > 20, `dust particles drifted (${moved}/30 moved)`);
  ok(burst.obj.material.opacity < 0.55, 'dust faded as it aged');
  console.log(`dust: ${moved}/30 particles drifted and faded ✓`);
}

// --- bursts are removed after their lifetime ---
{
  fx.clear();
  fx.dust([0, 0, 0], { amount: 10, lifetime: 0.5 });
  fx.debris([0, 0, 0], { amount: 10, lifetime: 0.5, groundY: -100 });
  ok(fx.bursts.length === 2, 'two live bursts');
  for (let i = 0; i < 40; i++) fx.update(1 / 60); // 0.66s > lifetime
  ok(fx.bursts.length === 0, `bursts expired and were cleaned up (${fx.bursts.length} left)`);
  ok(scene.children.length === 0, 'particle objects removed from scene');
  console.log('lifetime: bursts expire and are removed from the scene ✓');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
