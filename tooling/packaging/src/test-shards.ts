// CI runs the workspace's tests as two shards per Node version (the `test` job in ci.yml). `provino`
// (the end-to-end tests through the bin) is more than half the workspace's test time, so no whole-
// package split can balance it: it runs in both shards, each taking half its files through Node's
// own `--test-shard=<n>/2`, which `packages/provino`'s test script reaches through `node-test.ts` and the
// `PROVINO_TEST_SHARD` variable (Node ignores the flag after the script's globs). Shard 1 also names the other packages it runs; shard 2 is every
// remaining package, so a new package lands in shard 2 without an edit. `check` proves that, from
// Turborepo's own dry run: each package with a `test` script is in exactly one shard (a split
// package in every shard), and a name listed here that no longer exists fails rather than shrinking
// shard 1 unnoticed.
//
//   node tooling/packaging/src/test-shards.ts check
//   node tooling/packaging/src/test-shards.ts run <1|2> [turbo run flags…]
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSync } from 'oxc-parser'
import {
  bootstrapFiles,
  CANARY,
  INCLUDE_GLOBS,
  isIncludedTestFile,
  migratedDirs,
  PACKAGE_CONFIG,
  TEST_ROOTS,
  testScript,
} from './dogfood.ts'
import { ROOT, readWorkspacePackages } from './workspace.ts'

/**
 * Packages whose test files are split across the shards: each shard runs them with
 * `PROVINO_TEST_SHARD=<n>/SHARD_COUNT`, and their test script must run through `node-test.ts`.
 * @internal
 */
export const SPLIT_PACKAGES: readonly string[] = ['provino']

/**
 * The whole packages shard 1 runs besides its half of the split ones. Every other package is in
 * shard 2.
 * @internal
 */
export const SHARD_ONE: readonly string[] = [
  '@provino/dialect-jest',
  '@provino/orchestrator',
  '@provino/bench',
  '@provino/snapshot',
  '@provino/config',
  '@provino/policy',
  '@provino/env-node',
]

/** @internal */
export const SHARD_COUNT = 2

/**
 * What one shard's Turborepo run takes: the filters that select its packages and the environment
 * that gives each split package its half of the files (1-based). `check`'s dry run and `run` both
 * read it, so they can't drift apart.
 * @internal
 */
export function shardInvocation(shard: number): {
  readonly filters: readonly string[]
  readonly env: Readonly<Record<string, string>>
} {
  if (!Number.isInteger(shard) || shard < 1 || shard > SHARD_COUNT) {
    throw new RangeError(`there are ${SHARD_COUNT} test shards; got ${shard}`)
  }
  const filters =
    shard === 1
      ? [...SPLIT_PACKAGES, ...SHARD_ONE].map((name) => `--filter=${name}`)
      : SHARD_ONE.map((name) => `--filter=!${name}`)
  return { filters, env: { PROVINO_TEST_SHARD: `${shard}/${SHARD_COUNT}` } }
}

/**
 * What is wrong with the shards, given the packages that have a `test` script and the packages
 * each shard would run.
 * @internal
 */
export function shardProblems(
  testPackages: readonly string[],
  ran: readonly (readonly string[])[],
): readonly string[] {
  const problems: string[] = []
  for (const name of [...SHARD_ONE, ...SPLIT_PACKAGES]) {
    if (!testPackages.includes(name)) {
      problems.push(`test-shards.ts names ${name}, which is not a package with a test script`)
    }
  }
  for (const name of testPackages) {
    const shards = ran.flatMap((names, index) => (names.includes(name) ? [index + 1] : []))
    if (SPLIT_PACKAGES.includes(name)) {
      if (shards.length !== ran.length) {
        problems.push(
          `${name} is split and must be in every shard; it is in ${shards.join(' and ') || 'none'}`,
        )
      }
    } else if (shards.length === 0) problems.push(`${name} has tests and is in no shard`)
    else if (shards.length > 1) problems.push(`${name} is in shards ${shards.join(' and ')}`)
  }
  for (const [index, names] of ran.entries()) {
    for (const name of names) {
      if (!testPackages.includes(name)) {
        problems.push(`shard ${index + 1} ran ${name}, which is not a package with a test script`)
      }
    }
  }
  return problems
}

