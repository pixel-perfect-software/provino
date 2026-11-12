// `provino-harness corpus <action>` (B16): pin, fetch, install, probe, run, flaky, self-diff, gate
// and clean, over the repositories a selection names. `probe`, `run` and `install --offline` run
// third-party code and belong in Tyler's own terminal (DECISIONS D40); the rest an agent may run.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { NormalizedRun } from '@provino/types'
import { type CorpusDeps, defaultDeps } from '../corpus/deps.ts'
import { fetchRepo } from '../corpus/fetch.ts'
import {
  defaultCorpusDir,
  readSubjectExclusions,
  readSubjectFlaky,
  writeSubjectFlaky,
} from '../corpus/files.ts'
import { flakyKeys } from '../corpus/flaky.ts'
import { buildGateReport, formatGateReport, type GateSubject, gateSubject } from '../corpus/gate.ts'
import { installRepo, readInstallRecord, reinstallOffline } from '../corpus/install.ts'
import {
  type CorpusManifest,
  type CorpusRepo,
  defaultManifestPath,
  readCorpusManifest,
  selectRepos,
} from '../corpus/manifest.ts'
import { corpusWorkRoot, repoPaths } from '../corpus/paths.ts'
import { pinManifest } from '../corpus/pin.ts'
import {
  hasRun,
  listRuns,
  type RunMeta,
  readRunMeta,
  runFile,
  runReference,
} from '../corpus/run.ts'
import { type ProbeVerdict, runProbe } from '../corpus/sandbox.ts'
import { selfDiff } from '../corpus/self-diff.ts'
import { HarnessError } from '../errors.ts'
import type { CorpusCommand } from '../internal/cli-args.ts'
import { rules } from '../normalize.ts'
import { parseNormalizedRun } from '../parse-normalized-run.ts'
import { type CommandIo, failureText } from './io.ts'

/**
 * What a corpus command runs against; tests replace the machine-facing parts.
 * @internal
 */
export interface CorpusEnvironment {
  readonly workRoot: string
  readonly manifestPath: string
  readonly corpusDir: string
  readonly deps: CorpusDeps
  readonly probe: (workRoot: string) => Promise<ProbeVerdict>
  readonly runReference: typeof runReference
  readonly now: () => Date
}

function defaultEnvironment(): CorpusEnvironment {
  const workRoot = corpusWorkRoot()
  return {
    workRoot,
    manifestPath: defaultManifestPath(),
    corpusDir: defaultCorpusDir(),
    deps: defaultDeps,
    probe: (root) => runProbe({ workRoot: root }),
    runReference,
    now: () => new Date(),
  }
}

