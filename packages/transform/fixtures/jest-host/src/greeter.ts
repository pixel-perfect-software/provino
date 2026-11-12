import { counter } from './counter.ts'
import { greet } from './deps.ts'

export const hello = (name: string): string => `${greet(name)}/${counter()}`
