---
"@provino/types": minor
"@provino/transform": minor
---

TypeScript on the coverage path is stripped in place (D116): a `.ts`, `.mts` or `.cts` file requested with `instrument: true` has its type syntax overwritten with spaces, so every token keeps its offset and the instrumenter gets no input map, and Istanbul's statement, function and branch maps equal Jest's babel provider. A file with an enum, a namespace with values, a parameter property, `import x =`, `export =`, a decorator under `experimentalDecorators` or a class field under `useDefineForClassFields: false`, a `.tsx` file, and any file under `define` keep Oxc's transform and its map. `SerializedLoaderConfig.typescript` and the pipeline's `typescript` option gain `'blank'`, which strips every erasable TypeScript file that way.
