import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { HarnessError, type HarnessErrorCode } from './errors.ts'
import { parseExclusions, parseFlaky } from './exclusions.ts'

const TODAY = '2026-11-07'

function file(...rules: unknown[]): string {
  return JSON.stringify({ rules })
}

function rule(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'div/x', reason: 'why', kinds: ['status'], expires: '2026-12-01', ...extra }
}

function code(expected: HarnessErrorCode, includes?: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof HarnessError &&
    error.code === expected &&
    (includes === undefined || error.message.includes(includes))
}

test('a rule with every field reads back as written', () => {
  const full = rule({
    keyGlob: 'a.test.ts::*',
    pair: ['jest', 'vitest'],
    policyKey: 'mock.resetTo',
    absentIn: 'candidate',
  })
  assert.deepEqual(parseExclusions(file(full), 'e.json', { today: TODAY }), [full])
})

test('R2: every rule must expire, within 90 days of today', () => {
  assert.throws(
    () => parseExclusions(file(rule({ expires: undefined })), 'e.json', { today: TODAY }),
    code('HARNESS_EXCLUSIONS_INVALID', 'no "expires"'),
  )
  // 2026-11-07 plus 90 days is 2027-02-05.
  assert.equal(
    parseExclusions(file(rule({ expires: '2027-02-05' })), 'e.json', { today: TODAY }).length,
    1,
  )
  assert.throws(
    () => parseExclusions(file(rule({ expires: '2027-02-06' })), 'e.json', { today: TODAY }),
    code('HARNESS_EXCLUSIONS_INVALID', 'more than 90 days'),
  )
})

test('a rule already past its date is read; diffRuns reports it expired', () => {
  const past = rule({ expires: '2026-01-01' })
  assert.deepEqual(parseExclusions(file(past), 'e.json', { today: TODAY }), [past])
})

test('calibration lifts the expiry rule (D30), but not the shape rules', () => {
  const forever = rule({ expires: undefined })
  delete forever.expires
  const far = rule({ expires: '2030-01-01' })
  assert.deepEqual(
    parseExclusions(file(forever, { ...far, id: 'div/y' }), 'e.json', {
      today: TODAY,
      calibration: true,
    }),
    [forever, { ...far, id: 'div/y' }],
  )
  assert.throws(
    () => parseExclusions(file(rule({ kinds: [] })), 'e.json', { today: TODAY, calibration: true }),
    code('HARNESS_EXCLUSIONS_INVALID'),
  )
})

test('bad shapes are refused, naming the rule', () => {
  const cases: readonly [unknown, string][] = [
    [rule({ id: '' }), 'rules[0].id'],
    [rule({ reason: 3 }), 'rules[0].reason'],
    [rule({ kinds: ['status', 'colour'] }), '"colour"'],
    [rule({ kinds: 'status' }), 'rules[0].kinds'],
    [rule({ pair: ['jest'] }), 'rules[0].pair'],
    [rule({ keyGlob: '' }), 'rules[0].keyGlob'],
    [rule({ policyKey: 1 }), 'rules[0].policyKey'],
    [rule({ absentIn: 'both' }), 'rules[0].absentIn'],
    [rule({ expires: '2026-02-31' }), 'rules[0].expires'],
    [rule({ expires: '1 Dec 2026' }), 'rules[0].expires'],
    [rule({ until: '2026-12-01' }), 'unknown key "until"'],
    ['not an object', 'rules[0] must be an object'],
  ]
  for (const [bad, message] of cases) {
    assert.throws(
      () => parseExclusions(file(bad), 'e.json', { today: TODAY }),
      code('HARNESS_EXCLUSIONS_INVALID', message),
      message,
    )
  }
  assert.throws(
    () => parseExclusions(file(rule(), rule()), 'e.json', { today: TODAY }),
    code('HARNESS_EXCLUSIONS_INVALID', 'two rules have the id "div/x"'),
  )
  assert.throws(
    () => parseExclusions('{', 'e.json', { today: TODAY }),
    code('HARNESS_EXCLUSIONS_INVALID', 'not valid JSON'),
  )
  assert.throws(
    () => parseExclusions('[]', 'e.json', { today: TODAY }),
    code('HARNESS_EXCLUSIONS_INVALID', '"rules" array'),
  )
  assert.throws(
    () => parseExclusions(JSON.stringify({ rules: [], extra: 1 }), 'e.json', { today: TODAY }),
    code('HARNESS_EXCLUSIONS_INVALID', 'unknown key "extra"'),
  )
  assert.throws(
    () => parseExclusions(file(), 'e.json', { today: 'yesterday' }),
    code('HARNESS_BAD_DATE'),
  )
})

test("the sample's exclusions are the 4 calibration rules, valid only with calibration", () => {
  const sample = path.join(import.meta.dirname, '..', 'sample', 'exclusions.json')
  const text = readFileSync(sample, 'utf8')
  const rules = parseExclusions(text, sample, { today: TODAY, calibration: true })
  assert.deepEqual(
    rules.map((r) => r.id),
    [
      'div/beforeAll-failure-status',
      'div/mockReset-restores-impl',
      'div/snapshot-file-format',
      'div/runner-made-error-frame',
    ],
  )
  for (const r of rules) {
    assert.equal(r.expires, undefined, `${r.id} has no expiry (D30)`)
    assert.deepEqual(r.pair, ['jest', 'vitest'])
  }
  // The spike's three name the policy key that explains them; no key names the fourth yet, so it
  // is held to its own shape instead: a user frame that only Jest has.
  for (const r of rules.slice(0, 3)) assert.ok(r.policyKey !== undefined, `${r.id} names its key`)
  const [, , , runnerMade] = rules
  assert.deepEqual(runnerMade?.kinds, ['user-frame'])
  assert.equal(runnerMade?.absentIn, 'candidate')
  assert.equal(runnerMade?.keyGlob, undefined)
  assert.throws(
    () => parseExclusions(text, sample, { today: TODAY }),
    code('HARNESS_EXCLUSIONS_INVALID', 'no "expires"'),
  )
})

test('parseFlaky reads { keys } of test keys and refuses anything else', () => {
  assert.deepEqual(parseFlaky('{"keys":["a.test.ts::x#0"]}', 'f.json'), ['a.test.ts::x#0'])
  assert.deepEqual(parseFlaky('{"keys":[]}', 'f.json'), [])
  for (const bad of ['{', '[]', '{"keys":"a"}', '{"keys":["a.test.ts"]}', '{"keys":[],"x":1}']) {
    assert.throws(() => parseFlaky(bad, 'f.json'), code('HARNESS_FLAKY_INVALID'), bad)
  }
})
