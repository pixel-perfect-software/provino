// Keeps a function that uses this file's `require` reachable after the file is done: a leak.
;(require('node:fs') as { __leaked?: () => unknown }).__leaked = () => require('node:os')
test('leaks', () => {})
