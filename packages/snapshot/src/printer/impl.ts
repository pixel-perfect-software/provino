import type {
  SnapshotMessageInfo,
  SnapshotMessages,
  SnapshotPrinter,
  SnapshotSerializeOptions,
} from '@provino/types'
import mockSerializer from '../vendor/jest-snapshot/mock-serializer.ts'
import {
  format,
  type OptionsReceived,
  type Plugin,
  plugins,
} from '../vendor/pretty-format/index.ts'

const {
  DOMCollection,
  DOMElement,
  Immutable,
  ReactElement,
  ReactTestComponent,
  AsymmetricMatcher,
} = plugins

/** The key a mock engine reads `mockName(name)`'s name under (`MOCK_EXPLICIT_NAME` in `@provino/mock`). */
const EXPLICIT_NAME = Symbol.for('@provino/mock.explicit-name')

/** The mock function Jest's serializer reads: its name and its calls. */
interface MockView {
  getMockName(): string
  readonly mock: unknown
  readonly [EXPLICIT_NAME]?: () => string | null
}

/**
 * The mock serializer for a native mock. Jest prints `[MockFunction]` for a mock nothing named and
 * `[MockFunction name]` for one `mockName` named, and Jest's own default name is the one its
 * serializer leaves out. A native mock's default (`fn()`, or a spy's method name) is another string,
 * so a mock that says nothing named it is shown to Jest's serializer under Jest's default. A mock
 * with no such answer (one a project brings) goes through as it is.
 */
const nativeMockSerializer: Plugin = {
  test: mockSerializer.test,
  serialize(val, config, indentation, depth, refs, printer): string {
    const mock = val as MockView
    const named = mock[EXPLICIT_NAME]?.()
    const shown: unknown =
      named === null ? { getMockName: () => 'jest.fn()', mock: mock.mock } : val
    return mockSerializer.serialize(shown, config, indentation, depth, refs, printer)
  },
} as Plugin

/**
 * The built-in plugins, in Jest's order (jest-snapshot `plugins.ts` L9-L22). A serializer added by
 * a project or a test goes in front of them.
 */
const BUILT_IN: readonly Plugin[] = [
  ReactTestComponent,
  ReactElement,
  DOMElement,
  DOMCollection,
  Immutable,
  nativeMockSerializer,
  AsymmetricMatcher,
]

/** `escapeRegex`, `indent` and `printFunctionName` as Jest's `serialize` (`utils.ts` L56-L72) sets them. */
const SERIALIZE_DEFAULTS = { escapeRegex: true, indent: 2, printFunctionName: false } as const

const NOT_WRITTEN =
  'New snapshot was not written. The update flag must be explicitly passed to write a new snapshot.\n\n' +
  'This is likely because this test is run in a continuous integration (CI) environment in which snapshots are not written by default.'

const escapeBacktickString = (text: string): string => text.replaceAll(/`|\\|\${/g, '\\$&')

function snapshotName(info: SnapshotMessageInfo): string {
  const { currentTestName, hint, count } = info
  const hasNames = currentTestName.length > 0
  const hasHint = hint.length > 0
  return `Snapshot name: \`${hasNames ? escapeBacktickString(currentTestName) : ''}${
    hasNames && hasHint ? ': ' : ''
  }${hasHint ? escapeBacktickString(hint) : ''} ${count}\``
}

function matcherCall(info: SnapshotMessageInfo, withProperties: boolean): string {
  const args: string[] = []
  if (withProperties) args.push('properties')
  if (info.hint.length > 0) args.push('hint')
  else if (info.isInline) args.push('snapshot')
  return `expect(received).${info.matcherName}(${args.join(', ')})`
}

const messages: SnapshotMessages = {
  mismatch(info): string {
    const expected = info.expected ?? ''
    return `${matcherCall(info, typeof info.properties === 'object')}\n\n${snapshotName(info)}\n\nSnapshot:\n${expected}\n\nReceived:\n${info.actual}`
  },
  notWritten(info): string {
    const separator = info.actual.includes('\n') ? '\n' : ' '
    return `${matcherCall(info, false)}\n\n${snapshotName(info)}\n\n${NOT_WRITTEN}\n\nReceived:${separator}${info.actual}`
  },
  propertiesMismatch(info): string {
    return `${matcherCall(info, true)}\n\n${snapshotName(info)}\n\nThe received object does not match the property matchers.`
  },
  noInlineFrame: (): Error => new Error("Couldn't infer stack frame for inline snapshot."),
}

const printer: SnapshotPrinter = {
  serialize(value: unknown, options: SnapshotSerializeOptions): string {
    return format(value, {
      ...SERIALIZE_DEFAULTS,
      plugins: [...options.plugins, ...BUILT_IN] as OptionsReceived['plugins'],
      ...options.format,
    } as OptionsReceived)
  },
  messages,
}

/**
 * The native snapshot printer: Jest 30.5.2's plugin order and `serialize` defaults over the
 * vendored pretty-format, with Provino's own failure messages.
 * @public
 */
export function nativeSnapshotPrinter(): SnapshotPrinter {
  return printer
}
