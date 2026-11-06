// The own keys of the jest object and of vi, in the order each runner defines them. Recorded for
// T11.10; nothing reads it yet and it is not one of the counted cases.
const M = typeof jest === 'undefined' ? vi : jest

test('own keys of the mock global', () =>
  observe('Object.keys of the mock global', () => Object.keys(M)))
