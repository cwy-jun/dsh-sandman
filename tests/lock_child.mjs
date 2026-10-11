// tests/lock_child.mjs —— 锁协议测试的子进程：抢锁 → 持有 2 秒 → 释放。
// 用法：node tests/lock_child.mjs <dbPath> <windowId>
import path from 'node:path'
import { Store } from '../.testbuild/store/db.js'

const [, , dbPath, windowId] = process.argv
const store = new Store({ dbPath, vaultDir: path.join(path.dirname(dbPath), 'vault-' + windowId) })
const acquired = store.acquireDreamLock(windowId, 10000)
console.log(JSON.stringify({ windowId, acquired }))
if (acquired) {
  setTimeout(() => {
    store.releaseDreamLock(windowId)
    store.close()
    process.exit(0)
  }, 2000)
} else {
  store.close()
  process.exit(0)
}
