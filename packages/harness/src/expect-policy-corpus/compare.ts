// How the policy corpus holds a run to a golden, and how a declared divergence is held to its
// pin (the style of `mock-corpus/declared.ts`): an undeclared difference fails, so does a declared
// one that now matches, and so does one that gives another observation than the one pinned. An
// allowance cannot go stale or widen.
import { isDeepStrictEqual } from 'node:util'
import type { ObservedTest, ObservedTests } from './observe.ts'

/** How much of a test the comparison reads. */
export type Mode =
  /** Status, every error's name, message, matcher and user frame, and the passing count. */
  | 'full'
  /** Status, and whether the test carries an error: the counting outcome, not the text. */
  | 'outcome'

/** A test reduced to what `mode` reads. */
export type Reading = ObservedTest | { readonly status: string; readonly hasErrors: boolean }

/** `test` as `mode` reads it. */
export function read(test: ObservedTest, mode: Mode): Reading {
  return mode === 'full' ? test : { status: test.status, hasErrors: test.errors.length > 0 }
}

/** A difference the corpus allows: what Provino gives, and why it is not the golden's. */
export interface Declared {
  /** Why Provino differs, in a sentence that names the policy or task behind it. */
  readonly reason: string
  /** Exactly what Provino gives for this test. */
  readonly ours: Reading
}

/** Where `got` and `want` disagree, by test key; a test only one side has reads as `undefined`. */
export function differences(
  want: ObservedTests,
  got: ObservedTests,
  mode: Mode,
): ReadonlyMap<string, { readonly want: Reading | undefined; readonly got: Reading | undefined }> {
  const found = new Map<string, { want: Reading | undefined; got: Reading | undefined }>()
  for (const key of new Set([...want.keys(), ...got.keys()])) {
    const expected = want.get(key)
    const actual = got.get(key)
    const left = expected === undefined ? undefined : read(expected, mode)
    const right = actual === undefined ? undefined : read(actual, mode)
    if (!isDeepStrictEqual(left, right)) found.set(key, { want: left, got: right })
  }
  return found
}

/**
 * The problems with a run once `declared` is taken into account. `label` prefixes the declared
 * keys (`fixture (profile)`); `seen` collects the declared keys that were looked up, so a test can
 * check that every entry was used.
 */
export function problems(
  label: string,
  found: ReturnType<typeof differences>,
  declared: Readonly<Record<string, Declared>>,
  seen: Set<string>,
): string[] {
  const out: string[] = []
  for (const [key, { want, got }] of found) {
    const pinned = declared[`${label} ${key}`]
    if (pinned === undefined) {
      out.push(`${key}: want ${JSON.stringify(want)}\n  got ${JSON.stringify(got)}`)
      continue
    }
    seen.add(`${label} ${key}`)
    if (!isDeepStrictEqual(got, pinned.ours)) {
      out.push(
        `${key}: declared (${pinned.reason}) as ${JSON.stringify(pinned.ours)}\n  got ${JSON.stringify(got)}`,
      )
    }
  }
  for (const key of Object.keys(declared)) {
    if (!key.startsWith(`${label} `)) continue
    const test = key.slice(label.length + 1)
    if (!found.has(test)) out.push(`${key}: declared, but the run matches the golden now`)
  }
  return out
}

/** The declared keys no run looked up: a stale entry for a test that is gone. */
export function unseen(
  declared: Readonly<Record<string, Declared>>,
  seen: ReadonlySet<string>,
): string[] {
  return Object.keys(declared).filter((key) => !seen.has(key))
}
