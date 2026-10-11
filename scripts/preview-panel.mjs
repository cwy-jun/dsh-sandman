// scripts/preview-panel.mjs —— 面板视觉预览：真库副本 + 只读 API，供浏览器开 http://127.0.0.1:19397/dsh-sandman/api/ui/panel
// 用法：SANDMAN_DB=<你的 sandman.db 路径> node scripts/preview-panel.mjs
//      （Ctrl+C 退出；数据库会被复制到临时目录，只读不动原件）
import { mkdtempSync, copyFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import { Store } from '../.testbuild/store/db.js'
import { Dreamer } from '../.testbuild/services/dreamer.js'
import { Curator, parseCuratorMode } from '../.testbuild/services/curator.js'
import { createSandmanApi } from '../.testbuild/ui/api.js'

const SRC_DB = process.env.SANDMAN_DB
if (!SRC_DB || !existsSync(SRC_DB)) {
  console.error('请用 SANDMAN_DB 环境变量指定 sandman.db 路径，例如：\n  SANDMAN_DB=/path/to/sandman.db node scripts/preview-panel.mjs\n或先用 node scripts/make-demo-db.mjs 生成演示库。')
  process.exit(1)
}
const dir = mkdtempSync(path.join(tmpdir(), 'sandman-preview-'))
for (const suffix of ['', '-wal', '-shm']) {
  const src = SRC_DB + suffix
  if (existsSync(src)) copyFileSync(src, path.join(dir, 'preview.db' + suffix))
}
const store = new Store({ dbPath: path.join(dir, 'preview.db'), vaultDir: path.join(dir, 'vault') })
const cfg = { curator: { mode: 'dsh' }, dailyTokenBudget: 100000, profileBudgetMax: 30, profileBudgetChars: 200, captureEnabled: true, injectEnabled: true, lightEveryTurns: 8, deepIdleMinutes: 30, peakSuppress: true }
const curator = new Curator({ getMode: () => parseCuratorMode(cfg.curator).mode, dailyBudget: () => cfg.dailyTokenBudget, getLlm: () => null })
const dreamer = new Dreamer({ store, schedule: () => ({ lightEveryTurns: 8, deepIdleMinutes: 30, peakSuppress: true, peakWindows: [], peakLeadMinutes: 15, staleDays: 30, staleHeatMax: 0.05, promoteHeat: 0.5 }), snapshotsDir: path.join(dir, 'snaps'), vaultDir: store.vaultDir, curator, autoApproveLimit: () => 3 })
const configBackend = { get: () => cfg, writable: false, async update() { return { ok: false, error: '预览模式只读' } } }
const handler = createSandmanApi({ version: 'preview', store, dreamer, snapshotsDir: path.join(dir, 'snaps'), configBackend, curator, capture: null })
const server = createServer(handler)
server.listen(19397, '127.0.0.1', () => console.log('preview → http://127.0.0.1:19397/dsh-sandman/api/ui/panel（Ctrl+C 退出）'))
