// A second file on the same worker: its snapshot shows whether the style sheet was reset for it.
import 'jest-styled-components'
import { render } from '@testing-library/react'
import { createElement } from 'react'
import styled from 'styled-components'

const Card = styled.section`
  border: 1px solid black;
`
const Title = styled.h2`
  font-weight: bold;
`

test('the snapshot of a nested pair', () => {
  const { container } = render(createElement(Card, null, createElement(Title, null, 'title')))
  expect(container.firstChild).toMatchSnapshot()
})
test('toHaveStyleRule on the second file', () => {
  const { container } = render(createElement(Card, null, 'body'))
  expect(container.firstChild).toHaveStyleRule('border', '1px solid black')
})
