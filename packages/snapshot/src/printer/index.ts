// @provino/snapshot/printer: the native snapshot printer, Jest 30.5.2's `serialize` over the vendored
// pretty-format, so a native run writes the bytes Jest writes. The implementation is in `impl.ts`.
export { nativeSnapshotPrinter } from './impl.ts'
