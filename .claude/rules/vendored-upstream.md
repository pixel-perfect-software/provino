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