/** Runs `step` for each repository; a `HarnessError` is that repository's failure, the others go on. */
async function each(
  repos: readonly CorpusRepo[],
  io: CommandIo,
  step: (repo: CorpusRepo) => Promise<string>,
): Promise<number> {
  let failures = 0
  for (const repo of repos) {
    try {
      io.out(`${await step(repo)}\n`)
    } catch (error) {
      if (!(error instanceof HarnessError)) throw error
      failures++
      io.out(`FAIL ${repo.id}\n`)
      io.err(`${failureText(error)}\n`)
    }
  }
  return failures === 0 ? 0 : 1
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`
}

async function pin(command: CorpusCommand, io: CommandIo, env: CorpusEnvironment): Promise<number> {
  const text = await readFile(env.manifestPath, 'utf8')
  const result = await pinManifest(text, env.manifestPath, {
    selection: command.selection,
    workRoot: env.workRoot,
    deps: env.deps,
    onChange: (change) =>
      io.out(`${change.outcome === 'new' ? 'pinned' : 'same  '} ${change.id}\n`),
  })
  for (const failure of result.failures) {
    io.out(`FAIL ${failure.id}\n`)
    io.err(`${failureText(failure.error)}\n`)
  }
  if (result.failures.length > 0) {
    io.err('the manifest was not written: a stopped repository is reported, never re-pinned\n')
    return 1
  }
  if (result.text !== text) await writeFile(env.manifestPath, result.text)
  io.out(`${result.changes.length} repositories pinned\n`)
  return 0
}

async function fetchAll(
  command: CorpusCommand,
  repos: readonly CorpusRepo[],
  io: CommandIo,
  env: CorpusEnvironment,
): Promise<number> {
  let verified = 0
  const code = await each(repos, io, async (repo) => {
    const result = await fetchRepo(repo, {
      workRoot: env.workRoot,
      verifyOnly: command.verifyOnly,
      deps: env.deps,
    })
    if (result.problems.length > 0) {
      throw new HarnessError(
        'HARNESS_CORPUS_VERIFY_FAILED',
        `${repo.id}: ${result.problems.join('; ')}`,
      )
    }
    verified++
    return `ok   ${repo.id} ${result.sha256.slice(0, 12)} ${result.downloaded ? 'downloaded' : 'cached'}, ${result.entries} entries${result.src === undefined ? '' : ', extracted'}${result.leftOut.length === 0 || result.src === undefined ? '' : ` (left out: ${result.leftOut.length} editor and environment files)`}`
  })
  io.out(
    `${verified} of ${repos.length} tarballs verified (sha256, lockfile, runner config, licence)\n`,
  )
  return code
}

async function install(
  command: CorpusCommand,
  repos: readonly CorpusRepo[],
  io: CommandIo,
  env: CorpusEnvironment,
): Promise<number> {
  if (command.offline) {
    await requireProbe(io, env)
    return each(repos, io, async (repo) => {
      const outcome = await reinstallOffline(repo, { workRoot: env.workRoot, deps: env.deps })
      return `ok   ${repo.id} offline re-install gave the same tree (${seconds(outcome.wallMs)}, local)`
    })
  }
  return each(repos, io, async (repo) => {
    const record = await installRepo(repo, {
      workRoot: env.workRoot,
      deps: env.deps,
      inherited: process.env,
    })
    return `ok   ${repo.id} ${record.packageManager.name}@${record.packageManager.version}, ${seconds(record.wallMs)} (local), ${record.fingerprintFiles} files under node_modules, ${record.diskMb ?? '?'} MB under ${repoPaths(env.workRoot, repo).dir}`
  })
}

/** Probes the sandbox and prints the verdict; a leak throws and ends the command. */
async function requireProbe(io: CommandIo, env: CorpusEnvironment): Promise<void> {
  const verdict = await env.probe(env.workRoot)
  for (const line of verdict.lines) io.out(`  ${line}\n`)
}

async function run(
  command: CorpusCommand,
  repos: readonly CorpusRepo[],
  io: CommandIo,
  env: CorpusEnvironment,
): Promise<number> {
  let failures = 0
  for (const repo of repos) {
    // Fail closed, before every repository: a profile that leaks stops the whole command.
    io.out(`probe before ${repo.id}\n`)
    await requireProbe(io, env)
    const paths = repoPaths(env.workRoot, repo)
    const record = await readInstallRecord(repo, env.workRoot)
    if (record === undefined) {
      io.err(`${repo.id}: not installed at ${repo.sha.slice(0, 12)} (no install record for this commit); run "corpus install ${repo.id}" first\n`)
      failures++
      continue
    }
    if (record.offline?.ok !== true)
      io.out(`note ${repo.id}: the offline re-install has not been verified\n`)
    for (const subject of repo.subjects) {
      for (let n = 1; n <= command.runs; n++) {
        if (!command.force && (await hasRun(paths, subject.id, n))) {
          io.out(`have ${subject.id} #${n}\n`)
          continue
        }
        try {
          const meta = await env.runReference(repo, subject, n, {
            workRoot: env.workRoot,
            deps: env.deps,
            keepTree: command.keepTree,
          })
          const statuses = Object.entries(meta.statuses)
            .map(([s, c]) => `${s} ${c}`)
            .join(', ')
          io.out(
            `ran  ${subject.id} #${n}: ${meta.tests} tests (${statuses}), run ${seconds(meta.runMs)}, prepare ${seconds(meta.prepareMs)}, sidecar ${meta.sidecar.missing.length === 0 ? 'ok' : `MISSING ${meta.sidecar.missing.length}`} (local)\n`,
          )
        } catch (error) {
          if (!(error instanceof HarnessError)) throw error
          failures++
          io.out(`FAIL ${subject.id} #${n}\n`)
          io.err(`${failureText(error)}\n`)
          break
        }
      }
    }
  }
  return failures === 0 ? 0 : 1
}

