// tests/m4-v4.test.mjs —— v4 机制：时效改写 / 冲突仲裁 / 显著性地板 / 留痕链
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { Store } from '../.testbuild/store/db.js'
import { Dreamer } from '../.testbuild/services/dreamer.js'
import { Curator, parseCuratorMode } from '../.testbuild/services/curator.js'
import { createCaptureService } from '../.testbuild/services/capture.js'
import { createSandmanApi } from '../.testbuild/ui/api.js'

const TMP_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '.tmp')
mkdirSync(TMP_ROOT, { recursive: true })

function tmpStore(t) {
  const dir = mkdtempSync(path.join(TMP_ROOT, 'sandman-v4-'))
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } })
  return { dir, store: new Store({ dbPath: path.join(dir, 't.db'), vaultDir: path.join(dir, 'vault') }) }
}

const SCHEDULE = { lightEveryTurns: 8, deepIdleMinutes: 30, peakSuppress: false, peakWindows: [], peakLeadMinutes: 15, staleDays: 30, staleHeatMax: 0.05, promoteHeat: 0.5 }

/** 假馆长：duck-type 真 Curator 的 v4 接口（dreamer 只用 judgeRewrite/judgeConflict/proposeParams） */
function fakeCurator(behavior = {}) {
  return {
    judgeRewrite: behavior.judgeRewrite ?? (async () => null),
    judgeConflict: behavior.judgeConflict ?? (async () => null),
    proposeParams: async () => null,
    chat: async () => 'yes',
    available: async () => true,
    budget: () => ({ day: 't', used: 0, limit: 100000 }),
    reinforce: () => {},
    ask: async () => ({ answer: '', sources: [], usedModel: false }),
  }
}

test('v4 迁移：memory_changes 表存在且地板保护生效（画像层不被冷化候选命中）', async (t) => {
  const { store } = tmpStore(t)
  t.after(() => store.close())
  const prof = store.insertMemory({ level: 0, slot: 'preference', title: '老偏好', content: '用户长期偏好，永不因时间被冷化。', source: 'manual' })
  const proj = store.insertMemory({ level: 1, slot: 'ops', title: '旧操作', content: '某项目里早已不用的操作步骤记录。', source: 'manual' })
  const old = Date.now() - 40 * 86400000
  store.db.prepare('UPDATE memories SET last_accessed_at = ?, heat = 0.01 WHERE id IN (?, ?)').run(old, prof.id, proj.id)
  const cands = store.staleCandidates(30, 0.05, 10)
  assert.ok(cands.some((m) => m.id === proj.id), '项目层低热度老记忆应进冷化候选')
  assert.ok(!cands.some((m) => m.id === prof.id), '画像层必须被地板保护挡住')
})

test('v4：时间敏感候选只收含时间表述的画像/项目层记忆', async (t) => {
  const { store } = tmpStore(t)
  t.after(() => store.close())
  store.insertMemory({ level: 1, slot: 'todo', title: '锅贴推进', content: '第3条牛肉锅贴（≤90s）推进中：工艺链必须清晰呈现。', source: 'manual' })
  store.insertMemory({ level: 1, slot: 'ops', title: '永恒规范', content: '画面禁任何手写字。', source: 'manual' })
  store.insertMemory({ level: 3, title: '底档进行时', content: '这条底档也在推进中，但底档不参与时效改写。', source: 'manual' })
  const cands = store.timeSensitiveCandidates(10)
  assert.equal(cands.length, 1)
  assert.equal(cands[0].title, '锅贴推进')
})

