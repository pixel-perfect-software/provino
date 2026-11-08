// The Jest dialect's snapshot printer (T7.10): Jest 30.5.2's `serialize` and its plugin order over
// `pretty-format` 30.5.1, and the words of its failed snapshot matchers. The pieces come from
// `jest-snapshot` (`plugins.ts`, `utils.ts` `serialize`, `index.ts`'s messages); Provino does
// not import `jest-snapshot` at runtime (T7.12's ban), so what it needs is here and in `vendor/`.
import type { SnapshotMessageInfo, SnapshotMessages, SnapshotPrinter } from '@provino/types'
import {
  BOLD_WEIGHT,
  diff,
  matcherHint,
  printDiffOrStringify,
  RECEIVED_COLOR,
} from 'jest-matcher-utils'
import { format, type OptionsReceived, type Plugin, plugins } from 'pretty-format'
import jestMockSerializer from './vendor/jest-snapshot/mockSerializer.ts'

const {
  DOMCollection,
  DOMElement,
  Immutable,
  ReactElement,
  ReactTestComponent,
  AsymmetricMatcher,
} = plugins

/**
 * Jest's built-in plugins, in its order (`plugins.ts` L9-L22). A serializer added by a project or
 * a test goes in front of them.
 */
const BUILT_IN: readonly Plugin[] = [
  ReactTestComponent,
  ReactElement,
  DOMElement,
  DOMCollection,
  Immutable,
  jestMockSerializer,
  AsymmetricMatcher,
]

/** `escapeRegex`, `indent` and `printFunctionName` as `serialize` (`utils.ts` L56-L72) sets them. */
const SERIALIZE_DEFAULTS = { escapeRegex: true, indent: 2, printFunctionName: false } as const

const NOT_WRITTEN =
  'New snapshot was not written. The update flag must be explicitly passed to write a new snapshot.\n\n' +
  'This is likely because this test is run in a continuous integration (CI) environment in which snapshots are not written by default.'

/** `@jest/snapshot-utils`' `escapeBacktickString`. */
const escapeBacktickString = (text: string): string => text.replaceAll(/`|\\|\${/g, '\\$&')

/** `Snapshot name: \`<test name>: <hint> <count>\``, with the hint in bold weight (index.ts L56-L68). */
function snapshotName(info: SnapshotMessageInfo): string {
  const { currentTestName, hint, count } = info
  const hasNames = currentTestName.length > 0
  const hasHint = hint.length > 0
  return `Snapshot name: \`${hasNames ? escapeBacktickString(currentTestName) : ''}${
    hasNames && hasHint ? ': ' : ''
  }${hasHint ? BOLD_WEIGHT(escapeBacktickString(hint)) : ''} ${count}\``
}

function hintOf(info: SnapshotMessageInfo, updatable: boolean): string {
  const properties = typeof info.properties === 'object'
  const secondArgument = info.hint.length > 0 ? 'hint' : info.isInline ? 'snapshot' : undefined
  return matcherHint(
    info.matcherName,
    undefined,
    properties ? 'properties' : (secondArgument ?? ''),
    {
      ...(properties && secondArgument !== undefined ? { secondArgument } : {}),
      ...(updatable ? { receivedColor: RECEIVED_COLOR.bold } : {}),
    },
  )
}

// provino: Jest's `printSnapshotAndReceived` and `printPropertiesAndReceived` (printSnapshot.ts)
// are not vendored. A snapshot's diff is `jest-diff`'s, labelled `Snapshot` and `Received` as
// theirs is, without their colouring of the changed parts; properties use `printDiffOrStringify`.
// DIVERGENCES lists it; the corpus compares `.snap` bytes and exit codes, not this text.
const messages: SnapshotMessages = {
  mismatch(info): string {
    const difference =
      diff(info.expected ?? '', info.actual, {
        aAnnotation: 'Snapshot',
        bAnnotation: 'Received',
        expand: info.expand,
      }) ?? ''
    return `${hintOf(info, true)}\n\n${snapshotName(info)}\n\n${difference}`
  },
  notWritten(info): string {
    const received = `Received:${info.actual.includes('\n') ? '\n' : ' '}${RECEIVED_COLOR.bold(info.actual)}`
    return `${hintOf(info, true)}\n\n${snapshotName(info)}\n\n${NOT_WRITTEN}\n\n${received}`
  },
  propertiesMismatch(info): string {
    const difference = printDiffOrStringify(
      info.properties,
      info.received,
      'Expected properties',
      'Received value',
      info.expand,
    )
    return `${hintOf(info, false)}\n\n${snapshotName(info)}\n\n${difference}`
  },
}

const printer: SnapshotPrinter = {
  serialize(value, options): string {
    return format(value, {
      ...SERIALIZE_DEFAULTS,
      plugins: [...options.plugins, ...BUILT_IN] as OptionsReceived['plugins'],
      ...options.format,
    } as OptionsReceived)
  },
  messages,
}

/**
 * The Jest dialect's snapshot printer: what `jestPolicy.snapshot.printer` loads. The worker builds
 * it once.
 * @public
 */
export function jestSnapshotPrinter(): SnapshotPrinter {
  return printer
}
