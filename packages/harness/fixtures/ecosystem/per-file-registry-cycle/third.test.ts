// The registry, whose files import each other, and the per-file plugin that writes into it.
import { Entry, entries, lookup } from 'cyclic-registry'
import { agent, entry } from 'registering-plugin'

test('third: the plugin registers its entry once', () => {
  expect(lookup('plugin')).toBe(entry)
  expect(entry).toBeInstanceOf(Entry)
})
test('third: the registry’s internals see its entry', () => {
  expect(entries.registry().lookup).toBe(lookup)
})
test('third: the plugin read the environment while it loaded', () => {
  expect(agent).toBe('jsdom')
})
