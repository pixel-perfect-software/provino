const rows = [
  { a: 1, b: 'two', c: { d: 3 } },
  { a: 'x', b: null, c: { d: [1, 2] } },
  { a: undefined, b: true, c: 'plain' },
  { a: { nested: { deep: { deeper: 1 } } }, b: [1, [2, [3]]], c: { d: { e: { f: 1 } } } },
  { a: Number.NaN, b: -0, c: 10 },
  { a: '50% off', b: '%s', c: '$a' },
]

test.each(rows)('plain title', () => {})
test.each(rows)('a=$a', () => {})
test.each(rows)('b=$b c.d=$c.d', () => {})
test.each(rows)('$a|$b|$c', () => {})
test.each(rows)('c.d.e.f=$c.d.e.f', () => {})
test.each(rows)('missing=$zz and $a.zz and $c.zz.yy', () => {})
test.each(rows)('index=$# a=$a', () => {})
test.each(rows)('two index $# and $#', () => {})
test.each(rows)('$0 $1 $2', () => {})
test.each(rows)('$a$b$c', () => {})
test.each(rows)('$a, $b; ($c)', () => {})
test.each(rows)('$a.', () => {})
test.each(rows)('$a. $b.', () => {})
test.each(rows)('$a.b', () => {})
test.each(rows)('$', () => {})
test.each(rows)('$ a $ b', () => {})
test.each(rows)('$$a $$$b', () => {})
// biome-ignore lint/suspicious/noTemplateCurlyInString: the title is the text `${a}`, not a template
test.each(rows)('${a} $(b)', () => {})
test.each(rows)('$a-$b $a_$b', () => {})
test.each(rows)('$A $B', () => {})

// Placeholders beside $variables on an object row.
test.each(rows)('%s $a', () => {})
test.each(rows)('%# $a', () => {})
test.each(rows)('%$ $a', () => {})
test.each(rows)('%p|%j|$a', () => {})
test.each(rows)('%% $a', () => {})
test.each(rows)('$a %%', () => {})
test.each(rows)('$a %% %%', () => {})
test.each(rows)('%%s $a', () => {})
test.each(rows)('100%% $b', () => {})
test.each(rows)('$a %', () => {})
test.each(rows)('$a %x', () => {})

// Keys that overlap, hold a dot, a space or a regex character.
const keys = [
  { a: 1, ab: 2, abc: 3 },
  { 'a.b': 4, a: { b: 5 } },
  { 'a b': 6, a: 7 },
  { 'a+b': 8, 'a*': 9, 'x|y': 10, 'p(q)': 11, '[z]': 12, 'k?': 13 },
  { $x: 14, '': 15, '#': 16, 0: 17, 1: 18 },
  { $: 19, a$: 20, _u: 21, ü: 22 },
]
test.each(keys)('a=$a ab=$ab abc=$abc', () => {})
test.each(keys)('a.b=$a.b', () => {})
test.each(keys)('a b=$a b', () => {})
test.each(keys)('plus=$a+b star=$a* pipe=$x|y paren=$p(q) bracket=$[z] q=$k?', () => {})
test.each(keys)('dollar=$$x hash=$# zero=$0 one=$1', () => {})
test.each(keys)('d=$$ ad=$a$ u=$_u uml=$ü', () => {})

// An array row: $0 and $1 for Vitest, nothing for Jest. An object first item lends its keys.
test.each([
  [1, 'b'],
  [{ a: 'x' }, 'y'],
  [[1, 2], { a: 'z' }],
])('$0|$1|$a|$#|%s', () => {})
test.each([[{ a: 'x', b: { c: 'y' } }, 'second']])('$a $b.c $0 $1 %p', () => {})