/**
 * One package that runs on Provino (it has a `provino.config.ts`), as `check` sees it.
 * @internal
 */
export interface MigratedPackage {
  readonly name: string
  /** Repo-relative directory: `packages/lazy`. */
  readonly dir: string
  /** What its `test` script says, and what `testScript` says it must (one string for every package). */
  readonly script: string
  readonly expectedScript: string
}

/**
 * What is wrong with the bootstrap set (`tooling/provino/bootstrap.json`) and the migrated packages'
 * scripts. A migrated package's script is the runner, then `node --test` over exactly its bootstrap
 * files, so each test file runs on exactly one runner: the shared config excludes the set from
 * Provino's `include`, and the script runs the set on node:test. The set must hold the canary, and
 * every entry must exist and, if it is in a migrated package, be named by that script.
 * @internal
 */
export function bootstrapProblems(
  bootstrap: readonly string[],
  packages: readonly MigratedPackage[],
  exists: (file: string) => boolean,
  /** The directories with a `provino.config.ts` (`migratedDirs`): each must be one of `packages`. */
  dirs: readonly string[],
): readonly string[] {
  const problems: string[] = []
  // A guard that finds nothing to guard must fail: a malformed manifest would otherwise drop a
  // package from the script and glob checks without a word.
  if (dirs.length === 0) problems.push(`no migrated package (a ${PACKAGE_CONFIG}) was found`)
  for (const dir of dirs) {
    if (!packages.some((pkg) => pkg.dir === dir)) {
      problems.push(
        `${dir} has a ${PACKAGE_CONFIG} but is not a readable workspace package (its package.json?)`,
      )
    }
  }
  if (!bootstrap.includes(CANARY)) problems.push(`the bootstrap set must hold ${CANARY}`)
  for (const file of bootstrap) {
    if (!exists(file)) problems.push(`bootstrap file ${file} does not exist`)
    const owner = packages.find((pkg) => file.startsWith(`${pkg.dir}/`))
    // The canary is the one entry outside a migrated package, until `provino`'s own suite migrates
    // (Phase 8): then its package owns it and the checks below apply.
    if (file === CANARY && owner === undefined) continue
    if (owner === undefined) {
      problems.push(
        `bootstrap file ${file} is not in a migrated package (one with a ${PACKAGE_CONFIG})`,
      )
    } else if (!isIncludedTestFile(file.slice(owner.dir.length + 1))) {
      problems.push(
        `bootstrap file ${file} is matched by none of ${owner.name}'s include globs (${INCLUDE_GLOBS.join(', ')})`,
      )
    }
  }
  for (const pkg of packages) {
    if (pkg.script !== pkg.expectedScript) {
      problems.push(
        `${pkg.name}'s test script is "${pkg.script}", expected "${pkg.expectedScript}": a file of the bootstrap set must run on node:test only, every other on Provino only`,
      )
    }
  }
  return problems
}

/** What a source file imports: the relative specifiers it loads, and whether it loads `node:test`. */
interface FileImports {
  readonly relative: readonly string[]
  readonly nodeTest: boolean
}

/**
 * The imports of one TypeScript file that load something at run time, read from its syntax tree (so
 * a string that holds `import … from 'node:test'` is no import): static imports and re-exports, and
 * `import()` with a literal. A type import or re-export, or one whose every specifier is `type`, is
 * erased and loads nothing.
 */
