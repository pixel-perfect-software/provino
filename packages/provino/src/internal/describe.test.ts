import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ConfigError } from '@provino/config'
import { usageMessage } from './describe.ts'

describe('usageMessage', () => {
  it('prints each dialect-option issue once: the message already lists them', () => {
    const error = new ConfigError(
      'CONFIG_BAD_DIALECT_OPTIONS',
      'invalid options for the "jest" dialect:\n  retries: must be a number\n  (options): unknown key',
      {
        issues: [
          { path: 'retries', message: 'must be a number' },
          { path: '', message: 'unknown key' },
        ],
      },
    )
    const text = usageMessage(error) ?? ''
    assert.equal(text.split('must be a number').length - 1, 1, text)
    assert.equal(text.split('unknown key').length - 1, 1, text)
  })

  it('still lists an issue that the message does not carry', () => {
    const error = new ConfigError('CONFIG_BAD_DIALECT_OPTIONS', 'bad config', {
      issues: [{ path: 'include', message: 'must be an array' }],
    })
    assert.equal(usageMessage(error), 'Provino: bad config\n  - include: must be an array')
  })

  it('keeps the detail of a cause that is not an Error', () => {
    const asString = new ConfigError('CONFIG_LOAD_FAILED', "can't load", {
      cause: 'plain string boom',
    })
    assert.match(usageMessage(asString) ?? '', /caused by: plain string boom/)
    const asObject = new ConfigError('CONFIG_LOAD_FAILED', "can't load", {
      cause: { reason: 'object boom' },
    })
    assert.match(usageMessage(asObject) ?? '', /caused by: .*object boom/)
  })
})
