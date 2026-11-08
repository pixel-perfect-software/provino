// Fewer values than placeholders, and an empty row.
test.each([[1], ['a', 'b'], [1, 2, 3]])('three s: %s %s %s', () => {})
test.each([[], [1]])('empty row: %s|%d|%j|%p|%o|%#', () => {})

// More values than placeholders.
test.each([[1, 2, 3]])('one s: %s', () => {})
test.each([[1, 2, 3]])('none: plain title', () => {})
test.each([[1, 2, 3]])('only index: %#', () => {})
test.each([[1, 2, 3]])('only count: %$', () => {})

// A repeated index or number token.
test.each([[1], [2]])('%# %# %$ %$', () => {})
test.each([[1], [2]])('%$ then %# then %$ then %#', () => {})

// The %% escape beside other tokens.
test.each([[1, 2]])('%%s %s', () => {})
test.each([[1, 2]])('%%%s', () => {})
test.each([[1, 2]])('%%%%s %s', () => {})
test.each([[1, 2]])('%s%%', () => {})
test.each([[1, 2]])('%%%%', () => {})
test.each([[1]])('%%# %#', () => {})
test.each([[1]])('%%$ %$', () => {})
test.each([[1]])('%%%# and %%%$', () => {})
test.each([[1, 2]])('%%d %d %%i %i', () => {})
test.each([[1, 2]])('%%p %p %%j %j', () => {})

// A % that is no token, next to ones that are.
test.each([[1]])('100% sure %s', () => {})
test.each([[1]])('% d %s', () => {})
test.each([[1]])('%x %e %5d %s', () => {})
test.each([[1]])('trailing %', () => {})
test.each([[1, 2]])('%s %', () => {})
test.each([[1, 2]])('% %s %s', () => {})
test.each([[1]])('%', () => {})
test.each([[1]])('%%', () => {})
test.each([[1]])('%%%', () => {})
test.each([[1]])('%l %L %D %S %I %F %J %P', () => {})

// A value that holds a token.
test.each([['a%sb', 'c']])('%s %s', () => {})
test.each([['a%sb', 'c']])('%p %s', () => {})
test.each([['a%pb', 'c']])('%s %s', () => {})
test.each([['a%pb', 'c']])('%p %s', () => {})
test.each([['%%', '%#', '%$', '%d']])('%s %s %s %s', () => {})
test.each([['%', '%%', '%%%']])('%s|%s|%s', () => {})
test.each([['50% off', '%s', '%d']])('%s | %s | %s', () => {})
test.each([['%j', 5]])('%s %j', () => {})
test.each([[{ pct: '%s' }, 'x']])('%j %s', () => {})
test.each([[{ pct: '%s' }, 'x']])('%p %s', () => {})

// %c takes a value and prints nothing.
test.each([[1, 2]])('%c %s %s', () => {})
test.each([[1, 2, 3]])('%s %c %s', () => {})
test.each([[1]])('[%c]', () => {})
test.each([[1, 2]])('%c%c %s', () => {})

// Placeholders of different kinds in one title.
test.each([[1, 'two', { three: 3 }, [4], 5.5]])('%d %s %j %p %f', () => {})
test.each([[1, 'two', { three: 3 }, [4], 5.5]])('%p %j %s %d %i', () => {})
test.each([[1, 'two', { three: 3 }, [4], 5.5]])('%o | %O | %s | %s | %s', () => {})
test.each([[1.9, '2.9', 3.9, -4.9, '0x10']])('%i %i %d %i %d', () => {})
test.each([['12abc', '1e3', '', ' 7 ', 'abc']])('%d %d %d %d %d', () => {})
test.each([['12abc', '1e3', '', ' 7 ', 'abc']])('%i %i %i %i %i', () => {})
test.each([['12abc', '1e3', '', ' 7 ', 'abc']])('%f %f %f %f %f', () => {})

// A title with no tokens, a row of objects, nested rows.
test.each([[{ a: 1 }, { b: 2 }]])('%s and %s', () => {})
test.each([[[1, 2], [3]]])('%s and %s', () => {})
test.each([[[1, 2], [3]]])('%p and %p', () => {})
test.each([[[1, 2], [3]]])('%j and %j', () => {})

// Tables of bare primitives and mixed cells.
test.each([1, 'a', null, undefined, true])('prim: %s', () => {})
test.each(['a', 'b'])('str: %s %#', () => {})
test.each(['a', 'b'])('str plain', () => {})
test.each([1, 2])('num: %d %$', () => {})
test.each([null, undefined])('nullish: %s|%d|%j|%p', () => {})
