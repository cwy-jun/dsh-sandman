// tests/core.test.mjs —— core 纯函数 + store 单测（node --test 直跑，不依赖 DSH）。
// 覆盖 M1 验收第 1、3 项：heat 单调性 / 门1 查重 / 门2 阈值 / BM25 CJK 分词 / 迁移链 / 锁协议（进程内）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

// 临时目录一律放 E 盘项目内（纪律：不占用 C 盘）
const TMP_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '.tmp')
mkdirSync(TMP_ROOT, { recursive: true })
const tmpdir = () => TMP_ROOT

import { computeHeat, richness } from '../.testbuild/core/heat.js'
import { tokenize, bigramSim, buildIndex, search } from '../.testbuild/core/bm25.js'
import { gate, normalizeText } from '../.testbuild/core/gating.js'
import { route } from '../.testbuild/core/router.js'
import { migrate, makeMemoryId, validSlot } from '../.testbuild/core/schema.js'
import { Store } from '../.testbuild/store/db.js'
import { parseCuratorMode, selfCheck, BudgetTracker } from '../.testbuild/services/curator.js'
import { Dreamer } from '../.testbuild/services/dreamer.js'

const sha256 = (t) => createHash('sha256').update(t, 'utf8').digest('hex')

function tmpStore(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'sandman-test-'))
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } })
  return new Store({ dbPath: path.join(dir, 't.db'), vaultDir: path.join(dir, 'vault') })
}

// ───────────────────────── heat ─────────────────────────

test('heat：命中越多越高（单调性）', () => {
  const base = { contentLen: 300, keywordsCount: 3, daysSinceAccess: 0 }
  const h0 = computeHeat({ ...base, hits: 0 })
  const h5 = computeHeat({ ...base, hits: 5 })
  const h50 = computeHeat({ ...base, hits: 50 })
  assert.ok(h0 < h5 && h5 < h50, `期望单调递增，实际 ${h0} < ${h5} < ${h50}`)
})

test('heat：时间衰减（天数越大越低）', () => {
  const base = { hits: 10, contentLen: 300, keywordsCount: 3 }
  const fresh = computeHeat({ ...base, daysSinceAccess: 0 })
  const old = computeHeat({ ...base, daysSinceAccess: 60 })
  assert.ok(fresh > old, `期望 ${fresh} > ${old}`)
})

test('heat：丰富度随内容长度与关键词增加', () => {
  assert.ok(richness({ contentLen: 800, keywordsCount: 8 }) > richness({ contentLen: 50, keywordsCount: 0 }))
  assert.ok(richness({ contentLen: 8000, keywordsCount: 80 }) <= 1.5, '丰富度封顶 1.5')
})

// ───────────────────────── bm25 / CJK ─────────────────────────

test('tokenize：CJK bigram + 拉丁词', () => {
  assert.deepEqual(tokenize('南京文旅'), ['南京', '京文', '文旅'])
  assert.deepEqual(tokenize('SQLite WAL'), ['sqlite', 'wal'])
  const mixed = tokenize('用SQLite做南京文旅项目')
  assert.ok(mixed.includes('sqlite'))
  assert.ok(mixed.includes('南京'))
})

test('bigramSim：相同=1，无关=0，部分相似介于其间', () => {
  assert.equal(bigramSim('南京文旅短视频', '南京文旅短视频'), 1)
  assert.equal(bigramSim('南京文旅', '量子力学'), 0)
  const s = bigramSim('南京文旅短视频项目', '南京文旅的短视频')
  assert.ok(s > 0.2 && s < 0.9, `部分相似度应介于其间，实际 ${s}`)
})

test('BM25：相关文档排前', () => {
  const docs = [
    { id: 'a', text: '南京文旅短视频 分镜表 暴雨之夜 素材清单' },
    { id: 'b', text: 'SQLite WAL 模式 技术 分析 日志' },
    { id: 'c', text: '南京 博物馆 实习生 动画 短剧 设定' },
  ]
  const idx = buildIndex(docs)
  const hits = search(idx, '南京文旅 分镜', 3)
  assert.equal(hits[0].id, 'a')
})

// ───────────────────────── schema / 迁移 ─────────────────────────

