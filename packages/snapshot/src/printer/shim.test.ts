import type { SnapshotMessageInfo } from '@provino/types'
import { describe, expect, it } from 'provino'
import { nativeSnapshotPrinter as implementation } from './impl.ts'
import { nativeSnapshotPrinter } from './index.ts'

// The shim loads `impl.ts` through `require(esm)` on first use and forwards to it.
describe('the printer shim', () => {
  it('serializes as the implementation does', () => {
    const value = { a: [1, 'two', new Map([['k', new Set([3])]])], b: 'line\n`tick`' }
    const options = { format: { escapeString: false, printBasicPrototype: false }, plugins: [] }
    expect(nativeSnapshotPrinter().serialize(value, options)).toBe(
      implementation().serialize(value, options),
    )
  })

  it("hands out the implementation's messages", () => {
    // The shim's `require` is Node's own, so its module instance can be another than this file's.
    const info: SnapshotMessageInfo = {
      matcherName: 'toMatchSnapshot',
      isInline: false,
      hint: '',
      currentTestName: 'a test',
      key: 'a test 1',
      count: 1,
      expand: false,
      expected: '"a"',
      actual: '"b"',
      received: 'b',
    }
    const { messages } = nativeSnapshotPrinter()
    expect(Object.keys(messages).sort()).toEqual(Object.keys(implementation().messages).sort())
    expect(messages.mismatch(info)).toBe(implementation().messages.mismatch(info))
  })

  it('is one printer for every call of the factory', () => {
    expect(nativeSnapshotPrinter()).toBe(nativeSnapshotPrinter())
  })
})
