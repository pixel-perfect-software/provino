/**
 * @vitest-environment node
 * @jest-environment provino-no-such-environment
 */
// Both pragmas: the file fails to start unless the vitest-environment one wins.
test('ran with both pragmas', () => {})
