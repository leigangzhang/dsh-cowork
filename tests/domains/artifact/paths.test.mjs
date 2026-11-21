import test from 'node:test'
import assert from 'node:assert/strict'
import { artifactPaths } from '../../support/artifact-fixtures.mjs'

/**
 * The lexical path rules are the first trust boundary: a work item may only
 * register a project-relative file, never an absolute path, an escape, a
 * control-character spelling, the internal directories, or a credential file.
 */
test('a normal project-relative path passes unchanged', () => {
  assert.deepEqual(artifactPaths.normalizeArtifactPath('docs/spec.md'), { ok: true, path: 'docs/spec.md' })
  assert.deepEqual(artifactPaths.normalizeArtifactPath('  docs/spec.md  '), { ok: true, path: 'docs/spec.md' })
  assert.deepEqual(artifactPaths.normalizeArtifactPath('a/b/c.md'), { ok: true, path: 'a/b/c.md' })
})

test('every escape and separator spelling is rejected', () => {
  const cases = [
    [null, 'path must be a string'],
    ['', 'path must not be empty'],
    ['   ', 'path must not be empty'],
    ['x'.repeat(501), 'at most 500'],
    ['/etc/passwd', 'project-relative'],
    ['\\\\server\\share', 'project-relative'],
    ['C:/windows', 'project-relative'],
    ['a\\b.md', 'POSIX separators'],
    ['a/\u0000b', 'control characters'],
    ['docs/', 'must not end with a separator'],
    ['a//b', 'empty'],
    ['a/./b', '"."'],
    ['a/../b', '".."'],
    ['.git/config', 'must not enter .git'],
    ['x/.dsh-cowork/index.json', 'must not enter .dsh-cowork'],
    ['config/.env', 'credential'],
    ['.env.local', 'credential'],
    ['secrets/id_rsa', 'credential'],
    ['secrets/ID_ED25519', 'credential'],
  ]
  for (const [input, expected] of cases) {
    const result = artifactPaths.normalizeArtifactPath(input)
    assert.equal(result.ok, false, `expected ${String(input)} to be rejected`)
    assert.ok(result.reason.includes(expected), `expected reason for ${String(input)} to mention ${expected}, got ${result.reason}`)
  }
})

test('the extension maps to the frozen artifact type', () => {
  const cases = {
    'a.md': 'text',
    'a.markdown': 'text',
    'a.mdx': 'text',
    'a.txt': 'text',
    'a.rst': 'text',
    'a.html': 'html',
    'a.htm': 'html',
    'a.csv': 'table',
    'a.tsv': 'table',
    'a.xlsx': 'table',
    'a.xls': 'table',
    'a.mmd': 'diagram',
    'a.mermaid': 'diagram',
    'a.puml': 'diagram',
    'a.plantuml': 'diagram',
    'a.dot': 'diagram',
    'a.excalidraw': 'canvas',
    'a.pdf': 'pdf',
    'a.png': 'image',
    'a.jpg': 'image',
    'a.jpeg': 'image',
    'a.webp': 'image',
    'a.gif': 'image',
    'a.svg': 'image',
    'a.doc': 'doc',
    'a.docx': 'doc',
    'no-extension': 'other',
    'a.unknown': 'other',
    '.hidden': 'other',
  }
  for (const [path, type] of Object.entries(cases)) {
    assert.equal(artifactPaths.inferArtifactType(path), type, path)
  }
})

test('the extension maps to a media type and unknown files fall back to octets', () => {
  assert.equal(artifactPaths.inferMediaType('a.md'), 'text/markdown')
  assert.equal(artifactPaths.inferMediaType('a.html'), 'text/html')
  assert.equal(artifactPaths.inferMediaType('a.excalidraw'), 'application/json')
  assert.equal(artifactPaths.inferMediaType('a.png'), 'image/png')
  assert.equal(artifactPaths.inferMediaType('a.unknown'), 'application/octet-stream')
  assert.equal(artifactPaths.artifactExtension('dir.with.dot/file'), '')
  assert.equal(artifactPaths.artifactExtension('dir/file.MD'), '.md')
})

test('only the six design types are editable and only text media is text', () => {
  for (const type of ['text', 'doc', 'table', 'diagram', 'canvas', 'html']) {
    assert.equal(artifactPaths.isEditableArtifactType(type), true, type)
  }
  for (const type of ['pdf', 'image', 'other']) {
    assert.equal(artifactPaths.isEditableArtifactType(type), false, type)
  }
  assert.equal(artifactPaths.isTextMediaType('text/markdown'), true)
  assert.equal(artifactPaths.isTextMediaType('application/json'), true)
  assert.equal(artifactPaths.isTextMediaType('text/vnd.graphviz'), true)
  assert.equal(artifactPaths.isTextMediaType('image/svg+xml'), false)
  assert.equal(artifactPaths.isTextMediaType('application/pdf'), false)
})
