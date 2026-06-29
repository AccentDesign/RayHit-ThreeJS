# RayHit-ThreeJS

**Runtime mesh fracturing & physics destruction for [three.js](https://threejs.org).**
A from-scratch destruction toolkit — Voronoi shattering, runtime demolition,
bombs, fade, structural + load-stress collapse, gun, blade and dust/debris, with
a pluggable physics backend.

```
shatter() ──────────────► fragment meshes with capped inner surfaces
RayHitMan / RayHitRigid ─► runtime demolition on impact + simulation
RayHitBomb ─────────────► radial explosions
```

---

## How it works

The fracture kernel is pure JavaScript with **no dependencies** (it doesn't even
need three.js):

1. Scatter seed points (random / radial / grid / lattice / custom).
2. Build 3D **Voronoi cells** by half-space clipping — each cell is the bounding
   box clipped by the perpendicular bisector of every neighbouring seed (the
   classic [Voro++](https://math.lbl.gov/voro++/) cell method), with a security
   radius so per-cell cost stays local.
3. **Slice** the mesh by each cell's planes and **cap** the cut with a separate
   inner material (planar face-tracing, so it stays watertight even on
   axis-aligned cuts).
4. Recenter each fragment to its own pivot so it can be placed/simulated
   independently.

It is verified to **conserve volume exactly** on watertight meshes and is
**deterministic** per seed (same seed + params → identical fragments, every run,
every platform).

---

## Install

```bash
npm install three
# the geometry kernel needs nothing else. For physics, pick one:
npm install @dimforge/rapier3d-compat   # recommended (default adapter)
# or
npm install cannon-es                    # pure-JS alternative
```

`three` is a peer dependency. The geometry kernel (fracturing) has **no
dependencies** and runs in plain Node — only the physics layer needs an engine.

---

## Quick start

### 1. Just fracture a mesh (no physics)

```js
import * as THREE from 'three';
import { shatter, setThree } from 'rayhit-three';

setThree(THREE); // once, so the lib doesn't need to import three itself

const mesh = new THREE.Mesh(
  new THREE.BoxGeometry(2, 2, 2),
  new THREE.MeshStandardMaterial({ color: 0x4f9dff })
);

const { group, fragments } = await shatter(mesh, {
  type: 'voronoi',     // voronoi | splinters | slabs | radial | bricks | voxels | tets | slices | custom
  amount: 40,
  seed: 1,
  innerMaterial: new THREE.MeshStandardMaterial({ color: 0xffae42 }), // cut surfaces
});

scene.remove(mesh);
scene.add(group);      // a THREE.Group of fragment meshes, positioned to overlay the original
```

Each fragment is a `THREE.Mesh` with a `[...originalMaterials, innerMaterial]`
material array — outer faces keep the original materials, newly-cut faces use the
dedicated inner material.

### 2. Runtime physics demolition

```js
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { RayHitMan, RapierAdapter, RayHitBomb, setThree, MaterialType, SimType, FadeType } from 'rayhit-three';

setThree(THREE);
await RAPIER.init();

const physics = new RapierAdapter(RAPIER, { THREE, gravity: [0, -9.81, 0] });
const man = new RayHitMan({ THREE, scene, physics });
await man.init();

// static ground
man.addRigid(groundMesh, { simType: SimType.Static });

// a demolishable block
man.addRigid(blockMesh, {
  simType: SimType.Dynamic,
  material: MaterialType.Concrete,
  collider: 'box',
  // shatter on hard impact only; minImpactSpeed (m/s) ignores resting/stacking
  // contact so a stacked wall doesn't shatter itself on spawn (default 2.5):
  demolition: { type: 'voronoi', amount: 15, depth: 1, scatter: 1, minImpactSpeed: 2.5 },
  fade: { type: FadeType.ScaleDown, lifetime: 6, duration: 2 },
  dust: { amount: 16, size: 0.45 },     // puff on demolition
  debris: { amount: 12, size: 0.09 },   // chips on demolition
});

// each frame:
function animate(dt) { man.update(dt); renderer.render(scene, camera); }

// explosions:
await new RayHitBomb(man, { radius: 6, strength: 25, demolish: true }).explode([0, 2, 0]);
```

### 3. Structural collapse (connectivity)

Pre-fracture a structure, link the shards, and let it collapse when its support
is destroyed — knock out the base and everything above falls, cascading:

```js
import { RayHitConnectivity, SimType } from 'rayhit-three';

const { fragments } = await shatter(towerMesh, { type: 'voronoi', amount: 90 });
const rigids = fragments.map(f => man.addRigid(f.mesh, { simType: SimType.Kinematic, collider: 'hull' }));

const con = new RayHitConnectivity(man, { connectionType: 'boundingBox', overlap: 0.06 });
con.setShards(rigids, node => node.aabb.min.y < 0.15); // ground row = anchors
con.build();
con.start();           // anchors static, the rest frozen but held

con.removeShard(hitShard);   // destroy a shard → unsupported shards above activate & fall
con.activateAt([x, y, z], radius, kick); // blast a region; collapse cascades
```

Support flows only through anchored + still-held shards, so destroying a
load-bearing shard drops everything that depended on it (see `examples/collapse.html`).

**Load-stress.** Beyond pure connectivity, each held shard carries its own weight
plus everything routed through it to the anchors; a shard whose load exceeds its
strength (`stressStrength × supporting links`) fails. Call `con.stressStep()`
per tick (or `con.relaxStress()` to settle) and overloaded cantilevers snap at
the root, top-heavy towers buckle at the base:

```js
const con = new RayHitConnectivity(man, { stressStrength: 8, weightByVolume: true });
con.setShards(rigids, anchorPred).build().start();
// each frame (or every few frames):
con.stressStep();   // fails the single most-overloaded shard, then cascades
```

### Shoot & slice

```js
import { RayHitGun, RayHitBlade } from 'rayhit-three';

const gun = new RayHitGun(man, { impulse: 25, demolish: true, connectivity: con });
gun.shoot(camera.position.toArray(), camDir.toArray());  // raycast → demolish/knock + impulse

const blade = new RayHitBlade(man);
await blade.cut(rigid, worldPoint, worldNormal);          // slice into two simulated halves
```

### Non-blocking fracture

For big shatters, `shatterAsync` / `fragmentAsync` produce identical results to
the sync versions but yield to the event loop every `batch` cells (default 8) so
the frame doesn't hitch; pass `onProgress(t)` for a 0..1 progress callback.

---

## Fragmentation types

| `type`       | Pattern | Notes |
|--------------|---------|-------|
| `voronoi`    | irregular chunks | uniform random Voronoi cells (`amount`, `seed`, `centerBias`) |
| `splinters`  | shards | cells elongated along `axis` by `strength` (anisotropic metric) |
| `slabs`      | flat slabs | slabs perpendicular to `axis` |
| `radial`     | impact/glass | rings/rays around a center (`radial:{axis,rings,rays,radius,twist,...}`) |
| `bricks`     | brick grid | (`bricks:{nx,ny,nz}` or `{size:[x,y,z]}`, `offset`, `jitter`) |
| `voxels`     | cubes | cubic grid (`voxels:{size}`) |
| `tets`       | crystalline | lattice (`tets:{density,noise,lattice}`) |
| `slices`     | planar cuts | explicit cut planes (`planes:[{n:[x,y,z], c}]`) |
| `custom`     | your points | (`points:[[x,y,z],...]`) |

Common options: `seed`, `amount`, `centerBias` (0–1, bias fragment density to a
point), `biasCenter` ([x,y,z]), `innerMatIndex`, `capUvScale`, `seedInside`.

---

## Materials

Physical material presets (`MaterialType.*`): `HeavyMetal`, `LightMetal`,
`DenseRock`, `PorousRock`, `Concrete`, `Brick`, `Glass`, `Rubber`, `Ice`, `Wood`.
Each carries density (→ fragment mass), friction, bounciness and `solidity`
(resistance to demolition). A collision must exceed both a solidity-derived
impulse threshold and `demolition.minImpactSpeed` (relative impact velocity) to
shatter — so a resting/stacked structure never self-destructs.

## Fade (`FadeType.*`)

`None`, `Destroy`, `ScaleDown`, `FallDown`, `MoveDown`, `SimExclude`,
`SetKinematic`, `SetStatic` — fragments retire after `lifetime` seconds over
`duration`, keeping the scene from filling with debris (`RayHitMan.fragmentLimit`
caps the total).

## Particles — dust & debris (`RayHitParticles`)

Self-simulated (no physics bodies, so they're cheap): a soft `THREE.Points`
**dust** puff that drifts up and fades, and a **debris** `InstancedMesh` of
small chips with ballistic motion + ground bounce. Emitted automatically on
demolition when a `RayHitRigid` has `dust`/`debris` options, or manually:

```js
man.emitDust([x, y, z],   { amount: 30, size: 0.5, color: 0x9b8e7a, lifetime: 1.4 });
man.emitDebris([x, y, z], { amount: 24, size: 0.08, color: 0x8a7a66, speed: 4, bounce: 0.35 });
```

---

## Pluggable physics

Anything implementing `PhysicsAdapter` works. Two adapters ship:

- **`RapierAdapter`** (recommended) — Dimforge Rapier (WASM); convex-hull
  colliders + edge-triggered contact events for collision demolition.
- **`CannonAdapter`** — cannon-es (pure JS), no WASM.

Use `NullAdapter` for a static fracture preview with no simulation.

---

## API surface

| Export | Role |
|--------|------|
| `shatter(mesh, opts)` | fracture a mesh into a group of fragment meshes |
| `shatterAsync` / `fragmentAsync` | non-blocking fracture (yields per batch) |
| `fractureToGeometries(geom, opts)` | fracture to bare BufferGeometries |
| `RayHitMan` | manager: steps physics, routes collisions, fade, limits |
| `RayHitRigid` | per-object simulation + runtime demolition |
| `RayHitBomb` | radial explosion (+ demolition) |
| `RayHitConnectivity` | structural integrity graph + load-stress collapse |
| `RayHitGun` | raycast shooting (demolish / knock / impulse) |
| `RayHitBlade` | slice an object in two along a plane |
| `RayHitParticles` | dust puffs + debris chips |
| `fragment(meshData, opts)` | low-level kernel fracture (no three.js) |
| `Voronoi`, `ConvexCell`, `sliceMesh`, `MeshData` | geometry primitives |
| `MaterialType`, `MATERIALS`, `FadeType`, `SimType` | data / enums |

---

## Examples

Serve the folder and open the demos:

```bash
npm run demo            # python3 -m http.server 8088
# http://localhost:8088/examples/shatter.html       — fracture primitives (geometry only)
# http://localhost:8088/examples/destruction.html   — a brick wall: gun (click), blade (X), projectile, bomb
# http://localhost:8088/examples/collapse.html       — tower/wall/cantilever: connectivity + gravity-stress collapse
# http://localhost:8088/examples/character.html      — fracture a 3D character (supply your own model — see examples/models)
```

The demos load `three` and `rapier` from local `node_modules`, so they run
offline. For concave/thin meshes (characters) pass `seedInside: true` so seeds
are rejection-sampled inside the solid — you get the full requested fragment
count instead of wasting cells on empty bounding-box space.

## Tests

```bash
npm test                       # geometry kernel: volume conservation, determinism, all frag types
node test/connectivity.mjs     # structural collapse + load-stress cascade
node test/particles.mjs        # dust/debris simulation: fall, settle, fade, expire
node test/integration.mjs      # full stack: three.js + Rapier (shatter, fall, demolish, bomb, gun, blade)
```

63 tests across the four files.

---

## Notes & limits

- **Watertight input** fractures perfectly (exact volume). Open / non-manifold
  meshes (typical game characters) still fracture and look correct, but caps on
  open cross-sections are approximate (a few % volume difference).
- Skinned meshes are fractured in **bind pose** (merge + fracture the geometry).
- Fragment colliders default to **convex hulls**; very thin slivers fall back to
  boxes to keep the solver stable.

## License

MIT
