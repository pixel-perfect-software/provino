// The committed per-subject files: `corpus/<subject>/exclusions.json` and `flaky.json`. They hold
// test keys (a file relative to the repository, and a title path) and rule text, never a machine
// path, so they are public (`assertNoPathLeak` guards the writes).
import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ExclusionRule } from '../diff.ts'
import { HarnessError } from '../errors.ts'
import { parseExclusions, parseFlaky } from '../exclusions.ts'
import { readIfExists } from '../internal/guards.ts'
import { assertNoPathLeak } from '../internal/recording.ts'
import type { CorpusSubject } from './manifest.ts'
import { harnessPackageDir, repoRoot } from './paths.ts'

/**
 * `packages/harness/corpus/`: the manifest and each subject's committed files.
 * @public
 */
export function defaultCorpusDir(): string {
  return path.join(harnessPackageDir(), 'corpus')
}

/**
 * Where a subject's committed files are.
 * @public
 */
export function subjectFiles(
  subjectId: string,
  corpusDir: string = defaultCorpusDir(),
): { readonly dir: string; readonly exclusions: string; readonly flaky: string } {
  const dir = path.join(corpusDir, subjectId)
  return { dir, exclusions: path.join(dir, 'exclusions.json'), flaky: path.join(dir, 'flaky.json') }
}

/**
 * A subject's exclusion rules, under R2's limits (no calibration: corpus runs never lift them,
 * DECISIONS D30), or none when the subject has no `exclusions.json`.
 * @public
 */
export async function readSubjectExclusions(
  subjectId: string,
  today: string,
  corpusDir?: string,
): Promise<ExclusionRule[]> {
  const file = subjectFiles(subjectId, corpusDir).exclusions
  const text = await readIfExists(file)
  return text === undefined ? [] : parseExclusions(text, file, { today })
}

/**
 * A subject's flaky keys, or `undefined` when `flaky.json` has not been generated.
 * @public
 */
export async function readSubjectFlaky(
  subjectId: string,
  corpusDir?: string,
): Promise<string[] | undefined> {
  const file = subjectFiles(subjectId, corpusDir).flaky
  const text = await readIfExists(file)
  return text === undefined ? undefined : parseFlaky(text, file)
}

/**
 * What a comparison under a subject's own rules needs: its exclusion rules (under R2's limits,
 * as of `today`) and its flaky keys. A subject with no `flaky.json` is an error, not an empty
 * list, or flaky tests would read as differences and the list's absence would go unnoticed.
 * @public
 */
export async function readSubjectInputs(
  subject: Pick<CorpusSubject, 'id'>,
  today: string,
  corpusDir?: string,
): Promise<{ readonly exclusions: ExclusionRule[]; readonly flaky: string[] }> {
  const flaky = await readSubjectFlaky(subject.id, corpusDir)
  if (flaky === undefined) {
    throw new HarnessError(
      'HARNESS_CORPUS_GATE_INPUT',
      `${subject.id}: no flaky.json; run "corpus flaky ${subject.id}" first`,
    )
  }
  return { exclusions: await readSubjectExclusions(subject.id, today, corpusDir), flaky }
}

/**
 * Writes a subject's `flaky.json` (`{ "keys": [...] }`, sorted, 2-space JSON). Refuses text that
 * holds this machine's paths.
 * @public
 */
export async function writeSubjectFlaky(
  subjectId: string,
  keys: readonly string[],
  options: { readonly workRoot: string; readonly corpusDir?: string },
): Promise<string> {
  const files = subjectFiles(subjectId, options.corpusDir)
  const text = `${JSON.stringify({ keys: [...keys] }, null, 2)}\n`
  assertNoPathLeak(text, [options.workRoot, repoRoot(), os.homedir()], files.flaky)
  await mkdir(files.dir, { recursive: true })
  await writeFile(files.flaky, text)
  return files.flaky
}
