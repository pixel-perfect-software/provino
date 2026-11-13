import type { WorkspacePackage } from './workspace.ts'

/**
 * The lifecycle scripts npm, pnpm, yarn and bun run on a user's machine when the package is
 * installed. Provino ships none (T10.4): a dependency that needs native code gets it from a
 * prebuilt binary package, and nothing here may run code at install time.
 */
export const INSTALL_SCRIPTS: readonly string[] = ['preinstall', 'install', 'postinstall']

/**
 * Every package.json in the workspace, the root's included, that has an install script. A
 * private package is checked too: the rule is the workspace's, so a script can't be added to
 * one and later copied into a published package unnoticed.
 * @internal
 */
export function installScriptProblems(packages: readonly WorkspacePackage[]): readonly string[] {
  return packages.flatMap((pkg) =>
    INSTALL_SCRIPTS.filter((name) => name in pkg.manifest.scripts).map(
      (name) => `${pkg.rel}/package.json has a "${name}" script: Provino ships no install scripts`,
    ),
  )
}
