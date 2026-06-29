# Demo models

`examples/character.html` fractures a 3D character. The models used during
development are **Synty Studios** assets (commercial, licensed) and are **not**
included in this repo — they can't be redistributed.

To run the character demo, drop your own models here and update the `MODELS` map
near the top of `examples/character.html`:

| key in character.html | file expected here |
|---|---|
| `king`     | `king.fbx` (+ a UV atlas `.png`) |
| `skeleton` | `skeleton.fbx` (+ atlas) |
| `statue`   | `knight_statue.glb` |

Any GLB/FBX humanoid works — the loader merges its sub-meshes, normalizes the
size, and fractures the result. For best coverage on thin/concave meshes the
demo passes `seedInside: true` to `shatter()`.
