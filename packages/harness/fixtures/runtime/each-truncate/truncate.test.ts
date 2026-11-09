// Vitest's %s prints a Date with Date.prototype.toString, in the local time zone: pin it while the
// titles are made, so the golden doesn't depend on the machine that runs the fixture.
const originalTimeZone = process.env.TZ
process.env.TZ = 'UTC'

const strings = [
  'x'.repeat(37),
  'x'.repeat(38),
  'x'.repeat(39),
  'x'.repeat(40),
  'x'.repeat(41),
  'x'.repeat(100),
  `${'x'.repeat(38)}\u{1F389}${'y'.repeat(20)}`,
  `${'x'.repeat(37)}\u{1F389}${'y'.repeat(20)}`,
  `${'x'.repeat(39)}\u{1F389}${'y'.repeat(20)}`,
  `${'word '.repeat(20)}end`,
  `line one\nline two\n${'z'.repeat(60)}`,
]

test.each(strings.map((value) => [value]))('s=%s', () => {})
test.each(strings.map((value) => [value]))('o=%o', () => {})
test.each(strings.map((value) => [value]))('O=%O', () => {})
test.each(strings.map((value) => [value]))('j=%j', () => {})
test.each(strings.map((value) => [value]))('p=%p', () => {})
test.each(strings.map((value) => ({ v: value })))('v=$v', () => {})

const longArray = Array.from({ length: 50 }, (_, index) => index)
const longObject = Object.fromEntries(longArray.map((index) => [`key${index}`, index]))
class Wide {
  alpha = 'aaaaaaaaaaaaaaaaaaaa'
  beta = 'bbbbbbbbbbbbbbbbbbbb'
  gamma = 'cccccccccccccccccccc'
}
// A method, not a function declaration (see each-tokens): `%o` prints a sloppy function's `arguments`.
const aVeryLongFunctionNameThatKeepsGoing = { aVeryLongFunctionNameThatKeepsGoing() {} }
  .aVeryLongFunctionNameThatKeepsGoing

const others: unknown[] = [
  longArray,
  longObject,
  [longArray, longArray],
  { list: longArray, text: 'x'.repeat(60) },
  { a: { b: { c: { d: 'x'.repeat(60) } } } },
  [[['x'.repeat(60)]]],
  new Map(longArray.map((index) => [index, `value ${index}`])),
  new Set(longArray),
  new Wide(),
  [new Wide(), new Wide()],
  aVeryLongFunctionNameThatKeepsGoing,
  /a-very-long-regular-expression-that-keeps-on-going-and-going/giu,
  Symbol('a symbol description that is longer than forty characters'),
  ['short'],
  { short: 1 },
  { 'a-long-key-name-that-goes-past-the-limit-on-its-own': 1 },
  [1, 2, 3, 'x'.repeat(38)],
  [1, 2, 3, 'x'.repeat(39)],
]

test.each(others.map((value) => [value]))('s=%s', () => {})
test.each(others.map((value) => [value]))('o=%o', () => {})
test.each(others.map((value) => [value]))('O=%O', () => {})
test.each(others.map((value) => [value]))('j=%j', () => {})
test.each(others.map((value) => [value]))('p=%p', () => {})
test.each(others.map((value) => ({ v: value })))('v=$v', () => {})
test.each(others.map((value) => ({ v: { inner: value } })))('v.inner=$v.inner v=$v', () => {})

// Several long values in one title: each is cut on its own.
test.each([[strings[5], longArray, longObject]])('%s | %o | %O', () => {})
test.each([{ s: strings[5], a: longArray, o: longObject }])('$s | $a | $o', () => {})

if (originalTimeZone === undefined) delete process.env.TZ
else process.env.TZ = originalTimeZone