test('v4：冲突对只在 [minSim,maxSim) 区间，近重复不越界', async (t) => {
  const { store } = tmpStore(t)
  t.after(() => store.close())
  // 实测 bigramSim = 0.800（同主题修正型：禁项清单相同，表述与附加要求不同）
  const a = store.insertMemory({ level: 1, slot: 'ops', title: '画面禁项·旧', content: '画面禁任何手写字大字梗字后期字幕弹幕角标，场景必须高端。', source: 'manual' })
  const b = store.insertMemory({ level: 1, slot: 'ops', title: '画面禁项·新', content: '不要任何手写字大字梗字后期字幕弹幕角标，场景高端。', source: 'manual' })
  store.insertMemory({ level: 1, slot: 'ops', title: '画面禁项·旧·副本', content: '画面禁任何手写字大字梗字后期字幕弹幕角标，场景必须高端。', source: 'manual' }) // 近重复 sim≥0.9
  const pairs = store.findConflictPairs(0.5, 0.9, 10)
  assert.ok(pairs.length >= 1, '应找到疑似矛盾对')
  const target = pairs.find((p) => [p.a.id, p.b.id].sort().join() === [a.id, b.id].sort().join())
  assert.ok(target, 'A-B（同主题修正型，实测 sim≈0.79）应被收进仲裁候选')
  for (const p of pairs) {
    assert.ok(p.sim >= 0.5 && p.sim < 0.9, `相似度 ${p.sim} 必须落在仲裁区间`)
  }
  // 内容完全相同的近重复对（A-C 实测 sim≈0.98 ≥ 0.9）必须被排除，交给"近重复合并"步骤管
  const dupPair = pairs.find((p) => p.a.content === p.b.content)
  assert.ok(!dupPair, '内容完全相同的近重复对（sim≥0.9）不应混入仲裁候选')
})

test('v4：留痕写入与读取（改写 old→new 成对）', async (t) => {
  const { store } = tmpStore(t)
  t.after(() => store.close())
  const m = store.insertMemory({ level: 1, slot: 'todo', title: 'T', content: '旧文本', source: 'manual' })
  store.recordMemoryChange({ memoryId: m.id, changeType: 'rewrite', oldContent: '旧文本', newContent: '新文本', reason: '测试', dreamRunId: 42 })
  const items = store.listMemoryChanges(10)
  assert.equal(items.length, 1)
  assert.equal(items[0].change_type, 'rewrite')
  assert.equal(items[0].old_content, '旧文本')
  assert.equal(items[0].new_content, '新文本')
  assert.equal(items[0].dream_run_id, 42)
})

test('v4 深梦：馆长判过期 → 改写入库 + memory_changes 留痕 + 决议含 rewrite', async (t) => {
  const { dir, store } = tmpStore(t)
  t.after(() => store.close())
  store.appendSessionTurn('s1', '锅贴那条已经拍完交付了。', '收到，已记录交付状态。', 'nanjing')
  const m = store.insertMemory({ level: 1, slot: 'todo', projectId: 'nanjing', title: '锅贴进度', content: '第3条牛肉锅贴推进中，工艺链待拍摄。', source: 'manual' })
  const curator = fakeCurator({
    judgeRewrite: async () => ({ outdated: true, newContent: '第3条牛肉锅贴已交付完成，工艺链呈现完毕。', reason: '对话证据显示已交付' }),
  })
  const dreamer = new Dreamer({ store, schedule: () => SCHEDULE, snapshotsDir: path.join(dir, 'snaps'), vaultDir: store.vaultDir, curator, autoApproveLimit: () => 0 })
  const run = await dreamer.run('deep')
  assert.equal(run.status, 'done')
  const after = store.getMemory(m.id)
  assert.match(after.content, /已交付完成/, '记忆内容应被改写')
  assert.ok(after.version >= 2, '改写应产生新版本')
  const changes = store.listMemoryChanges(10)
  assert.equal(changes.length, 1)
  assert.equal(changes[0].memory_id, m.id)
  assert.match(changes[0].old_content, /推进中/)
  assert.match(changes[0].new_content, /已交付完成/)
  assert.ok(changes[0].dream_run_id > 0, '留痕应挂到本次做梦 run id')
  assert.ok(run.decisions.some((d) => d.action === 'rewrite' && d.target === m.id))
  assert.match(run.receipt, /时效改写 1 条/)
})

