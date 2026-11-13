jest.mock('@/utils/logger')

import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { labelledWithBrackets, withoutTheBrackets } from './src/utils/labels.ts'
import logger from './src/utils/logger.ts'
import type { NumberKind } from './src/utils/numbers.ts'
import {
  addNumbers,
  kindOfNumber,
  numberOne,
  numberThree,
  numberTwo,
  type NumberKind as SameKind,
} from './src/utils/numbers.ts'

describe('frames', () => {
  test('a throw in the body', () => {
    const kind: NumberKind = kindOfNumber(numberOne)
    void [spawn, crypto, fs, path, zlib, logger]
    throw new Error(`body ${labelledWithBrackets(kind)} ${addNumbers(numberOne, numberTwo)}`)
  })

  test('a rejection in a callback', async () => {
    const ids = ['a', 'b']
    let running = ids.length
    await new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        running--
        if (running === numberThree) resolve()
        else reject(new Error(`writer ${ids[running]} exited ${withoutTheBrackets('[1]')}`))
      }, 1)
    })
  })

  test('a failed assertion', () => {
    const kind: SameKind = kindOfNumber(numberTwo)
    expect(kind).toBe('small')
    expect(addNumbers(numberOne, numberTwo)).toBe(4)
  })

  test.each([
    [1, 2],
    [2, 3],
  ])('a failed row %i', (a: number, b: number) => {
    expect(addNumbers(a, numberOne)).toBe(b + numberTwo)
  })
})
