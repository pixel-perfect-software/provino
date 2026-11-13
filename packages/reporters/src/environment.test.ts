import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { AGENT_VARIABLES, detectOutput } from './environment.ts'

const TTY = { isTTY: true, columns: 120 }

describe('detectOutput: a terminal', () => {
  test('is a terminal only when the stream says so', () => {
    assert.equal(detectOutput({ env: {}, stream: TTY }).tty, true)
    assert.equal(detectOutput({ env: {}, stream: { isTTY: false } }).tty, false)
    assert.equal(detectOutput({ env: {}, stream: {} }).tty, false)
    assert.equal(detectOutput({ env: {} }).tty, false)
  })

  test('takes its width from the stream, 80 without one', () => {
    assert.equal(detectOutput({ env: {}, stream: TTY }).columns, 120)
    assert.equal(detectOutput({ env: {}, stream: { isTTY: true } }).columns, 80)
    assert.equal(detectOutput({ env: {} }).columns, 80)
  })

  test('is live in a terminal that is neither CI, nor dumb, nor an agent’s', () => {
    assert.equal(detectOutput({ env: {}, stream: TTY }).live, true)
    assert.equal(detectOutput({ env: { CI: 'true' }, stream: TTY }).live, false)
    assert.equal(detectOutput({ env: { TERM: 'dumb' }, stream: TTY }).live, false)
    assert.equal(detectOutput({ env: { CLAUDECODE: '1' }, stream: TTY }).live, false)
    assert.equal(detectOutput({ env: {}, stream: { isTTY: false } }).live, false)
  })
})

describe('detectOutput: CI', () => {
  test('reads CI as the run does: set, and not empty, 0 or false, ignoring case and spaces', () => {
    for (const [value, expected] of [
      ['true', true],
      ['1', true],
      ['yes', true],
      ['', false],
      ['0', false],
      ['false', false],
      ['FALSE', false],
      [' false ', false],
    ] as const) {
      assert.equal(detectOutput({ env: { CI: value } }).ci, expected, JSON.stringify(value))
    }
    assert.equal(detectOutput({ env: {} }).ci, false)
  })

  test('takes the caller’s answer over the variable', () => {
    assert.equal(detectOutput({ env: { CI: 'true' }, ci: false }).ci, false)
    assert.equal(detectOutput({ env: {}, ci: true }).ci, true)
  })

  test('knows GitHub Actions', () => {
    assert.equal(detectOutput({ env: { GITHUB_ACTIONS: 'true' } }).githubActions, true)
    assert.equal(detectOutput({ env: { GITHUB_ACTIONS: 'false' } }).githubActions, false)
    assert.equal(detectOutput({ env: {} }).githubActions, false)
  })
})

describe('detectOutput: colour', () => {
  test('a terminal has colour, a pipe has none', () => {
    assert.equal(detectOutput({ env: {}, stream: TTY }).colour, true)
    assert.equal(detectOutput({ env: {}, stream: { isTTY: false } }).colour, false)
  })

  test('CI alone does not colour a log (the stream is not a terminal)', () => {
    assert.equal(detectOutput({ env: { CI: 'true' } }).colour, false)
  })

  test('FORCE_COLOR turns it on, whatever the stream; 0 and false turn it off', () => {
    for (const value of ['1', '2', '3', 'true', '']) {
      assert.equal(detectOutput({ env: { FORCE_COLOR: value } }).colour, true, value)
    }
    assert.equal(detectOutput({ env: { FORCE_COLOR: '0' }, stream: TTY }).colour, false)
    assert.equal(detectOutput({ env: { FORCE_COLOR: 'false' }, stream: TTY }).colour, false)
  })

  test('FORCE_COLOR reads 0 and false in any case and with spaces around them, as isSet does', () => {
    for (const value of ['FALSE', 'False', ' false ', ' 0 ']) {
      assert.equal(detectOutput({ env: { FORCE_COLOR: value }, stream: TTY }).colour, false, value)
    }
  })

  test('NO_COLOR turns it off when it is not empty', () => {
    assert.equal(detectOutput({ env: { NO_COLOR: '1' }, stream: TTY }).colour, false)
    assert.equal(detectOutput({ env: { NO_COLOR: '' }, stream: TTY }).colour, true)
  })

  test('FORCE_COLOR wins over NO_COLOR, as in Node and chalk', () => {
    assert.equal(detectOutput({ env: { FORCE_COLOR: '1', NO_COLOR: '1' } }).colour, true)
  })

  test('a terminal an agent runs in has none, unless FORCE_COLOR asks', () => {
    assert.equal(detectOutput({ env: { CLAUDECODE: '1' }, stream: TTY }).colour, false)
    assert.equal(
      detectOutput({ env: { CLAUDECODE: '1', FORCE_COLOR: '1' }, stream: TTY }).colour,
      true,
    )
  })

  test('TERM=dumb has none, and the caller’s choice (--colors) beats the environment', () => {
    assert.equal(detectOutput({ env: { TERM: 'dumb' }, stream: TTY }).colour, false)
    assert.equal(detectOutput({ env: { NO_COLOR: '1' }, stream: TTY, colour: true }).colour, true)
    assert.equal(
      detectOutput({ env: { FORCE_COLOR: '1' }, stream: TTY, colour: false }).colour,
      false,
    )
  })
})

describe('detectOutput: an agent', () => {
  test('finds each variable the list names, and the agent it stands for', () => {
    for (const [agent, variable] of AGENT_VARIABLES) {
      assert.equal(detectOutput({ env: { [variable]: '1' } }).agent, agent, variable)
    }
  })

  test('the list holds the documented variables', () => {
    const names = AGENT_VARIABLES.map(([, variable]) => variable)
    for (const variable of ['CLAUDECODE', 'CURSOR_AGENT', 'CODEX_SANDBOX', 'GEMINI_CLI']) {
      assert.ok(names.includes(variable), variable)
    }
  })

  test('AI_AGENT names the agent by its value, over every other variable', () => {
    assert.equal(detectOutput({ env: { AI_AGENT: 'Devin' } }).agent, 'devin')
    assert.equal(detectOutput({ env: { AI_AGENT: 'x', CLAUDECODE: '1' } }).agent, 'x')
    assert.equal(detectOutput({ env: { AI_AGENT: 'github_copilot_cloud_agent' } }).agent, 'copilot')
  })

  test('a variable set to empty, 0 or false does not count', () => {
    for (const value of ['', '0', 'false']) {
      assert.equal(detectOutput({ env: { CLAUDECODE: value, AI_AGENT: value } }).agent, undefined)
    }
    assert.equal(detectOutput({ env: {} }).agent, undefined)
  })

  test('finds the agents std-env finds by a pattern: pi on PATH, devin in EDITOR, kiro without a terminal', () => {
    assert.equal(detectOutput({ env: { PATH: '/home/me/.pi/agent/bin:/usr/bin' } }).agent, 'pi')
    assert.equal(detectOutput({ env: { EDITOR: '/usr/bin/devin-edit' } }).agent, 'devin')
    assert.equal(detectOutput({ env: { TERM_PROGRAM: 'kiro' } }).agent, 'kiro')
    assert.equal(detectOutput({ env: { TERM_PROGRAM: 'kiro' }, stream: TTY }).agent, undefined)
  })

  test('reads process.env when it is given none', () => {
    const had = process.env.AI_AGENT
    process.env.AI_AGENT = 'probe'
    try {
      assert.equal(detectOutput().agent, 'probe')
    } finally {
      if (had === undefined) delete process.env.AI_AGENT
      else process.env.AI_AGENT = had
    }
  })
})
