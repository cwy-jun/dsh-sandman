// tests/persona-chat.test.mjs —— v3 新特性：馆长对话持久化 + 个性化指令（全局/工作区）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from '../.testbuild/store/db.js'
import { composeInjection, DEFAULT_INJECT_OPTS } from '../.testbuild/services/inject.js'

const TMP_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '.tmp')

function freshStore(t) {
  const dir = mkdtempSync(path.join(TMP_ROOT, 'persona-'))
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } })
  return new Store({ dbPath: path.join(dir, 't.db'), vaultDir: path.join(dir, 'vault') })
}

test('馆长对话：追加 / 按时序读回 / 清空 / 500 条滚动窗口', (t) => {
  const store = freshStore(t)
  store.appendCuratorChat('user', '第一问')
  store.appendCuratorChat('curator', '第一答', [{ id: 'm1', title: '来源卡' }])
  store.appendCuratorChat('user', '第二问')
  const items = store.listCuratorChat(50)
  assert.equal(items.length, 3)
  assert.deepEqual(items.map((i) => i.role), ['user', 'curator', 'user'])
  assert.deepEqual(JSON.parse(items[1].sources), [{ id: 'm1', title: '来源卡' }])

  // 滚动窗口：写 520 条后只剩最近 500 条
  for (let i = 0; i < 520; i++) store.appendCuratorChat('user', `刷屏 ${i}`)
  assert.equal(store.listCuratorChat(1000).length, 500)

  // 清空
  const cleared = store.clearCuratorChat()
  assert.ok(cleared >= 500)
  assert.equal(store.listCuratorChat(10).length, 0)
})

test('个性化：增删改 / 仅开关 / 注入命中与不命中', (t) => {
  const store = freshStore(t)
  store.upsertProject('nanjing', '南京文旅短视频', '南京文旅 16 条短视频（喜剧版）')

  // 全局 + 工作区
  const g = store.upsertPersonalization({ scope: 'global', content: '全局：交付单文件、不带 URL。' })
  const w = store.upsertPersonalization({ scope: 'workspace', workspace: '南京文旅短视频', match: '南京文旅,牛肉锅贴,锦宁', content: '工作区：台词纯人话，严禁网络梗整句。' })
  assert.equal(store.listPersonalization().length, 2)

  // 注入：命中「牛肉锅贴」→ 全局 + 工作区都在
  const hit = composeInjection(store, null, '帮我看看第 3 条牛肉锅贴的分镜', DEFAULT_INJECT_OPTS)
  assert.ok(hit.staticSection.includes('【个性化指令 · 用户指定】'))
  assert.ok(hit.staticSection.includes('交付单文件'))
  assert.ok(hit.staticSection.includes('台词纯人话'))

  // 注入：无关文本 → 只有全局
  const miss = composeInjection(store, null, '今天天气不错随便聊聊', DEFAULT_INJECT_OPTS)
  assert.ok(miss.staticSection.includes('交付单文件'))
  assert.ok(!miss.staticSection.includes('台词纯人话'))

  // 路由命中项目名 → 工作区注入
  const viaRoute = composeInjection(
    store,
    { scope: 'project', projectId: 'nanjing', confidence: 0.9 },
    '',
    DEFAULT_INJECT_OPTS,
  )
  assert.ok(viaRoute.staticSection.includes('台词纯人话'))

  // 仅开关（不带 content）
  const tog = store.upsertPersonalization({ id: w.id, enabled: false })
  assert.equal(tog.enabled, 0)
  assert.equal(tog.content, '工作区：台词纯人话，严禁网络梗整句。')
  const afterOff = composeInjection(store, null, '牛肉锅贴分镜', DEFAULT_INJECT_OPTS)
  assert.ok(!afterOff.staticSection.includes('台词纯人话'))

  // 删除
  assert.equal(store.deletePersonalization(g.id), true)
  assert.equal(store.listPersonalization().length, 1)
})