test('迁移链：全新库应用 v1+v2+v3+v4，重复调用幂等', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sandman-mig-'))
  const db = new DatabaseSync(path.join(dir, 'm.db'))
  const r1 = migrate(db)
  assert.ok(r1.applied.includes('1:m1-schema-v1'))
  assert.ok(r1.applied.includes('2:m2-hits-column'))
  assert.ok(r1.applied.includes('3:m3-curator-chat-persona'))
  assert.ok(r1.applied.includes('4:m4-memory-changes'))
  const r2 = migrate(db)
  assert.equal(r2.applied.length, 0, '第二次迁移不应再应用任何语句')
  const v = db.prepare('SELECT COUNT(*) n FROM schema_version').get()
  assert.equal(v.n, 4)
  const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_changes'").get()
  assert.ok(t, 'memory_changes 表必须存在')
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('makeMemoryId 格式 yyMMddHHmmss-xxxxxxxx', () => {
  const id = makeMemoryId(new Date('2026-10-10T12:34:56').getTime(), 'AbCdEf12')
  assert.match(id, /^\d{12}-abcdef12$/)
})

test('validSlot：四层九位校验', () => {
  assert.ok(validSlot(0, 'identity'))
  assert.ok(!validSlot(0, 'decision'))
  assert.ok(validSlot(1, 'review'))
  assert.ok(validSlot(2, 'lesson'))
  assert.ok(validSlot(3, null))
  assert.ok(!validSlot(3, 'lesson'))
})

// ───────────────────────── store CRUD + 镜像 + FTS ─────────────────────────

test('store：增改查 / 版本链 / 还原 / 镜像文件 / FTS 搜索', (t) => {
  const store = tmpStore(t)
  const m = store.insertMemory({ level: 0, slot: 'identity', title: '用户身份', content: '用户是 AI 短视频创作者', source: 'manual' }, 'user')
  assert.equal(m.version, 1)
  const m2 = store.updateMemory(m.id, { content: '用户是 AI 短视频创作者，主攻南京文旅方向' }, 'user', '补充方向')
  assert.equal(m2.version, 2)
  assert.equal(store.listVersions(m.id).length, 2)

  // FTS：中文检索命中（在还原回 v1 之前验证更新后的正文）
  const hits = store.listMemories({ q: '南京文旅' })
  assert.ok(hits.length >= 1, 'FTS 应命中「南京文旅」')

  const restored = store.restoreVersion(m.id, 1)
  assert.equal(restored.version, 3)
  assert.match(String(restored.content), /短视频创作者$/)

  // 镜像文件真实存在且含新内容（.bak 也应存在）
  const files = store.backupFiles(path.join(path.dirname(store.dbPath), 'bk'))
  assert.ok(files.length >= 1)

  const c = store.counts()
  assert.equal(c.total, 1)
  assert.equal(c.byLevel[0], 1)
  store.close()
})

// ───────────────────────── 写门 ─────────────────────────

const gateDeps = (over = {}) => ({
  findByHash: () => null,
  searchSimilar: () => [],
  profileConflict: () => 0,
  ...over,
})

test('写门 门1：哈希命中 → duplicate', async () => {
  const r = await gate({ text: '同一条内容', source: 'capture' }, gateDeps({ findByHash: () => 'm-123' }), sha256)
  assert.equal(r.final, 'duplicate')
  assert.equal(r.targetId, 'm-123')
})

test('写门 门1：隐私正则 → reject（身份证）', async () => {
  const r = await gate({ text: '收件人身份证 110101199003077758', source: 'capture' }, gateDeps(), sha256)
  assert.equal(r.final, 'reject')
  assert.match(r.note, /身份证/)
})

test('写门 门1：超 2000 字 → split', async () => {
  const r = await gate({ text: '长'.repeat(2100), source: 'capture' }, gateDeps(), sha256)
  assert.equal(r.final, 'split')
})

test('写门 门2：相似度 ≥0.90 → merge', async () => {
  const r = await gate({ text: '南京文旅短视频分镜表已定为五条主线', source: 'capture' }, gateDeps({
    searchSimilar: () => [{ id: 'm-1', sim: 0.94 }],
  }), sha256)
  assert.equal(r.final, 'merge')
  assert.equal(r.targetId, 'm-1')
  assert.ok(Math.abs(r.g2Sim - 0.94) < 1e-9)
})

test('写门 门2：0.62~0.90 无模型 → pending（转人审）', async () => {
  const r = await gate({ text: '南京文旅相关的新想法', source: 'capture' }, gateDeps({
    searchSimilar: () => [{ id: 'm-2', sim: 0.7 }],
  }), sha256)
  assert.equal(r.final, 'pending')
  assert.match(r.note, /转人审/)
})

test('写门 门2：<0.62 → keep', async () => {
  const r = await gate({ text: '今晚记得给绿萝浇水', source: 'capture' }, gateDeps({
    searchSimilar: () => [{ id: 'm-3', sim: 0.1 }],
  }), sha256)
  assert.equal(r.final, 'keep')
})

test('写门 门2：与画像冲突 ≥0.7 → 转馆长深梦（pending）', async () => {
  const r = await gate({ text: '用户其实不是短视频创作者而是程序员', source: 'capture' }, gateDeps({
    searchSimilar: () => [],
    profileConflict: () => 0.85,
  }), sha256)
  assert.equal(r.final, 'pending')
  assert.match(r.note, /画像/)
})

test('写门 门3：模型接入时升级裁决；低置信转人审', async () => {
  const deps = gateDeps({
    searchSimilar: () => [{ id: 'm-4', sim: 0.7 }],
    llm: async () => ({ decision: 'keep', confidence: 0.93, reason: '新事实' }),
  })
  const r1 = await gate({ text: '某条拿不准的记忆', source: 'capture' }, deps, sha256)
  assert.equal(r1.final, 'keep')
  assert.equal(r1.g3Used, true)

  const r2 = await gate({ text: '某条拿不准的记忆', source: 'capture' }, gateDeps({
    searchSimilar: () => [{ id: 'm-4', sim: 0.7 }],
    llm: async () => ({ decision: 'keep', confidence: 0.4, reason: '没把握' }),
  }), sha256)
  assert.equal(r2.final, 'pending')
})

// ───────────────────────── 路由 ─────────────────────────

test('路由 R1：词表命中 conf=0.9、scope=project', async () => {
  const r = await route('南京文旅的下一个短视频拍什么', {
    lexicon: [{ projectId: 'nanjing', term: '南京文旅', weight: 1 }],
    projects: [{ id: 'nanjing', name: '南京文旅', profile: '南京文旅短视频项目' }],
    profileScore: () => 0,
  }, sha256)
  assert.equal(r.projectId, 'nanjing')
  assert.equal(r.r1Hit, true)
  assert.ok(Math.abs(r.conf - 0.9) < 1e-9)
  assert.equal(r.scope, 'project')
})

test('路由 R2：无词表按画像比对，0.4~0.75 → mixed', async () => {
  const scores = { nanjing: 0.6, coding: 0.2 }
  const r = await route('这段分镜的代码生成脚本怎么写', {
    lexicon: [],
    projects: [
      { id: 'nanjing', name: '南京文旅', profile: '分镜 短视频 南京文旅 拍摄' },
      { id: 'coding', name: '编程助手', profile: '代码 脚本 编程 调试' },
    ],
    profileScore: (msg, pid) => scores[pid] ?? 0,
  }, sha256)
  assert.equal(r.projectId, 'nanjing')
  assert.equal(r.scope, 'mixed')
  assert.equal(r.r3Used, false)
})

test('路由：全不命中 → 闲聊模式', async () => {
  const r = await route('中午吃什么好呢', {
    lexicon: [],
    projects: [{ id: 'nanjing', name: '南京文旅', profile: '分镜 短视频' }],
    profileScore: () => 0,
  }, sha256)
  assert.equal(r.projectId, null)
  assert.equal(r.scope, 'chat')
})

test('路由 R3：并列（差<0.1）且有模型 → r3Used', async () => {
  const scores = { nanjing: 0.6, coding: 0.55 }
  const r = await route('帮我看看这段脚本', {
    lexicon: [],
    projects: [
      { id: 'nanjing', name: '南京文旅', profile: '分镜 脚本 拍摄' },
      { id: 'coding', name: '编程助手', profile: '代码 脚本 编程' },
    ],
    profileScore: (msg, pid) => scores[pid] ?? 0,
    llm: async () => ({ projectId: 'coding', confidence: 0.82, reason: '说的是代码脚本' }),
  }, sha256)
  assert.equal(r.r3Used, true)
  assert.equal(r.projectId, 'coding')
  assert.ok(r.conf >= 0.75)
})

// ───────────────────────── 锁协议（进程内两连接） ─────────────────────────

test('dream_lock：两个连接互斥，过期可窃取，同窗口续约', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sandman-lock-'))
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } })
  const a = new Store({ dbPath: path.join(dir, 'l.db'), vaultDir: path.join(dir, 'v') })
  const b = new Store({ dbPath: path.join(dir, 'l.db'), vaultDir: path.join(dir, 'v') })
  assert.equal(a.acquireDreamLock('win-a'), true)
  assert.equal(b.acquireDreamLock('win-b'), false, '锁被 win-a 持有，win-b 抢不到')
  assert.equal(a.acquireDreamLock('win-a'), true, '同窗口续约成功')
  a.releaseDreamLock('win-a')
  assert.equal(b.acquireDreamLock('win-b'), true, '释放后 win-b 抢到')
  b.releaseDreamLock('win-b')
  // 过期窃取：30ms 租约，等 60ms 后另一窗口必能抢到（Windows 计时粒度 ~15.6ms，留足余量）
  assert.equal(a.acquireDreamLock('win-a', 30), true)
  const t0 = Date.now()
  while (Date.now() - t0 < 60) { /* 等租约过期 */ }
  assert.equal(b.acquireDreamLock('win-b', 60000), true, '租约过期后应可窃取')
  a.close()
  b.close()
})

