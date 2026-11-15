// The import adds toHaveStyleRule, the serializer and a beforeEach that resets the style sheet.
import 'jest-styled-components'
import { render } from '@testing-library/react'
import { createElement } from 'react'
import styled from 'styled-components'

const Button = styled.button`
  color: red;
  padding: 4px;
  &:hover {
    color: blue;
  }
`

test('toHaveStyleRule passes, with and without a modifier', () => {
  const { container } = render(createElement(Button, null, 'go'))
  expect(container.firstChild).toHaveStyleRule('color', 'red')
  expect(container.firstChild).toHaveStyleRule('color', 'blue', { modifier: ':hover' })
})
test('toHaveStyleRule fails on another value', () => {
  const { container } = render(createElement(Button, null, 'go'))
  expect(container.firstChild).toHaveStyleRule('color', 'green')
})
test('toHaveStyleRule fails on a missing property', () => {
  const { container } = render(createElement(Button, null, 'go'))
  expect(container.firstChild).toHaveStyleRule('margin', '1px')
})
test('the snapshot holds the serializer class names and the rules', () => {
  const { container } = render(createElement(Button, null, 'go'))
  expect(container.firstChild).toMatchSnapshot()
})
