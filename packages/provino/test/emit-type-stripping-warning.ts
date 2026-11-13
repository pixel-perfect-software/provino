// Preloaded with `--import`: prints what Node 22 prints when it strips types from a file, which CI's
// 22.15 leg gets because it runs with NODE_OPTIONS=--experimental-strip-types (Node 22.18 and up
// strip types without the flag and without the warning, so a newer Node never shows it). A test that
// asserts a child's stderr is empty must not depend on the Node it runs on, so it runs the child
// under this and `--disable-warning=ExperimentalWarning`.
process.emitWarning(
  'Type Stripping is an experimental feature and might change at any time',
  'ExperimentalWarning',
)
