import type {
  InlineSnapshotWriterFactory,
  ModuleRef,
  PolicyOverrides,
  SnapshotPrinterFactory,
} from '@provino/types'

/**
 * The refs `nativeSnapshotPolicy` takes: `NativeRuntimeRefs`' snapshot printer, and its inline
 * writer when it has one.
 * @public
 */
export interface NativeSnapshotRefs {
  readonly snapshotPrinter: ModuleRef<SnapshotPrinterFactory>
  readonly snapshotWriter?: ModuleRef<InlineSnapshotWriterFactory> | undefined
}

/**
 * The native runtime's snapshot slice (B28, D211): a project with no dialect writes the `.snap`
 * files Jest 30.5 writes, so a suite moved off Jest keeps its snapshots byte for byte. The format
 * keys are Jest's (header, the key and hint joins, the pretty-format options), held equal to
 * `jestPolicy.snapshot`'s by `@provino/harness`'s `native-snapshot-values.test.ts`, which also holds
 * that the neutral key function it keeps is the one Jest's slice resolves to. The printer and the
 * inline writer are the refs given (`null` for no writer: an inline snapshot that would be written
 * fails instead). Every other snapshot key stays the neutral policy's.
 * @public
 */
export function nativeSnapshotPolicy(
  refs: NativeSnapshotRefs,
): NonNullable<PolicyOverrides['snapshot']> {
  return {
    header: '// Jest Snapshot v1, https://jestjs.io/docs/snapshot-testing',
    keyJoin: ' ',
    hintJoin: ': ',
    format: { escapeString: false, printBasicPrototype: false, maxOutputLength: null, extra: {} },
    // D216 (compat): Jest fails a local run that leaves a snapshot obsolete; the neutral policy doesn't.
    obsolete: { failLocal: true, failCI: true },
    printer: refs.snapshotPrinter,
    inline: { indent: 'column0', writer: refs.snapshotWriter ?? null },
  }
}