/** A subject's finished runs, parsed, in order. */
async function loadRuns(
  repo: CorpusRepo,
  subjectId: string,
  env: CorpusEnvironment,
): Promise<{ runs: NormalizedRun[]; metas: RunMeta[] }> {
  const paths = repoPaths(env.workRoot, repo)
  const runs: NormalizedRun[] = []
  const metas: RunMeta[] = []
  for (const n of await listRuns(paths, subjectId)) {
    const file = runFile(paths, subjectId, n)
    runs.push(parseNormalizedRun(await readFile(file, 'utf8'), file))
    const meta = await readRunMeta(paths, subjectId, n)
    if (meta !== undefined) metas.push(meta)
  }
  return { runs, metas }
}

async function flaky(
  repos: readonly CorpusRepo[],
  io: CommandIo,
  env: CorpusEnvironment,
): Promise<number> {
  return each(repos, io, async (repo) => {
    const lines: string[] = []
    for (const subject of repo.subjects) {
      const { runs } = await loadRuns(repo, subject.id, env)
      if (runs.length < 2) {
        throw new HarnessError(
          'HARNESS_CORPUS_GATE_INPUT',
          `${subject.id}: ${runs.length} runs on disk, 2 or more needed`,
        )
      }
      const keys = flakyKeys(runs)
      await writeSubjectFlaky(subject.id, keys, {
        workRoot: env.workRoot,
        corpusDir: env.corpusDir,
      })
      lines.push(
        `${subject.id}: ${keys.length} flaky of ${runs[0]?.files.reduce((n, f) => n + f.tests.length, 0) ?? 0} tests`,
      )
    }
    return `ok   ${lines.join('; ')}`
  })
}

/** What the self-diff and the gate read for one subject. */
async function subjectInput(
  repo: CorpusRepo,
  subjectId: string,
  today: string,
  env: CorpusEnvironment,
) {
  const subject = repo.subjects.find((candidate) => candidate.id === subjectId)
  if (subject === undefined) throw new Error(`no subject ${subjectId}`)
  const { runs, metas } = await loadRuns(repo, subjectId, env)
  const flakyList = await readSubjectFlaky(subjectId, env.corpusDir)
  if (flakyList === undefined) {
    throw new HarnessError(
      'HARNESS_CORPUS_GATE_INPUT',
      `${subjectId}: no flaky.json; run "corpus flaky ${repo.id}" first`,
    )
  }
  const exclusions = await readSubjectExclusions(subjectId, today, env.corpusDir)
  const diff = selfDiff(runs, { exclusions, flaky: flakyList, today })
  if (diff.pairs.length === 0) {
    throw new HarnessError(
      'HARNESS_CORPUS_GATE_INPUT',
      `${subjectId}: ${runs.length} runs on disk, 2 or more needed`,
    )
  }
  return { repo, subject, metas, selfDiff: diff, flaky: flakyList, exclusions }
}