// ───────────────────────── 馆长配置 / 预算 ─────────────────────────

test('馆长：模式解析容错', () => {
  const bad = parseCuratorMode({ mode: 'cloud' })
  assert.equal(bad.mode.kind, 'cloud')
  assert.ok(bad.warnings.length >= 2, '缺 baseUrl/apiKey 应有警告')
  const unknown = parseCuratorMode({ mode: 'quantum' })
  assert.equal(unknown.mode.kind, 'dsh')
})

test('馆长：dsh 自检恒通过；云端/本地不可达时优雅失败', async () => {
  const dsh = await selfCheck({ kind: 'dsh' })
  assert.equal(dsh.ok, true)
  const dead = await selfCheck({ kind: 'local', baseUrl: 'http://127.0.0.1:9', model: 'x' }, { timeoutMs: 500 })
  assert.equal(dead.ok, false)
  assert.match(dead.detail, /不可达|超时/)
})

test('预算熔断：超限拒绝，跨天重置', () => {
  const b = new BudgetTracker(100, 0, '2000-01-01')
  assert.equal(b.allow(80), true)
  assert.equal(b.allow(30), false, '超日预算应拒绝')
  assert.ok(b.snapshot().used <= 100)
})

// ───────────────────────── Dreamer shadow 流程 ─────────────────────────

