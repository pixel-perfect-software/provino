// The Vitest dialect's snapshot printer (T7.10): Vitest 5.0.5's `serialize` (`@vitest/snapshot`
// `port/utils.ts`) and its plugin order (`port/plugins.ts`) over the vendored
// `@vitest/pretty-format`, and the words of its failed snapshot matchers. Vitest's matcher only
// says which snapshot mismatched; the diff is its reporter's.
import type { SnapshotMessageInfo, SnapshotMessages, SnapshotPrinter } from '@provino/types'
import {
  format,
  type OptionsReceived,
  type Plugin,
  plugins,
} from '../vendor/pretty-format/index.ts'
import mockSerializer from '../vendor/pretty-format/mockSerializer.ts'

const { DOMCollection, DOMElement, Immutable, ReactTestComponent, AsymmetricMatcher } = plugins

/**
 * Vitest's built-in plugins, in its order (`port/plugins.ts`): the mock serializer last. The React
 * element plugin is not vendored (vendor/pretty-format/UPSTREAM.md).
 */
const BUILT_IN: readonly Plugin[] = [
  ReactTestComponent,
  DOMElement,
  DOMCollection,
  Immutable,
  AsymmetricMatcher,
  mockSerializer,
]

/** `escapeRegex`, `indent` and `printFunctionName` as `serialize` sets them (`port/utils.ts` L73-L90). */
const SERIALIZE_DEFAULTS = { escapeRegex: true, indent: 2, printFunctionName: false } as const

const mismatched = (info: SnapshotMessageInfo): string => `Snapshot \`${info.key}\` mismatched`

// `@vitest/snapshot` `client.ts` L188 and L167. A missing snapshot under CI is a mismatch with
// nothing to compare to, and says the same.
const messages: SnapshotMessages = {
  mismatch: mismatched,
  notWritten: mismatched,
  propertiesMismatch: () => 'Snapshot properties mismatched',
}

const printer: SnapshotPrinter = {
  serialize(value, options): string {
    return format(value, {
      ...SERIALIZE_DEFAULTS,
      plugins: [...options.plugins, ...BUILT_IN],
      ...options.format,
    } as OptionsReceived)
  },
  messages,
}

/**
 * The Vitest dialect's snapshot printer: what `vitestPolicy.snapshot.printer` loads. The worker
 * builds it once.
 * @public
 */
export function vitestSnapshotPrinter(): SnapshotPrinter {
  return printer
}
