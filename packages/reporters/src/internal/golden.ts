// Golden files for the reporters' own output (T9.7): `src/__goldens__/<name>.<txt|xml|json>`, one per
// built-in and mode. A golden is what the reporter wrote for the fixture run (`FIXTURE_FILES` in `test-support.ts`),
// with the escape character shown as `<ESC>` so a coloured golden can be read. They are written,
// never edited: `PROVINO_UPDATE_GOLDENS=1 pnpm test --filter @provino/reporters` rewrites them, and
// a missing golden fails the test (and always does with `CI` set). They pin Provino's output; where
// the text claims to be Jest's, `provino`'s `test/reporters.test.ts` holds it to a recording of
// Jest 30.5.2 instead (`cli/report-*`).
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const GOLDENS = fileURLToPath(new URL('../__goldens__/', import.meta.url))

/** The text as a golden holds it: the escape character written out. */
export function visible(text: string): string {
  return text.replaceAll(String.fromCharCode(27), '<ESC>')
}

/** Checks `actual` against `<name>.<extension>` in the goldens directory (or writes it when updating). */
export async function expectGolden(name: string, actual: string, extension = 'txt'): Promise<void> {
  const path = join(GOLDENS, `${name}.${extension}`)
  const text = visible(actual)
  if (process.env.PROVINO_UPDATE_GOLDENS === '1' && process.env.CI === undefined) {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, text)
    return
  }
  let expected: string
  try {
    expected = await readFile(path, 'utf8')
  } catch (cause) {
    throw new Error(
      `no golden ${path}: write it with PROVINO_UPDATE_GOLDENS=1 pnpm test --filter @provino/reporters and read it before committing`,
      { cause },
    )
  }
  assert.equal(text, expected, `the output differs from the golden ${path}`)
}
