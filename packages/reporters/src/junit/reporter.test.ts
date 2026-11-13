import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { ReportPolicy } from '@provino/types'
import { createReporterBus } from '../bus.ts'
import {
  error,
  FIXTURE_FILES,
  FIXTURE_SNAPSHOTS,
  output,
  playFixture,
  playRun,
} from '../internal/test-support.ts'
import { junitReporter } from './reporter.ts'

const XSD = fileURLToPath(new URL('./vendor/junit-10.xsd', import.meta.url))
const REPORT: ReportPolicy = {
  displaySeparator: ' › ',
  defaultReporters: ['default'],
  failureTitleBullet: '  ● ',
  resultStatusSkipped: 'pending',
}

/** Whether `xmllint` (libxml2's, a system tool: macOS and the Ubuntu runners have it) can be run. */
const XMLLINT = spawnSync('xmllint', ['--version'], { encoding: 'utf8' }).error === undefined

/**
 * Validates `xml` against the vendored Jenkins JUnit XSD. Without `xmllint` the test fails on CI
 * (the check must run there) and is skipped, saying so, anywhere else.
 */
async function validate(xml: string): Promise<{ readonly ok: boolean; readonly stderr: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'provino-junit-'))
  try {
    const file = join(dir, 'junit.xml')
    await writeFile(file, xml)
    const result = spawnSync('xmllint', ['--noout', '--schema', XSD, file], { encoding: 'utf8' })
    return { ok: result.status === 0, stderr: result.stderr }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const skip = !XMLLINT && process.env.CI === undefined ? 'xmllint is not installed' : false

describe('the junit reporter', () => {
  test('is a reporter named junit', () => {
    assert.equal(junitReporter({ report: REPORT, stream: output() }).name, 'junit')
  })

  test('xmllint is there on CI, where the schema check must run', () => {
    assert.ok(XMLLINT || process.env.CI === undefined, 'CI has no xmllint: install libxml2-utils')
  })

  test('the fixture run validates against the Jenkins JUnit XSD', { skip }, async () => {
    const { text } = await playFixture((out) => junitReporter({ stream: out, report: REPORT }))
    const result = await validate(text)
    assert.ok(result.ok, result.stderr)
  })

  test('the validation is real: a document that breaks the schema is refused', {
    skip,
  }, async () => {
    const { text } = await playFixture((out) => junitReporter({ stream: out, report: REPORT }))
    // `tests` is required on a testsuite.
    const refused = await validate(text.replace(' tests="3"', ''))
    assert.equal(refused.ok, false)
    assert.match(refused.stderr, /tests/)
    // So is a testcase without a name, and an element the schema doesn't have.
    assert.equal(
      (await validate(text.replace('<testcase name="stands alone"', '<testcase'))).ok,
      false,
    )
    assert.equal(
      (await validate(text.replace('</testsuites>', '<nonsense/></testsuites>'))).ok,
      false,
    )
  })

  test('a run with no files is a valid, empty document', { skip }, async () => {
    const out = output()
    const bus = createReporterBus([junitReporter({ report: REPORT, stream: out })])
    await playRun(bus, [])
    assert.match(
      out.text(),
      /<testsuites name="provino" tests="0" failures="0" errors="0" time="1\.234"\/>/,
    )
    assert.ok((await validate(out.text())).ok)
  })

  test('counts: a failed test is a failure, a file that did not run an error, a skipped or todo test skipped', async () => {
    const { text } = await playFixture((out) => junitReporter({ stream: out, report: REPORT }))
    assert.match(
      text,
      /<testsuites name="provino" tests="14" failures="2" errors="1" time="1\.234">/,
    )
    assert.match(
      text,
      /<testsuite name="skipped\.test\.ts" tests="3" failures="0" errors="0" skipped="2"/,
    )
    assert.match(text, /<testsuite name="broken\.test\.ts" tests="1" failures="0" errors="1"/)
  })

  test('escapes names, messages and console text, and drops what XML cannot hold', {
    skip,
  }, async () => {
    const out = output()
    const bus = createReporterBus([
      junitReporter({ report: REPORT, stream: out, name: 'a "b" & <c>' }),
    ])
    await playRun(bus, [
      {
        path: 'odd <&> "names".test.ts',
        tests: [
          {
            path: ['x < y', 'tab\tand "quotes" & ampersand'],
            state: 'fail',
            errors: [
              error(
                'line one\nline two with \u001b[31mred\u001b[39m and a control \u0001 char ]]> end',
                {
                  name: 'Weird<Error>',
                },
              ),
            ],
            console: [{ text: 'out <b> & \u0007bell\n' }],
          },
        ],
      },
    ])
    const text = out.text()
    assert.match(text, /name="a &quot;b&quot; &amp; &lt;c&gt;"/)
    assert.match(text, /name="odd &lt;&amp;&gt; &quot;names&quot;\.test\.ts"/)
    assert.match(text, /name="x &lt; y › tab&#9;and &quot;quotes&quot; &amp; ampersand"/)
    assert.match(text, /type="Weird&lt;Error&gt;"/)
    // The attribute holds the first line; the text all of it, with the ANSI and the control characters gone.
    assert.match(text, /message="line one"/)
    assert.match(text, /line two with red and a control {2}char \]\]&gt; end/)
    for (const char of text) {
      const code = char.charCodeAt(0)
      assert.ok(code >= 32 || code === 9 || code === 10 || code === 13, `control character ${code}`)
    }
    assert.match(text, /<system-out>out &lt;b&gt; &amp; bell\n<\/system-out>/)
    assert.ok((await validate(text)).ok, 'valid')
  })

  test('keeps each test’s console writes together and in order, and a write outside any test on the suite', async () => {
    const out = output()
    const bus = createReporterBus([junitReporter({ report: REPORT, stream: out })])
    await playRun(bus, [
      {
        path: 'c.test.ts',
        console: [{ text: 'file level\n' }],
        tests: [
          {
            path: ['a'],
            console: [
              { text: 'one\n' },
              { stream: 'stderr', level: 'warn', text: 'warned\n' },
              { text: 'two\n' },
              { text: 'three\n' },
            ],
          },
          { path: ['b'], console: [{ text: 'other\n' }] },
        ],
      },
    ])
    const text = out.text()
    assert.match(
      text,
      /<testcase name="a"[^>]*>\s*<system-out>one\ntwo\nthree\n<\/system-out>\s*<system-err>warned\n<\/system-err>\s*<\/testcase>/,
    )
    assert.match(
      text,
      /<testcase name="b"[^>]*>\s*<system-out>other\n<\/system-out>\s*<\/testcase>/,
    )
    assert.match(text, /<\/testcase>\s*<system-out>file level\n<\/system-out>\s*<\/testsuite>/)
  })

  test('writes the document to outputFile, atomically, and creates its directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'provino-junit-'))
    try {
      const outputFile = join(dir, 'reports', 'junit.xml')
      const bus = createReporterBus([junitReporter({ report: REPORT, outputFile })])
      await playRun(bus, FIXTURE_FILES.slice(0, 2), { snapshots: FIXTURE_SNAPSHOTS })
      assert.deepEqual(bus.failures(), [])
      const written = await readFile(outputFile, 'utf8')
      assert.match(written, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<testsuites /)
      assert.match(written, /<\/testsuites>\n$/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('a failed write fails the run through the bus', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'provino-junit-'))
    try {
      // A file where a directory has to be.
      await writeFile(join(dir, 'file'), 'x')
      const bus = createReporterBus([
        junitReporter({ report: REPORT, outputFile: join(dir, 'file', 'junit.xml') }),
      ])
      await playRun(bus, [])
      assert.equal(bus.failures().length, 1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('an error outside any file is a suite of its own', { skip }, async () => {
    const out = output()
    const bus = createReporterBus([junitReporter({ report: REPORT, stream: out })])
    await bus.emit(
      'run:start',
      { root: '/project', projects: [''], startTime: 0, watch: false },
      [],
    )
    await bus.emit('error', error('setup broke'), 'globalSetup')
    await bus.emit('run:end', { reason: 'failed', files: [], unhandled: [], durationMs: 5 })
    assert.match(
      out.text(),
      /<testsuite name="Errors outside any test file" tests="1" failures="0" errors="1"/,
    )
    assert.ok((await validate(out.text())).ok)
  })
})
