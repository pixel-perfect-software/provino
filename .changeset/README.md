# Changesets

A changeset records what a pull request changes in a published package, and by how much. Run
`pnpm changeset`, pick the packages, and write one line for the release notes.

`pnpm hygiene` fails when a `@public` signature of a package with a semver promise (`provino`, the
dialects, the environments and `@provino/types`, DECISIONS D67) changed since `main` and no
changeset added since then names that package. The private packages are in `config.json`'s
`ignore`, so they never need one.
