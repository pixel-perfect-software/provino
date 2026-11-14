type Props = { readonly className?: string }

const h = (type: string, props: Props | null, ...children: unknown[]) => ({
  type,
  props: props ?? {},
  children,
})

test('jsx values', () => {
  expect(<div className="greeting">hello</div>).toMatchInlineSnapshot()
  expect(<span />).toMatchInlineSnapshot()
  expect(h('p', null)).toMatchInlineSnapshot()
})
