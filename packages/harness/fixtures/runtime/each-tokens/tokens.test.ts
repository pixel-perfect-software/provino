// Vitest's %s prints a Date with Date.prototype.toString, in the local time zone: pin it while the
// titles are made, so the golden doesn't depend on the machine that runs the fixture.
const originalTimeZone = process.env.TZ
process.env.TZ = 'UTC'

class Point {
  x = 1
  y = 2
}
// A method, not a function declaration: a sloppy function has own `arguments` and `caller`, which
// `%o` prints, and Jest's CommonJS files are sloppy where a native ES module is strict.
const namedFn = { namedFn() {} }.namedFn
const arrowFn = () => {}
const anonymousFn = (() => () => {})()

const values: unknown[] = [
  'text',
  '',
  ' padded ',
  'two\nlines',
  '50% done',
  '100%',
  '%s',
  '%%',
  '%d and %s',
  'unicode ✓ \u{1F389}',
  0,
  -0,
  1,
  -1,
  1.5,
  -2.5,
  255,
  1e21,
  1e-7,
  2 ** 53,
  0.1 + 0.2,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  10n,
  -5n,
  12345678901234567890n,
  true,
  false,
  null,
  undefined,
  Symbol('sym'),
  Symbol(),
  Symbol.for('registered'),
  namedFn,
  arrowFn,
  anonymousFn,
  new Point(),
  new Date(Number.NaN),
  /re+/gi,
  new Map([[1, 'a']]),
  new Set([1, 2]),
  [],
  [1, 2, 3],
  ['a', ['b', ['c']]],
  [-0, Number.NaN],
  {},
  { a: 1 },
  { a: { b: { c: { d: 1 } } } },
]

const rows = values.map((value) => [value])

test.each(rows)('p[%p]', () => {})
test.each(rows)('s[%s]', () => {})
test.each(rows)('d[%d]', () => {})
test.each(rows)('i[%i]', () => {})
test.each(rows)('f[%f]', () => {})
// Vitest's %j throws on a bigint (each-json-bigint has Jest's answer), so those rows sit out.
test.each(rows.filter(([value]) => typeof value !== 'bigint'))('j[%j]', () => {})
test.each(rows)('o[%o]', () => {})
test.each(rows)('O[%O]', () => {})
test.each(rows)('c[%c]', () => {})
test.each(rows)('c2[%c %s]', () => {})
test.each(rows)('idx[%#] num[%$]', () => {})
test.each(rows)('pct[%%]', () => {})
test.each(rows)('pct2[%% %s %%]', () => {})

if (originalTimeZone === undefined) delete process.env.TZ
else process.env.TZ = originalTimeZone
