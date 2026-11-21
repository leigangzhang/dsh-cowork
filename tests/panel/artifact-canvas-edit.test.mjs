import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import {
  PROJECT_ID,
  SESSION,
  createHarness,
  jsonOf,
  makeFile,
  makeRecord,
  sha256,
} from '../support/artifact-fixtures.mjs'

/**
 * Canvas edits are opaque scenes: a stale base must return 409 instead of the
 * line-level three-way merge used for prose. This file owns that one route
 * branch because `artifact-api.test.mjs` is at its test-file line budget.
 */

const SCENE = JSON.stringify({
  type: 'excalidraw',
  version: 2,
  elements: [
    { id: 'rect-1', type: 'rectangle', x: 10, y: 10, width: 100, height: 60 },
    { id: 'rect-2', type: 'rectangle', x: 200, y: 10, width: 100, height: 60 },
  ],
  appState: { viewBackgroundColor: '#ffffff' },
  files: {},
}, null, 2)

const CANVAS_PATH = 'docs/scene.excalidraw'
const ARTIFACT = 'artifact-22222222-2222-4222-8222-222222222222'

/** SHA-256 of one UTF-8 text. */
function digest(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Seed one canvas work item with a saved revision 1. */
async function withCanvasHarness(operation) {
  const harness = await createHarness({ files: { [CANVAS_PATH]: SCENE } })
  try {
    await harness.runtime().store.createRecord(makeRecord({
      artifactId: ARTIFACT,
      projectId: PROJECT_ID,
      ownerSessionId: SESSION,
      title: 'Scene',
      type: 'canvas',
      files: [makeFile({
        path: CANVAS_PATH,
        mediaType: 'application/json',
        editable: true,
        size: Buffer.byteLength(SCENE),
        sha256: digest(SCENE),
        fsVersion: digest(SCENE),
        revision: 1,
      })],
      primaryPath: CANVAS_PATH,
    }))
    await harness.runtime().store.saveRevision(ARTIFACT, 1, SCENE)
    return await operation(harness)
  } finally {
    await harness.cleanup()
  }
}

/** One canvas edit body with a stale browser base. */
function editBody(content) {
  return {
    sessionId: SESSION,
    artifactId: ARTIFACT,
    path: CANVAS_PATH,
    baseRevision: 1,
    baseVersion: digest(SCENE),
    content,
  }
}

test('a canvas save with a stale base returns 409 and never line-merges', async () => {
  await withCanvasHarness(async (harness) => {
    const modelScene = SCENE.replace('"x": 200', '"x": 240')
    await writeFile(join(harness.repoPath, CANVAS_PATH), modelScene)

    const response = await harness.request('/api/cowork.artifact.edit', {
      method: 'POST',
      body: editBody(SCENE.replace('"x": 10', '"x": 40')),
    })
    assert.equal(response.status, 409)
    const body = await jsonOf(response)
    assert.equal(body.error.code, 'artifact/version-conflict')
    assert.deepEqual(body.conflictRanges, [{ startLine: 1, endLine: SCENE.split('\n').length }])

    // Reconciliation may bump the observed record revision, but no user text
    // (and no merged line) may reach the scene.
    assert.equal(await harness.runtime().files.readText(CANVAS_PATH).then((read) => read.content), modelScene)
  })
})

test('a canvas save with the current base writes directly', async () => {
  await withCanvasHarness(async (harness) => {
    const next = SCENE.replace('"x": 10', '"x": 40')
    const body = await jsonOf(await harness.request('/api/cowork.artifact.edit', {
      method: 'POST',
      body: editBody(next),
    }))
    assert.equal(body.ok, true)
    assert.equal(body.merged, false)
    assert.equal(body.content, next)
    assert.equal(body.revision, 2)
    assert.equal(await harness.runtime().files.readText(CANVAS_PATH).then((read) => read.content), next)
  })
})
