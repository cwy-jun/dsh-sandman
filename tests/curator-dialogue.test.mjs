// tests/curator-dialogue.test.mjs —— v3 追加：项目对话流水 + 晋升提案 + 馆长对话带上下文。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from '../.testbuild/store/db.js'
import { createCaptureService } from '../.testbuild/services/capture.js'
import { Dreamer } from '../.testbuild/services/dreamer.js'
import { Curator, parseCuratorMode } from '../.testbuild/services/curator.js'

const TMP_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '.tmp')

function freshStore(t) {
  const dir = mkdtempSync(path.join(TMP_ROOT, 'dlg-'))
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } })
  return new Store({ dbPath: path.join(dir, 't.db'), vaultDir: path.join(dir, 'vault') })
}

test('对话流水：捕获落库 / 按项目过滤 / 滚动窗口', async (t) => {
  const store = freshStore(t)
  store.upsertProject('nanjing', '南京文旅短视频', '南京文旅 16 条短视频（喜剧版），盐水鸭与牛肉锅贴。')
  for (const [term, weight] of [['南京文旅', 2], ['牛肉锅贴', 2], ['锦宁', 1.5]]) store.addLexicon('nanjing', term, weight)

  const capture = createCaptureService({
    store,
    getCfg: () => ({ enabled: true, captureMinChars: 30, captureCooldownMs: 0, maxCapturesPerDay: 60, auditMode: 'all', autoApproveLowRiskLimit: 3 }),
  })
  const out = await capture.submitTurn({ sessionId: 's1', userText: '第 3 条牛肉锅贴的分镜怎么安排？锦宁的造型要统一月牙元素。', assistantText: '好的，月牙发簪、月牙金耳坠、指尖干面粉，全程统一。' })
  assert.ok(out, '捕获应有产出')
  const all = store.listSessionLog({ limit: 10 })
  assert.equal(all.length, 2)
  assert.deepEqual(all.map((r) => r.role), ['user', 'assistant'])
  assert.equal(all[0].project_id, 'nanjing', '路由命中项目域应写入流水')

  // 项目过滤
  const byProj = store.listSessionLog({ projectId: 'nanjing', limit: 10 })
  assert.equal(byProj.length, 2)
  assert.equal(store.listSessionLog({ projectId: '不存在', limit: 10 }).length, 0)

  // 滚动窗口 2000（user+assistant 各一行 → 1100 轮 = 2200 行 → 裁到 2000）
  for (let i = 0; i < 1100; i++) store.appendSessionTurn('s2', `刷 ${i}`, `答 ${i}`, null)
  assert.equal(store.listSessionLog({ limit: 5000 }).length, 2000)
})

test('晋升提案：底档高热记忆进深梦提案，采纳后升为文库', async (t) => {
  const store = freshStore(t)
  const m = store.insertMemory({ level: 3, title: '高频底档条目', content: '被频繁命中的明细内容，够热了。', status: 'active', source: 'capture' }, 'system')
  store.touchAccess(m.id, 50) // 拉高 heat
  store.recomputeAllHeat(Date.now())
  assert.ok(store.promoteCandidates(0.5, 3).length >= 1, '应有晋升候选')

  const curator = new Curator({ getMode: () => parseCuratorMode({ mode: 'dsh' }).mode, dailyBudget: () => 100000, getLlm: () => null })
  const dreamer = new Dreamer({
    store,
    schedule: () => ({ lightEveryTurns: 8, deepIdleMinutes: 30, peakSuppress: true, promoteHeat: 0.5 }),
    snapshotsDir: path.join(path.dirname(store.dbPath), 'snaps'),
    vaultDir: store.vaultDir,
    curator,
    autoApproveLimit: () => 3,
  })
  const run = await dreamer.run('deep')
  assert.equal(run.status, 'done')
  const promote = run.decisions.find((d) => d.action === 'promote')
  assert.ok(promote, '深梦应产出晋升提案')

  // 模拟审核采纳
  store.updateMemory(promote.target, { level: promote.toLevel, slot: promote.toSlot }, 'user', '采纳')
  const after = store.getMemory(String(promote.target))
  assert.equal(after.level, 2)
  assert.equal(after.slot, 'knowledge')
})

test('馆长问答带项目对话摘录（降级直引路径不炸）', async (t) => {
  const store = freshStore(t)
  store.appendSessionTurn('s1', '牛肉锅贴要多久？', '不超过 90 秒。', 'nanjing')
  const curator = new Curator({ getMode: () => parseCuratorMode({ mode: 'dsh' }).mode, dailyBudget: () => 100000, getLlm: () => null })
  const out = await curator.ask(store, '牛肉锅贴限时多少？', [], '用户：牛肉锅贴要多久？\n助手：不超过 90 秒。')
  assert.ok(out.answer.length > 0)
  assert.equal(out.usedModel, false, '无宿主模型时应降级直引')
})
