// The registry, whose files import each other, and the per-file plugin that writes into it.
import { Entry, entries, lookup } from 'cyclic-registry'
import { agent, entry } from 'registering-plugin'

test('first: the plugin registers its entry once', () => {
  expect(lookup('plugin')).toBe(entry)
  expect(entry).toBeInstanceOf(Entry)
})
test('first: the registry’s internals see its entry', () => {
  expect(entries.registry().lookup).toBe(lookup)
})
test('first: the plugin read the environment while it loaded', () => {
  expect(agent).toBe('jsdom')
})
