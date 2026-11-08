import { A, B, child } from './classes.ts'

vi.mock('./classes.ts')

const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

c('a subclass instance has inherited methods as mocks', () => {
  const b = new B()
  return {
    aMethodIsMock: vi.isMockFunction(b.aMethod),
    bMethodIsMock: vi.isMockFunction(b.bMethod),
    sharedIsMock: vi.isMockFunction(b.shared),
    aMethodResult: b.aMethod(),
    sharedResult: b.shared(),
  }
})

c('the subclass chain and its own names', () => ({
  extendsA: Object.getPrototypeOf(B) === A,
  protoChain: Object.getPrototypeOf(B.prototype) === A.prototype,
  bProtoNames: Object.getOwnPropertyNames(B.prototype),
  aProtoNames: Object.getOwnPropertyNames(A.prototype),
  instanceOfA: new B() instanceof A,
}))

c('statics, own and inherited, are mocks', () => ({
  bStaticIsMock: vi.isMockFunction(B.bStatic),
  aStaticOnBIsMock: vi.isMockFunction((B as unknown as typeof A).aStatic),
  aStaticOnBIsOwn: Object.hasOwn(B, 'aStatic'),
  aStaticIsMock: vi.isMockFunction(A.aStatic),
  sameStatic: (B as unknown as typeof A).aStatic === A.aStatic,
}))

c('an object with a prototype: own and inherited members', () => ({
  ownIsMock: vi.isMockFunction(child.own),
  inheritedIsMock: vi.isMockFunction(child.inherited),
  inheritedValue: child.inheritedValue,
  inheritedOwn: Object.hasOwn(child, 'inherited'),
  ownKeys: Object.keys(child),
}))
