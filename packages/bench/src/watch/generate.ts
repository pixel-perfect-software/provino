// The tree `bench:watch` saves into, rebuilt from Track 9 Spikes B: about 5,000 TypeScript files in
// 600 directories, a tenth of them tests, each test importing a chain of modules (so one save
// reaches one test, as a leaf edit in a real project reaches the tests above it). Seeded and pure:
// the same options give the same files, byte for byte. The files are plain CommonJS that is also
// valid TypeScript, so Jest runs them with no transform and `provino jest` strips them as it would
// any `.ts`. D13: nothing here is committed; the bench writes the tree into `$TMPDIR`.
import { posix } from 'node:path'
import { randomBelow, seededRandom } from '../internal/prng.ts'

/** What `generateWatchTree` takes. */
export interface WatchTreeOptions {
  /** Files in all, tests included (default 5,000). */
  readonly files: number
  /** The seed of the directory placement and of every module's constant (default 1). */
  readonly seed: number
}

/** The defaults: Spikes B's tree. */
export const DEFAULT_WATCH_TREE: WatchTreeOptions = { files: 5_000, seed: 1 }

/** The directories of the full tree. */
export const WATCH_DIRECTORIES = 600

/** One generated tree. */
export interface WatchTree {
  /** Path relative to the root, with `/` separators, to the file's text. */
  readonly files: ReadonlyMap<string, string>
  readonly tests: number
  readonly directories: number
  /** Modules under each test. */
  readonly chainLength: number
  /** The module the bench saves: the last of the first chain. */
  readonly leaf: string
  /** The one test that imports it, through the chain. */
  readonly leafTest: string
  /** The leaf's text for save number `save` (0 is the committed text): the same value, a new comment. */
  readonly leafText: (save: number) => string
}

const pad = (value: number, width: number): string => String(value).padStart(width, '0')

/** Fisher-Yates over 0..count-1, driven by `random`. */
function permutation(count: number, random: () => number): number[] {
  const order = Array.from({ length: count }, (_, index) => index)
  for (let index = count - 1; index > 0; index--) {
    const other = randomBelow(random, index + 1)
    const held = order[index] as number
    order[index] = order[other] as number
    order[other] = held
  }
  return order
}

function requirePath(from: string, to: string): string {
  const relative = posix.relative(posix.dirname(from), to).replace(/\.ts$/, '')
  return relative.startsWith('.') ? relative : `./${relative}`
}

/**
 * The tree: `tests` = a tenth of `files` (at least 1), each over a chain of the rest divided evenly
 * (at least 1 module), spread over `min(600, ceil(files × 0.12))` directories by a seeded
 * permutation, so every directory holds files. A `files` count the chains don't divide leaves the
 * remainder out: the count it holds is `tests × (chainLength + 1)`.
 */
export function generateWatchTree(options: Partial<WatchTreeOptions> = {}): WatchTree {
  const { files: wanted, seed } = { ...DEFAULT_WATCH_TREE, ...options }
  if (!Number.isSafeInteger(wanted) || wanted < 2) {
    throw new RangeError(`a watch tree needs at least 2 files, got ${wanted}`)
  }
  const tests = Math.max(1, Math.round(wanted / 10))
  const chainLength = Math.max(1, Math.floor((wanted - tests) / tests))
  const total = tests * (chainLength + 1)
  const directories = Math.min(WATCH_DIRECTORIES, Math.ceil(wanted * 0.12), total)
  const random = seededRandom(seed)
  const place = permutation(total, random)
  const width = String(directories - 1).length
  let next = 0
  const dirOf = (): string => `d${pad((place[next++] as number) % directories, width)}`

  const files = new Map<string, string>()
  const idWidth = String(tests - 1).length
  let leaf = ''
  let leafTest = ''
  let leafConst = 0
  for (let chain = 0; chain < tests; chain++) {
    const id = pad(chain, idWidth)
    const modules = Array.from(
      { length: chainLength },
      (_, depth) => `${dirOf()}/m${id}_${depth}.ts`,
    )
    const testPath = `${dirOf()}/t${id}.test.ts`
    const constants = modules.map(() => 1 + randomBelow(random, 9))
    let expected = 0
    for (const [depth, path] of modules.entries()) {
      const own = constants[depth] as number
      expected += own
      const below = modules[depth + 1]
      const body =
        below === undefined ? `${own}` : `${own} + require('${requirePath(path, below)}').value`
      files.set(path, `exports.value = ${body}\n`)
    }
    const head = modules[0] as string
    files.set(
      testPath,
      `const head = require('${requirePath(testPath, head)}')\n\ntest('chain ${id} sums its modules', () => {\n  expect(head.value).toBe(${expected})\n})\n`,
    )
    if (chain === 0) {
      leaf = modules[chainLength - 1] as string
      leafTest = testPath
      leafConst = constants[chainLength - 1] as number
    }
  }
  const leafText = (save: number): string =>
    `exports.value = ${leafConst}\n${save === 0 ? '' : `// save ${save}\n`}`
  return { files, tests, directories, chainLength, leaf, leafTest, leafText }
}
