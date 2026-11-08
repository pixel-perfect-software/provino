// A tagged template built by hand (see each-templates for why): its strings and values.
function table(headings: readonly string[], rows: readonly (readonly unknown[])[]) {
  const strings: string[] = [`\n  ${headings.join(' | ')}\n  `]
  const cells = rows.flat()
  for (let index = 1; index < cells.length; index++) {
    strings.push(index % headings.length === 0 ? '\n  ' : ' | ')
  }
  strings.push('\n')
  return [Object.assign(strings, { raw: strings }), ...cells] as const
}

const titles = [
  '%s $a',
  '%# $a',
  '%$ $a',
  '%% $a',
  '$a %% $b',
  '%%s $a',
  '100% $a',
  '%p|%j $a',
  '$a %d %i %f %o %O %c $b',
]

const rows = [
  [1, 2],
  ['x', null],
  [{ k: 'v' }, [1, 2]],
  ['50% off', '%s'],
]

for (const title of titles) {
  test.each(...table(['a', 'b'], rows))(title, () => {})
}

// The same titles over an array of objects, which Jest does format.
for (const title of titles) {
  test.each([
    { a: 1, b: 2 },
    { a: 'x', b: null },
  ])(`rows: ${title}`, () => {})
}
