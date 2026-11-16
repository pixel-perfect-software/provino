// The registry, a shared package and the per-file plugin, imported in that order.
import { Entry, lookup } from 'entry-registry'
import { core as widgetCore } from 'plain-widget'
import { agent, entry, core as pluginCore } from 'registering-plugin'

test('second: the plugin registers its entry once', () => {
  expect(lookup('plugin')).toBe(entry)
  expect(entry).toBeInstanceOf(Entry)
})
test('second: the plugin read the environment while it loaded', () => {
  expect(agent).toBe('jsdom')
})
test('second: the plugin and the widget see one core-lib', () => {
  expect(pluginCore).toBe(widgetCore)
})
