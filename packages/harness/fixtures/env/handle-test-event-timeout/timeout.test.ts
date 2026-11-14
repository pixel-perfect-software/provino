declare const __log: (marker: string) => void

beforeEach(() => __log('beforeEach root'), 777)

test('default timeout', () => __log('body default timeout'))
test('own timeout', () => __log('body own timeout'), 4321)
