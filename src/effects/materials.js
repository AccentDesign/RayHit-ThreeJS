/**
 * Physical material presets — ported verbatim from RFMaterial table
 * (RFMaterial.cs). Values: density (relative), drag, angularDrag, solidity
 * (resistance to demolition, higher = tougher), destructible, dynamicFriction,
 * staticFriction, bounciness. These drive fragment mass and collision response.
 */
export const MaterialType = Object.freeze({
  HeavyMetal: 'HeavyMetal', LightMetal: 'LightMetal', DenseRock: 'DenseRock',
  PorousRock: 'PorousRock', Concrete: 'Concrete', Brick: 'Brick',
  Glass: 'Glass', Rubber: 'Rubber', Ice: 'Ice', Wood: 'Wood',
});

export const MATERIALS = {
  HeavyMetal: { density: 11,  drag: 0, angularDrag: 0.05, solidity: 80, destructible: false, dynamicFriction: 0.75, staticFriction: 0.70, bounciness: 0.17 },
  LightMetal: { density: 8,   drag: 0, angularDrag: 0.05, solidity: 50, destructible: false, dynamicFriction: 0.71, staticFriction: 0.72, bounciness: 0.14 },
  DenseRock:  { density: 4,   drag: 0, angularDrag: 0.05, solidity: 22, destructible: true,  dynamicFriction: 0.88, staticFriction: 0.87, bounciness: 0.14 },
  PorousRock: { density: 2.5, drag: 0, angularDrag: 0.05, solidity: 12, destructible: true,  dynamicFriction: 0.84, staticFriction: 0.82, bounciness: 0.16 },
  Concrete:   { density: 3,   drag: 0, angularDrag: 0.05, solidity: 18, destructible: true,  dynamicFriction: 0.81, staticFriction: 0.83, bounciness: 0.15 },
  Brick:      { density: 2.3, drag: 0, angularDrag: 0.05, solidity: 10, destructible: true,  dynamicFriction: 0.76, staticFriction: 0.75, bounciness: 0.13 },
  Glass:      { density: 1.8, drag: 0, angularDrag: 0.05, solidity: 3,  destructible: true,  dynamicFriction: 0.53, staticFriction: 0.53, bounciness: 0.20 },
  Rubber:     { density: 1.4, drag: 0, angularDrag: 0.05, solidity: 1,  destructible: false, dynamicFriction: 0.95, staticFriction: 0.98, bounciness: 0.93 },
  Ice:        { density: 1,   drag: 0, angularDrag: 0.05, solidity: 2,  destructible: true,  dynamicFriction: 0.07, staticFriction: 0.07, bounciness: 0.00 },
  Wood:       { density: 0.7, drag: 0, angularDrag: 0.05, solidity: 4,  destructible: true,  dynamicFriction: 0.75, staticFriction: 0.73, bounciness: 0.22 },
};

export function getMaterial(type) {
  return MATERIALS[type] || MATERIALS.Concrete;
}

/** Mass from material density and fragment volume (density * volume). */
export function massFor(type, volume) {
  return Math.max(1e-4, getMaterial(type).density * volume);
}

/** Fade behaviours — FadeType. */
export const FadeType = Object.freeze({
  None: 'none', SimExclude: 'simExclude', FallDown: 'fallDown', ScaleDown: 'scaleDown',
  MoveDown: 'moveDown', Destroy: 'destroy', SetKinematic: 'setKinematic', SetStatic: 'setStatic',
});

/** Simulation types — SimType. */
export const SimType = Object.freeze({
  Dynamic: 'dynamic', Sleeping: 'sleeping', Inactive: 'inactive', Kinematic: 'kinematic', Static: 'static',
});

/** Demolition types — DemolitionType. */
export const DemolitionType = Object.freeze({
  None: 'none', Runtime: 'runtime', AwakePrecache: 'awakePrecache', AwakePrefragment: 'awakePrefragment',
});