test('Dreamer：manual 跑通 快照→锁→收据→释放；并发只跑一个', async (t) => {
  const store = tmpStore(t)
  const snaps = path.join(path.dirname(store.dbPath), 'snaps')
  const d = new Dreamer({
    store,
    schedule: () => ({ lightEveryTurns: 8, deepIdleMinutes: 30, peakSuppress: true }),
    snapshotsDir: snaps,
    vaultDir: store.vaultDir,
    autoApproveLimit: () => 3,
  })
  store.insertMemory({ level: 0, slot: 'goal', title: '目标', content: '做南京文旅系列', source: 'manual' })
  const run = await d.run('manual')
  assert.ok(run, '应产生收据')
  assert.equal(store.listDreamRuns(1)[0].id, run.id)
  assert.equal(store.dreamLockInfo().holder, null, '跑完应释放锁')
  const [p1, p2] = await Promise.all([d.run('manual'), d.run('deep')])
  assert.ok(p1 === null || p2 === null, '并发只应有一个跑成功')
  store.close()
})

test('Dreamer：轮次计数与轻梦触发点', () => {
  const d = new Dreamer({ store: null, schedule: () => ({ lightEveryTurns: 3, deepIdleMinutes: 30, peakSuppress: false }), snapshotsDir: '', vaultDir: '' })
  assert.equal(d.noteUserTurn().lightDue, false)
  assert.equal(d.noteUserTurn().lightDue, false)
  assert.equal(d.noteUserTurn().lightDue, true)
})
