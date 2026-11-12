test.each([[5n], [-12345678901234567890n]])('bigint: %j', () => {})
test.each([[{ big: 5n }]])('nested bigint: %j', () => {})
