import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import './support/ts-hook.mjs'

const {
  DIR_MODE,
  FILE_MODE,
  LOCK_WAIT_MS,
  LOCK_FILE_NAME,
  readTextIfPresent,
  withProjectLock,
  writeJsonAtomic,
} = await import('../src/store/atomic-json.ts')

/** One throwaway directory, removed even when the test fails. */
async function withTmp(run) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cowork-atomic-json-'))
  try {
    return await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('the shared modes and lock wait are the store contract', () => {
  assert.equal(FILE_MODE, 0o600)
  assert.equal(DIR_MODE, 0o700)
  assert.equal(LOCK_WAIT_MS, 5000)
  assert.equal(LOCK_FILE_NAME, '.write.lock')
})

test('writeJsonAtomic writes 0600 JSON with one trailing newline', async () => {
  await withTmp(async (dir) => {
    const file = join(dir, '.dsh-cowork', 'index.json')
    await writeJsonAtomic(file, { version: 2, topics: [] })
    const text = await readFile(file, 'utf8')
    assert.equal(text, '{\n  "version": 2,\n  "topics": []\n}\n')
    assert.equal((await stat(file)).mode & 0o777, FILE_MODE)
    assert.equal((await stat(join(dir, '.dsh-cowork'))).mode & 0o777, DIR_MODE)
  })
})

test('readTextIfPresent treats a missing file as absent and never swallows other failures', async () => {
  await withTmp(async (dir) => {
    assert.equal(await readTextIfPresent(join(dir, 'missing.json')), undefined)
    const file = join(dir, 'present.json')
    await writeFile(file, 'hello')
    assert.equal(await readTextIfPresent(file), 'hello')
    // A directory where a file belongs is not "absent": the caller must see it.
    await assert.rejects(() => readTextIfPresent(dir))
  })
})

test('withProjectLock serializes concurrent read-modify-write cycles', async () => {
  await withTmp(async (dir) => {
    const lockFile = join(dir, '.dsh-cowork', LOCK_FILE_NAME)
    const counter = join(dir, '.dsh-cowork', 'counter.json')
    await writeJsonAtomic(counter, 0)
    const bump = () => withProjectLock(lockFile, async () => {
      const current = await readTextIfPresent(counter)
      // Yield inside the critical section: without the lock both writers would
      // read 0 and the final value would be 1.
      await new Promise((resolve) => setImmediate(resolve))
      await writeJsonAtomic(counter, JSON.parse(current ?? '0') + 1)
    })
    await Promise.all([bump(), bump(), bump()])
    assert.equal(JSON.parse(await readFile(counter, 'utf8')), 3)
  })
})

test('the stores import the shared layer instead of restating it', async () => {
  // The retired M0 probe store is gone; every remaining store is listed here.
  const files = ['src/store/project-store.ts', 'src/store/notice-store.ts', 'src/store/request-store.ts']
  for (const file of files) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8')
    assert.match(source, /atomic-json\.js/, `${file} must import the shared atomic layer`)
    for (const restated of [
      /const FILE_MODE = /,
      /const DIR_MODE = /,
      /const LOCK_WAIT_MS = /,
      /async function fsyncDirectory\(/,
      /async function readTextIfPresent\(/,
    ]) {
      assert.equal(restated.test(source), false, `${file} must not restate ${restated}`)
    }
  }
})
