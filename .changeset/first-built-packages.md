---
"provino": minor
"@provino/dialect-jest": minor
"@provino/dialect-vitest": minor
"@provino/env-jsdom": minor
"@provino/env-node": minor
"@provino/types": minor
---

The first built packages: each ships ESM and declarations in `dist`, and its API is reported in `etc/` and checked by `pnpm hygiene`. `provino` gains the `.`, `/globals`, `/config`, `/reporters`, `/environment` and `/jest` entry points beside `/node`, and a `--version` flag.