test('v4 深梦：馆长判矛盾 → 只产提案不执行（审核制）', async (t) => {
  const { dir, store } = tmpStore(t)
  t.after(() => store.close())
  // bigramSim ≈ 0.800，落在仲裁区间 [0.5,0.9)，不会被"近重复合并"（≥0.9）抢先收走
  store.insertMemory({ level: 1, slot: 'ops', title: '画面禁项·旧', content: '画面禁任何手写字大字梗字后期字幕弹幕角标，场景必须高端。', source: 'manual' })
  store.insertMemory({ level: 1, slot: 'ops', title: '画面禁项·新', content: '不要任何手写字大字梗字后期字幕弹幕角标，场景高端。', source: 'manual' })
  const curator = fakeCurator({
    judgeConflict: async () => ({ contradict: true, suggestion: 'keep-b', reason: '新规取代旧规' }),
  })
  const dreamer = new Dreamer({ store, schedule: () => SCHEDULE, snapshotsDir: path.join(dir, 'snaps'), vaultDir: store.vaultDir, curator, autoApproveLimit: () => 0 })
  const run = await dreamer.run('deep')
  assert.equal(run.status, 'done')
  const resolve = run.decisions.filter((d) => d.type === 'proposal' && d.action === 'resolve')
  assert.equal(resolve.length, 1)
  assert.equal(resolve[0].suggestion, 'keep-b')
  // 提案未采纳前，两条记忆都还在 active（没有自动执行）
  const actives = store.listMemories({ status: 'active', limit: 10 })
  assert.equal(actives.filter((m) => m.title.startsWith('画面禁项')).length, 2)
})

test('v4 API：/changes 返回留痕；采纳仲裁提案 → 输家归档 + 留痕', async (t) => {
  const dir = mkdtempSync(path.join(TMP_ROOT, 'sandman-v4api-'))
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } })
  const store = new Store({ dbPath: path.join(dir, 't.db'), vaultDir: path.join(dir, 'vault') })
  t.after(() => store.close())
  const cfg = { curator: { mode: 'dsh' }, dailyTokenBudget: 100000, profileBudgetMax: 30, profileBudgetChars: 200 }
  const curator = new Curator({ getMode: () => parseCuratorMode(cfg.curator).mode, dailyBudget: () => cfg.dailyTokenBudget, getLlm: () => null })
  const fake = fakeCurator({ judgeConflict: async () => ({ contradict: true, suggestion: 'keep-b', reason: '新规矩取代' }) })
  const dreamer = new Dreamer({ store, schedule: () => SCHEDULE, snapshotsDir: path.join(dir, 'snaps'), vaultDir: store.vaultDir, curator: fake, autoApproveLimit: () => 0 })
  const capture = createCaptureService({ store, getCfg: () => ({ enabled: false, captureMinChars: 30, captureCooldownMs: 0, maxCapturesPerDay: 60, auditMode: 'all', autoApproveLowRiskLimit: 0 }) })
  const configBackend = { get: () => cfg, writable: true, async update(p) { Object.assign(cfg, p); return { ok: true, applied: Object.keys(p) } } }
  const handler = createSandmanApi({ version: 'test', store, dreamer, snapshotsDir: path.join(dir, 'snaps'), configBackend, curator, capture })
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}/dsh-sandman/api`
  const get = async (p) => (await fetch(base + p)).json()
  const post = async (p, b) => (await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}) })).json()

  const a = store.insertMemory({ level: 1, slot: 'ops', title: '画面禁项·旧', content: '画面禁任何手写字大字梗字后期字幕弹幕角标，场景必须高端。', source: 'manual' })
  const b = store.insertMemory({ level: 1, slot: 'ops', title: '画面禁项·新', content: '不要任何手写字大字梗字后期字幕弹幕角标，场景高端。', source: 'manual' })
  await post('/dream/run', { kind: 'deep' })

  const signals = await get('/signals')
  const prop = signals.items.find((i) => i.proposal.action === 'resolve')
  assert.ok(prop, '应产出仲裁提案')

  const changesBefore = await get('/changes')
  assert.equal(changesBefore.ok, true)

  const dec = await post('/signals/decide', { runId: prop.runId, index: prop.index, action: 'adopt' })
  assert.equal(dec.ok, true)
  assert.equal(store.getMemory(a.id).status, 'archived', 'keep-b → A 归档')
  assert.equal(store.getMemory(b.id).status, 'active', 'B 保留')
  const changes = await get('/changes')
  const arb = changes.items.find((c) => c.change_type === 'arbitrate')
  assert.ok(arb, '仲裁归档应留痕')
  assert.equal(arb.memory_id, a.id)
})
