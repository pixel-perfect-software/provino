import { A, B, child } from './classes.ts'

jest.mock('./classes.ts')

const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

c('a subclass instance has inherited methods as mocks', () => {
  const b = new B()
  return {
    aMethodIsMock: jest.isMockFunction(b.aMethod),
    bMethodIsMock: jest.isMockFunction(b.bMethod),
    sharedIsMock: jest.isMockFunction(b.shared),
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
  bStaticIsMock: jest.isMockFunction(B.bStatic),
  aStaticOnBIsMock: jest.isMockFunction((B as unknown as typeof A).aStatic),
  aStaticOnBIsOwn: Object.hasOwn(B, 'aStatic'),
  aStaticIsMock: jest.isMockFunction(A.aStatic),
  sameStatic: (B as unknown as typeof A).aStatic === A.aStatic,
}))

c('an object with a prototype: own and inherited members', () => ({
  ownIsMock: jest.isMockFunction(child.own),
  inheritedIsMock: jest.isMockFunction(child.inherited),
  inheritedValue: child.inheritedValue,
  inheritedOwn: Object.hasOwn(child, 'inherited'),
  ownKeys: Object.keys(child),
}))
