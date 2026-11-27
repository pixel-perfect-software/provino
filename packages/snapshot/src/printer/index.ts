// @provino/snapshot/printer: the native snapshot printer, Jest 30.5.2's `serialize` over the vendored
// pretty-format, so a native run writes the bytes Jest writes. This module is a shim: a worker loads
// a project's printer when it starts, and most files write no snapshot, so the implementation
// (`@provino/snapshot/printer-impl`, `impl.ts`: pretty-format, its plugins, react-is) loads on the
// first `serialize` or `messages` read, synchronously, as `require(esm)` (unflagged since Node
// 22.12, without a warning since 22.13). Nothing in that graph awaits at its top level.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { SnapshotMessages, SnapshotPrinter, SnapshotPrinterFactory } from '@provino/types'

let loaded: SnapshotPrinter | undefined

/** The implementation's printer, loaded the first time it is asked for. */
function implementation(): SnapshotPrinter {
  if (loaded === undefined) {
    // Resolved by name, so the umbrella's build points it at its own file (`WORKER_ENTRIES`).
    const path = fileURLToPath(import.meta.resolve('@provino/snapshot/printer-impl'))
    const module = createRequire(import.meta.url)(path) as typeof import('./impl.ts')
    loaded = module.nativeSnapshotPrinter()
  }
  return loaded
}

const printer: SnapshotPrinter = {
  serialize: (value, options) => implementation().serialize(value, options),
  get messages(): SnapshotMessages {
    return implementation().messages
  },
}

/**
 * The native snapshot printer: Jest 30.5.2's plugin order and `serialize` defaults over the
 * vendored pretty-format, with Provino's own failure messages. The implementation loads on first use.
 * @public
 */
export const nativeSnapshotPrinter: SnapshotPrinterFactory = () => printer
