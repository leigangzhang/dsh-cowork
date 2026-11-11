/**
 * The one TypeScript loader hook of this test suite.
 *
 * Import this module for its side effect, then load `src/**` modules with a
 * dynamic `await import('../src/foo.ts')`. The hook does two things:
 *  (a) a sibling specifier the build writes as `.js` is retried as `.ts`, so a
 *      module compiled with NodeNext specifiers is importable from source;
 *  (b) `.ts` sources are transformed (not strip-only), because the host
 *      composition uses TypeScript parameter properties.
 *
 * A static `import` of a `src` module is linked before this module's body can
 * register the hook, so a test that statically imports a module with `.js`
 * sibling specifiers still fails; every such test uses dynamic imports after
 * importing this module.
 */
import { register } from 'node:module'

const HOOK_SOURCE = [
  "import { readFileSync } from 'node:fs'",
  "import { stripTypeScriptTypes } from 'node:module'",
  "import { fileURLToPath } from 'node:url'",
  'export async function resolve(specifier, context, nextResolve) {',
  "  if (specifier.startsWith('.') && specifier.endsWith('.js')) {",
  "    try { return await nextResolve(specifier.slice(0, -3) + '.ts', context) } catch {}",
  '  }',
  '  return nextResolve(specifier, context)',
  '}',
  'export async function load(url, context, nextLoad) {',
  "  if (url.startsWith('file:') && url.endsWith('.ts')) {",
  "    const source = readFileSync(fileURLToPath(url), 'utf8')",
  "    return { format: 'module', shortCircuit: true, source: stripTypeScriptTypes(source, { mode: 'transform' }) }",
  '  }',
  '  return nextLoad(url, context)',
  '}',
].join('\n')

register(`data:text/javascript,${encodeURIComponent(HOOK_SOURCE)}`)
