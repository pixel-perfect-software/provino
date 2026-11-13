---
paths:
  - "**/vendor/**"
  - "**/UPSTREAM.md"
---

# Vendored upstream code

- Copy only from a clone in `.refs/` checked out at a **pinned tag or commit** (DECISIONS S3).
- **Keep the original license header** on every file, unchanged. Jest is MIT, © Meta Platforms, Inc. and affiliates. Vitest is MIT, © its authors.
- Each vendor directory has an `UPSTREAM.md` listing: repository, tag, commit, source paths, the date copied, and every local patch.
- **Patch minimally**, and mark each patch with `// provino: <reason>` so a future upstream diff stays readable.
- Add the upstream's notice to the repo's `THIRD_PARTY_NOTICES.md` (create it on first vendor).
- Upstream runtime dependencies (e.g. `jest-matcher-utils`, `pretty-format`) are pinned to the exact upstream version the vendored code came from.
- **The notices ship with the code.** The build keeps some license headers and drops others, so `THIRD_PARTY_NOTICES.md` is what satisfies the license in a tarball: a package whose `dist` holds vendored code carries a copy of the root file, listed in its `files`, and `pnpm hygiene` (`packs`) fails when it is missing, differs from the root file, or an `UPSTREAM.md` directory is not named in it. After editing the root file, copy it over the copies in `provino`, `@provino/dialect-jest`, `@provino/dialect-vitest`, `@provino/snapshot`, `@provino/env-shared` and `@provino/coverage`.
