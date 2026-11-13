import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUILD_INFO_FILE, writeBuildInfo } from './lib-build-info.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(root, BUILD_INFO_FILE)
mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, `${JSON.stringify(writeBuildInfo(root), null, 2)}\n`, 'utf8')
console.log(`build-info: wrote ${BUILD_INFO_FILE}`)
