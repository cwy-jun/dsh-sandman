// scripts/make-demo-db.mjs —— 生成 README 截图用的全合成演示库（无任何真实用户数据）。
// 用法：node scripts/make-demo-db.mjs [输出目录]   默认输出到 tests/.demo/db
// 然后用 SANDMAN_DB 指向它起预览： SANDMAN_DB=<dir>/demo.db node scripts/preview-panel.mjs
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from '../.testbuild/store/db.js'
import { Dreamer } from '../.testbuild/services/dreamer.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const OUT = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'tests', '.demo')
const DIR = mkdtempSync(path.join(tmpdir(), 'sandman-demo-'))
mkdirSync(OUT, { recursive: true })

const store = new Store({ dbPath: path.join(DIR, 'demo.db'), vaultDir: path.join(DIR, 'vault') })

// ── 项目域（全虚构）──
store.upsertProject('shan-yue', '山月茶馆', '长篇小说《山月茶馆》：江南水乡背景，双时间线叙事。当前在人物小传阶段，十三章草稿已完成，下一步是配角方言校对。')
store.upsertProject('qi-xing', '城市骑行', '周末城市骑行记录：路线、装备、拍照点。春季目标是完成环湖线全程。')
for (const [p, t, w] of [
  ['shan-yue', '山月茶馆', 2], ['shan-yue', '人物小传', 1.5], ['shan-yue', '方言', 1], ['shan-yue', '双时间线', 1.5],
  ['qi-xing', '骑行', 2], ['qi-xing', '环湖线', 1.5], ['qi-xing', '装备', 1],
]) store.addLexicon(p, t, w)

// ── 画像层（F0）──
const f0 = [
  ['identity', '我是谁', '自由插画师，兼写小说。工作时段在上午，晚上只处理轻量事务。'],
  ['preference', '交付偏好', '单文件交付；先结论后展开；事实与推断分开标注。'],
  ['rule', '写作纪律', '初稿不回头改，一章写完再统一修订；引用必须可查证。'],
  ['goal', '年度目标', '今年完成《山月茶馆》全书初稿，并在秋季前完成环湖线骑行。'],
]
for (const [slot, title, content] of f0) store.insertMemory({ level: 0, slot, title, content, source: 'manual' }, 'system', '演示数据')

// ── 项目层（F1）──
const f1 = [
  ['shan-yue', 'structure', '章节结构', '全书四十章，分四卷。第一卷十三章草稿已完成。'],
  ['shan-yue', 'decision', '叙事视角', '定为双时间线交替：奇数章过去线，偶数章现在线。'],
  ['shan-yue', 'todo', '方言校对', '配角老掌柜的方言台词校对进行中，预计本周完成。'],
  ['shan-yue', 'ops', '素材管理', '参考照片按「场景-季节」两级目录存放。'],
  ['qi-xing', 'structure', '路线规划', '环湖线分四段，每段设一个补给点与一个拍照点。'],
  ['qi-xing', 'todo', '装备清单', '春季装备清单整理中，头盔与尾灯已到位。'],
]
for (const [pid, slot, title, content] of f1) store.insertMemory({ level: 1, slot, projectId: pid, title, content, source: 'manual' }, 'system', '演示数据')

// ── 文库层（F2）──
const f2 = [
  ['lesson', '教训：先分镜再写正文', '两次返工都来自正文写完才补分镜。今后任何叙事项目先出结构表。'],
  ['prompt', '好用的润色提示词', '先让模型列出这段文字的三个弱点，再逐条改，比直接润色效果好。'],
  ['norm', '命名规范', '项目文件用「日期_主题_版本」三段命名，日期取 yyMMdd。'],
  ['knowledge', '人物小传模板', '固定五栏：动机、恐惧、口癖、关系、秘密。写完再动笔。'],
]
for (const [slot, title, content] of f2) store.insertMemory({ level: 2, slot, title, content, source: 'manual' }, 'system', '演示数据')

// ── 底档（F3）──
const f3 = [
  ['初版开篇废稿', '第一章第一版废稿（2026-03）：开头从茶馆打烊写起，节奏太慢，弃用。'],
  ['环湖线第一段实测', '3 月 12 日实测：北岸 wind 大，春季需备防风外套；里程比预估多 4 公里。'],
  ['一次对话纪要', '与编辑讨论定稿节奏：先交前三章样章，再谈整体排期。'],
]
for (const [title, content] of f3) store.insertMemory({ level: 3, title, content, source: 'capture' }, 'system', '演示数据')

// ── 对话流水（馆长上下文演示）──
store.appendSessionTurn('demo-1', '山月茶馆的方言校对这周能弄完吗？', '按目前进度，周三前可以完成老掌柜部分，周五前全部收尾。', 'shan-yue')
store.appendSessionTurn('demo-1', '那下周就开始第十四章？', '可以。第十四章进入现在线，注意和第十三章结尾的时间衔接。', 'shan-yue')
store.appendSessionTurn('demo-2', '环湖线第二段的拍照点定在亭子里？', '亭子逆光，改到东北角的石阶更稳。', 'qi-xing')

// ── 模拟一轮深梦：时效改写 + 冲突仲裁 + 收据 ──
const fakeCurator = {
  judgeRewrite: async (m) => (m.content.includes('进行中')
    ? { outdated: true, newContent: m.content.replace('进行中，预计本周完成', '已完成于本周三'), reason: '对话证据显示已完成' }
    : { outdated: false, newContent: '', reason: '' }),
  judgeConflict: async () => ({ contradict: false, suggestion: 'merge', reason: '表述互补，不矛盾' }),
  proposeParams: async () => [{ param: 'lightEveryTurns', current: 8, suggested: 6, reason: '近期对话量大，轻梦可略加密' }],
  chat: async () => 'yes',
}
const dreamer = new Dreamer({
  store,
  schedule: () => ({ lightEveryTurns: 8, deepIdleMinutes: 30, peakSuppress: false, peakWindows: [], peakLeadMinutes: 15, staleDays: 30, staleHeatMax: 0.05, promoteHeat: 0.5 }),
  snapshotsDir: path.join(DIR, 'snaps'),
  vaultDir: store.vaultDir,
  curator: fakeCurator,
  autoApproveLimit: () => 0,
})
await dreamer.run('deep')
await dreamer.run('light')

// ── 复制产物到输出目录 ──
store.checkpoint()
const { copyFileSync } = await import('node:fs')
for (const suffix of ['', '-wal', '-shm']) {
  const src = path.join(DIR, 'demo.db' + suffix)
  try { copyFileSync(src, path.join(OUT, 'demo.db' + suffix)) } catch { /* wal/shm 可能不存在 */ }
}
console.log(`demo db → ${path.join(OUT, 'demo.db')}（配套 vault 在临时目录，截图足够）`)
store.close()
try { rmSync(DIR, { recursive: true, force: true }) } catch { /* Windows 句柄延迟释放，忽略残留 */ }