async function selfDiffAll(
  command: CorpusCommand,
  repos: readonly CorpusRepo[],
  io: CommandIo,
  env: CorpusEnvironment,
): Promise<number> {
  const today = command.today ?? env.now().toISOString().slice(0, 10)
  return each(repos, io, async (repo) => {
    const lines: string[] = []
    let failed = false
    for (const subject of repo.subjects) {
      const input = await subjectInput(repo, subject.id, today, env)
      for (const pair of input.selfDiff.pairs) {
        const { report } = pair
        failed ||= !pair.pass
        lines.push(
          `${subject.id} ${pair.pair.join('-')}: status ${report.counts.statusMatched}/${report.counts.comparedTests}, message ${report.counts.messageMatched}/${report.counts.failedInBoth}, snapshot ${report.counts.snapshotMatched}/${report.counts.snapshotFiles}, suite ${report.suitePass ? 'pass' : 'FAIL'}, unexplained diffs ${report.diffs.length}, flaky ${report.counts.flaky}${pair.pass ? '' : ` FAIL: ${pair.reasons.join('; ')}`}`,
        )
      }
    }
    if (failed) throw new HarnessError('HARNESS_CORPUS_GATE_INPUT', lines.join('\n'))
    return `ok   ${lines.join('\n     ')}`
  })
}

async function gate(
  command: CorpusCommand,
  repos: readonly CorpusRepo[],
  io: CommandIo,
  env: CorpusEnvironment,
): Promise<number> {
  const today = command.today ?? env.now().toISOString().slice(0, 10)
  const rows: GateSubject[] = []
  for (const repo of repos) {
    const install = await readInstallRecord(repo, env.workRoot)
    for (const subject of repo.subjects) {
      rows.push(gateSubject({ ...(await subjectInput(repo, subject.id, today, env)), install }))
    }
  }
  const report = buildGateReport(rows, { today, normalizationRules: rules.map((rule) => rule.id) })
  const out = command.out ?? path.join(env.workRoot, 'gate', 'g0.json')
  await mkdir(path.dirname(path.resolve(out)), { recursive: true })
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`)
  io.out(formatGateReport(report))
  io.err(`the JSON report is at ${out}\n`)
  return report.pass ? 0 : 1
}

async function clean(
  command: CorpusCommand,
  repos: readonly CorpusRepo[],
  io: CommandIo,
  env: CorpusEnvironment,
): Promise<number> {
  return each(repos, io, async (repo) => {
    const paths = repoPaths(env.workRoot, repo)
    // `fs.rm` inside the harness: the agent sandbox denies `rm -rf` (B16 gap 9).
    const targets = command.everything
      ? [paths.dir]
      : [paths.src, paths.srcMarker, paths.runs, paths.installRecord]
    for (const target of targets) await rm(target, { recursive: true, force: true })
    return `ok   ${repo.id} cleaned${command.everything ? ' (tarball and caches too)' : ''}`
  })
}

/**
 * Runs `corpus <action>`. Exit 0 when every repository passed, 1 when any failed or the manifest
 * or a probe refused, 2 is the argument parser's. A sandbox leak ends the command with 1 before
 * anything runs.
 * @internal
 */
export async function corpusCommand(
  command: CorpusCommand,
  io: CommandIo,
  overrides: Partial<CorpusEnvironment> = {},
): Promise<number> {
  const env = { ...defaultEnvironment(), ...overrides }
  try {
    if (command.action === 'probe') {
      await requireProbe(io, env)
      io.out('the sandbox holds\n')
      return 0
    }
    if (command.action === 'pin') return await pin(command, io, env)
    const manifest: CorpusManifest = await readCorpusManifest(env.manifestPath)
    const repos = selectRepos(manifest, command.selection)
    switch (command.action) {
      case 'fetch':
        return await fetchAll(command, repos, io, env)
      case 'install':
        return await install(command, repos, io, env)
      case 'run':
        return await run(command, repos, io, env)
      case 'flaky':
        return await flaky(repos, io, env)
      case 'self-diff':
        return await selfDiffAll(command, repos, io, env)
      case 'gate':
        return await gate(command, repos, io, env)
      case 'clean':
        return await clean(command, repos, io, env)
      default: {
        const unexpected: never = command.action
        throw new Error(`unhandled corpus action ${String(unexpected)}`)
      }
    }
  } catch (error) {
    if (!(error instanceof HarnessError)) throw error
    io.err(`${failureText(error)}\n`)
    return error.code === 'HARNESS_USAGE' ? 2 : 1
  }
}