function importsOf(file: string, text: string): FileImports {
  const { module } = parseSync(file, text)
  const relative: string[] = []
  let nodeTest = false
  const note = (request: string): void => {
    if (request === 'node:test') nodeTest = true
    else if (request.startsWith('.')) relative.push(request)
  }
  for (const statement of module.staticImports) {
    if (statement.entries.length > 0 && statement.entries.every((entry) => entry.isType)) continue
    note(statement.moduleRequest.value)
  }
  for (const statement of module.staticExports) {
    for (const entry of statement.entries) {
      if (entry.moduleRequest !== null && !entry.isType) note(entry.moduleRequest.value)
    }
  }
  for (const call of module.dynamicImports) {
    const literal = /^(['"])(.*)\1$/s.exec(
      text.slice(call.moduleRequest.start, call.moduleRequest.end),
    )
    if (literal?.[2] !== undefined) note(literal[2])
  }
  return { relative, nodeTest }
}

/**
 * Files that load `node:test` and that a test file Provino runs reaches through relative imports
 * (static imports and re-exports, and `import()` with a literal, followed through every file under
 * `within`). A `node:test` hook or registration does nothing in a Provino worker: the file's `after`
 * is never called (a temp dir it was to remove stays), a `test` or `describe` it makes never runs.
 * A type import is fine, and so is a file only the bootstrap set imports (a node:test file may use
 * node:test). `tests` are the test files Provino runs (the include globs minus the bootstrap set);
 * `read` gives a file's text, or `undefined` when there is no such file.
 * @internal
 */
export function nodeTestImportProblems(
  tests: readonly string[],
  read: (file: string) => string | undefined,
  within: (file: string) => boolean,
): readonly string[] {
  /** Each file reached, and the test file it was first reached from. */
  const reachedFrom = new Map<string, string>()
  const problems: string[] = []
  for (const test of tests) {
    const queue = [test]
    while (queue.length > 0) {
      const file = queue.shift() as string
      if (reachedFrom.has(file)) continue
      reachedFrom.set(file, test)
      const text = read(file)
      if (text === undefined || !/\.[cm]?tsx?$/.test(file)) continue
      const imports = importsOf(file, text)
      if (imports.nodeTest) {
        problems.push(
          file === test
            ? `${file} is a test file Provino runs and imports node:test: rewrite it (pnpm migrate:node-test rewrite) or add it to the bootstrap set`
            : `${file} imports node:test, and ${test} (a test file Provino runs) imports it${reachedFrom.get(file) === test ? '' : ' (through another file)'}: node:test's hooks and tests never run in a Provino worker, so take the hook as a parameter (the caller passes \`after\` or \`afterAll\`), or register it from provino when only Provino tests import this file, or keep it out of the files a Provino test imports (a file only the bootstrap set imports may use node:test)`,
        )
      }
      for (const request of imports.relative) {
        const target = posix.normalize(posix.join(posix.dirname(file), request))
        const found = [target, `${target}.ts`, `${target}/index.ts`].find(
          (candidate) => within(candidate) && read(candidate) !== undefined,
        )
        if (found !== undefined) queue.push(found)
      }
    }
  }
  return problems.sort()
}

/** Every file under each migrated package's include roots can be read by this; the rest is not a source. */
function readSource(file: string): string | undefined {
  try {
    return readFileSync(join(ROOT, file), 'utf8')
  } catch {
    return undefined
  }
}

/** The test files Provino runs: every included `*.test.ts` of a migrated package but the bootstrap set. */
function provinoTestFiles(
  dirs: readonly string[],
  bootstrap: readonly string[],
): readonly string[] {
  return dirs.flatMap((dir) =>
    TEST_ROOTS.flatMap((root) => {
      if (!existsSync(join(ROOT, dir, root))) return []
      return readdirSync(join(ROOT, dir, root), { recursive: true, encoding: 'utf8' })
        .map((entry) => `${dir}/${root}/${entry.split('\\').join('/')}`)
        .filter(
          (file) =>
            !file.includes('/node_modules/') && isIncludedTestFile(file.slice(dir.length + 1)),
        )
        .filter((file) => !bootstrap.includes(file))
    }),
  )
}

/** The packages with a `provino.config.ts`, read from disk; the root config's projects are these. */
function migratedPackages(): readonly MigratedPackage[] {
  const dirs = migratedDirs(ROOT)
  return readWorkspacePackages()
    .filter((pkg) => dirs.includes(pkg.rel))
    .map((pkg) => ({
      name: pkg.manifest.name,
      dir: pkg.rel,
      script: pkg.manifest.scripts?.test ?? '',
      expectedScript: testScript(ROOT, pkg.rel),
    }))
}

/** The workspace packages (not the root) that have a `test` script. */
function packagesWithTests(): readonly string[] {
  return readWorkspacePackages()
    .filter((pkg) => pkg.rel !== '.' && pkg.manifest.scripts?.test !== undefined)
    .map((pkg) => pkg.manifest.name)
}

interface DryRun {
  readonly tasks: readonly { readonly task: string; readonly package: string }[]
}

/** The packages Turborepo would run `test` for under a shard's filters, from a dry run. */
function plannedPackages(shard: number): readonly string[] {
  const { filters, env } = shardInvocation(shard)
  const result = spawnSync('pnpm', ['exec', 'turbo', 'run', 'test', '--dry=json', ...filters], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.status !== 0) {
    throw new Error(`turbo's dry run for shard ${shard} failed:\n${result.stderr}`)
  }
  const plan = JSON.parse(result.stdout) as DryRun
  return plan.tasks.filter((task) => task.task === 'test').map((task) => task.package)
}

/** The split packages whose `test` script does not run through `node-test.ts`. */
function unshardableSplits(): readonly string[] {
  return readWorkspacePackages()
    .filter((pkg) => SPLIT_PACKAGES.includes(pkg.manifest.name))
    .filter((pkg) => !(pkg.manifest.scripts?.test ?? '').includes('/node-test.ts '))
    .map((pkg) => pkg.manifest.name)
}

function check(): number {
  const dirs = migratedDirs(ROOT)
  const bootstrap = bootstrapFiles(ROOT)
  const roots = dirs.flatMap((dir) => TEST_ROOTS.map((root) => `${dir}/${root}/`))
  const ran = Array.from({ length: SHARD_COUNT }, (_, index) => plannedPackages(index + 1))
  const problems = [
    ...shardProblems(packagesWithTests(), ran),
    ...bootstrapProblems(
      bootstrap,
      migratedPackages(),
      (file) => existsSync(join(ROOT, file)),
      dirs,
    ),
    ...nodeTestImportProblems(
      provinoTestFiles(dirs, bootstrap),
      readSource,
      (file) => roots.some((root) => file.startsWith(root)) && !file.includes('/node_modules/'),
    ),
    ...unshardableSplits().map(
      (name) => `${name} is split but its test script does not run through node-test.ts`,
    ),
  ]
  if (problems.length > 0) {
    for (const problem of problems) console.error(`test shards: ${problem}`)
    return 1
  }
  for (const [index, names] of ran.entries()) {
    console.log(`shard ${index + 1}/${SHARD_COUNT}: ${names.length} packages`)
  }
  return 0
}

/** One Turborepo run: the shard's packages, and the variable that halves the split ones. */
async function run(shard: number, flags: readonly string[]): Promise<number> {
  if (check() !== 0) return 1
  const { filters, env } = shardInvocation(shard)
  return new Promise((resolve) => {
    const child = spawn('pnpm', ['exec', 'turbo', 'run', 'test', ...flags, ...filters], {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, ...env, PROVINO_NODE: process.version },
    })
    child.on('error', () => resolve(1))
    child.on('close', (code) => resolve(code ?? 1))
  })
}

const entry = process.argv[1]
if (entry !== undefined && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  const [command, shardArg, ...flags] = process.argv.slice(2)
  if (command === 'check') {
    process.exitCode = check()
  } else if (command === 'run' && (shardArg === '1' || shardArg === '2')) {
    process.exitCode = await run(Number(shardArg), flags)
  } else {
    console.error('usage: test-shards.ts check | run <1|2> [turbo flags…]')
    process.exitCode = 2
  }
}
