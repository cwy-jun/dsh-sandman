// tests/lock.test.mjs —— M1 验收第 3 项：两个进程同时抢 dream_lock，恰好一个成功。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from '../.testbuild/store/db.js'

// 临时目录一律放 E 盘项目内（纪律：不占用 C 盘）
const TMP_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '.tmp')
mkdirSync(TMP_ROOT, { recursive: true })

const run = promisify(execFile)
const HERE = path.dirname(fileURLToPath(import.meta.url))

test('dream_lock 双进程互斥：恰好一个成功', async (t) => {
  const dir = mkdtempSync(path.join(TMP_ROOT, 'sandman-lock2p-'))
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } })
  const db = path.join(dir, 'lock.db')
  const init = new Store({ dbPath: db, vaultDir: path.join(dir, 'v') })
  init.close()

  const child = path.join(HERE, 'lock_child.mjs')
  const [r1, r2] = await Promise.all([
    run(process.execPath, [child, db, 'win-A'], { cwd: HERE }),
    run(process.execPath, [child, db, 'win-B'], { cwd: HERE }),
  ])
  const results = [JSON.parse(r1.stdout.trim()), JSON.parse(r2.stdout.trim())]
  const acquired = results.filter((r) => r.acquired)
  assert.equal(acquired.length, 1, `两进程抢锁应恰好一个成功：${JSON.stringify(results)}`)
  assert.ok(['win-A', 'win-B'].includes(acquired[0].windowId))
})
