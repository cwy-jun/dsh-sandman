// tests/seed.mjs —— 合成数据生成器（规格见《九层之台-M1详细设计》第 4 节）。
// 用法：node tests/seed.mjs [--serve]
//   默认只造数据；--serve 额外起独立 HTTP 服务（默认 19398 端口，PORT 环境变量可改）。
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from '../.testbuild/store/db.js'
import { Dreamer } from '../.testbuild/services/dreamer.js'
import { Curator, parseCuratorMode } from '../.testbuild/services/curator.js'
import { createCaptureService } from '../.testbuild/services/capture.js'
import { createSandmanApi } from '../.testbuild/ui/api.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SANDBOX = path.join(ROOT, 'tests', '.sandbox')
const DB = path.join(SANDBOX, 'sandman.db')
const VAULT = path.join(SANDBOX, 'vault')
const SNAPS = path.join(SANDBOX, 'snapshots')
const CONFIG = path.join(SANDBOX, 'config.json')

const DEFAULT_CONFIG = {
  enabled: true,
  dbPath: DB,
  vaultDir: VAULT,
  snapshotsDir: SNAPS,
  lightEveryTurns: 8,
  deepIdleMinutes: 30,
  peakSuppress: true,
  profileBudgetMax: 30,
  profileBudgetChars: 200,
  auditMode: 'all',
  autoApproveLowRiskLimit: 3,
  curator: { mode: 'dsh', baseUrl: '', apiKey: '', model: '' },
  dailyTokenBudget: 100000,
}

function freshStore() {
  mkdirSync(SANDBOX, { recursive: true })
  return new Store({ dbPath: DB, vaultDir: VAULT })
}

function seed(store) {
  const out = { f0: 0, f1: 0, f2: 0, f3: 0, projects: 0, lexicon: 0 }

  // ── 项目域 3 个（各带 80~150 字画像文 + 词表）──
  const projects = [
    {
      id: 'nanjing', name: '南京文旅',
      profile: '南京文旅短视频项目：五条主线（历史遗迹、博物馆、秦淮河、市井烟火、时令活动）。每条视频 40 到 60 秒，先要分镜表再出片。常用素材目录分三处：分镜表、暴雨之夜、素材三目录。',
      lexicon: [['南京文旅', 2], ['分镜', 1], ['短视频', 1], ['秦淮河', 1], ['博物馆', 1], ['南京', 0.5]],
    },
    {
      id: 'coding', name: '编程助手',
      profile: '编程助手项目：DSH 插件开发（TypeScript + esbuild）、SQLite 排错、PowerShell 自动化脚本。关注 0.2.x 兼容性、pnpm 硬链接、node:sqlite。',
      lexicon: [['插件', 1], ['SQLite', 1], ['esbuild', 1], ['DSH', 1], ['代码', 0.5], ['node:sqlite', 1]],
    },
    {
      id: 'life', name: '生活杂记',
      profile: '生活杂记：日常琐事、购物清单、家务安排、观影记录。与创作和编程无关的闲聊归这里。',
      lexicon: [['购物', 1], ['家务', 1], ['观影', 1], ['浇水', 0.5]],
    },
  ]
  for (const p of projects) {
    store.upsertProject(p.id, p.name, p.profile)
    out.projects++
    for (const [term, weight] of p.lexicon) {
      store.addLexicon(p.id, term, weight)
      out.lexicon++
    }
  }

  // ── 画像 F0：12 条（四格各 3）──
  const f0 = [
    ['identity', '用户身份', '用户是 AI 短视频内容创作者，同时推进多条创作主线。'],
    ['identity', '创作主线', '在做的系列：博物馆实习生打工记动画短剧、南京文旅短视频、见傩 App 设计作业。'],
    ['identity', '工作方式', '用户是代码小白，从没做过代码项目，要求 AI 发挥主观能动性。'],
    ['preference', '沟通偏好', '结论先行、结构化输出（表格/编号）、大白话解释、删除冗余与道歉。'],
    ['preference', '交付偏好', '单文件交付；报告类产出按项目归档。'],
    ['preference', '决策偏好', '涉及改配置、装插件、动系统时先给方案与风险，等拍板再动手。'],
    ['rule', '文件规矩', '文件不放桌面；尽量不占用 C 盘空间。'],
    ['rule', '删除规矩', '删除/清理类操作只接受审计报告 + Dry-Run 脚本 + 分级方案。'],
    ['rule', '改动规矩', '改插件源码必须先备份，先删后拷断开 pnpm 硬链接。'],
    ['goal', '近期目标', '做南京文旅系列短视频，100 集规模，先出分镜表。'],
    ['goal', '项目目标', '完善 DSH 记忆插件：能自动记、能后台整理、人能直接看和改。'],
    ['goal', '学习目标', '以九层之台为第一个代码项目，最终开源发布到 GitHub。'],
  ]
  for (const [slot, title, content] of f0) {
    store.insertMemory({ level: 0, slot, title, content, keywords: [], source: 'manual' }, 'system', '合成数据')
    out.f0++
  }

  // ── 项目记忆 F1：30 条（A12 / B10 / C8），五子位分布 ──
  const f1 = [
    // A 南京文旅 ×12（含一对近义 2 条 + 1 条与画像冲突）
    ['nanjing', 'structure', '五条主线已定', '南京文旅短视频定为五条主线：历史遗迹、博物馆、秦淮河、市井烟火、时令活动。'],
    ['nanjing', 'structure', '素材三目录', '素材分三目录存放：100 集分镜表、暴雨之夜、素材三目录。'],
    ['nanjing', 'structure', '素材三目录（旧口径）', '素材按三个目录管理：一百集分镜表目录、暴雨之夜目录、素材三目录。'],
    ['nanjing', 'decision', '片长决策', '每条视频 40 到 60 秒，竖屏 9:16，先做分镜再出片。'],
    ['nanjing', 'decision', '发布节奏', '每周至少三更，节令题材提前一周拍。'],
    ['nanjing', 'decision', '色调基调', '整体走青绿山水色调，呼应只此青绿审美。'],
    ['nanjing', 'todo', '待办：分镜表', '还差第 13 到 20 集的分镜表没写。'],
    ['nanjing', 'todo', '待办：素材补拍', '暴雨之夜缺夜景空镜，等一个雨夜去秦淮河补拍。'],
    ['nanjing', 'todo', '待办：文案', '100 条短视频文案已完成 45 条，还差 55 条。'],
    ['nanjing', 'ops', '操作流程', '出片流程：文案 → 分镜 → 生图 → 剪辑 → 配乐 → 发布。'],
    ['nanjing', 'ops', '工具链', '生图用本地文生图；剪辑用剪映；字幕用识别后手改。'],
    ['nanjing', 'review', '阶段复盘', '十月上旬完成 12 集，数据最好的是博物馆系列，完播率 38%。'],
    // B 编程助手 ×10
    ['coding', 'structure', 'DSH 运行时', 'DSH 桌面端运行时 0.2.0-rc.2，宿主机端口 19387。'],
    ['coding', 'structure', '插件架构', '九层之台采用薄入口 + core/services/store/ui 单向依赖五层。'],
    ['coding', 'structure', '构建链', 'esbuild 打包单文件产物；core 层零宿主依赖可独立单测。'],
    ['coding', 'decision', '存储选型', '存储用 node:sqlite（WAL）+ Markdown 镜像，不引入向量库。'],
    ['coding', 'decision', '0.2.x 规避', 'inject 留空全软等待；不用 settings.register；webServer 延迟挂载。'],
    ['coding', 'decision', '锁协议', '深梦用 dream_lock 单行租约锁，60 秒租约过期可窃取。'],
    ['coding', 'todo', '待办：M2', 'M2 接捕获引擎：turn-stopping 事件订阅 → 候选 → 写门。'],
    ['coding', 'todo', '待办：M3', 'M3 接路由：项目判定 + 下钻 + 契合度过滤。'],
    ['coding', 'ops', '调试纪律', '改动先备份；先删后拷断硬链接；改完 node --check + 哈希校验。'],
    ['coding', 'review', '血泪复盘', 'PowerShell 管道处理中文 UTF-8 会烧成乱码且不可逆，一律用 node。'],
    // C 生活杂记 ×8
    ['life', 'structure', '家务轮值', '每周三扫地、周六拖地，绿萝每五天浇一次水。'],
    ['life', 'decision', '观影决定', '周末观影清单：卧虎藏龙、千里江山图纪录片。'],
    ['life', 'todo', '待办：采购', '补货：宣纸、墨锭、猫粮、咖啡滤纸。'],
    ['life', 'todo', '待办：快递', '周二取快递，单号尾号 3321。'],
    ['life', 'ops', '记账流程', '月底导出账单，分类标注：创作、生活、数码。'],
    ['life', 'ops', '收纳规矩', '换季衣物放床底箱，标签朝外。'],
    ['life', 'review', '月度复盘', '十月上半月创作时间占比 60%，家务拖欠两项。'],
    ['life', 'structure', '厨房清单', '常用调料十二种，老抽快没了记得补。'],
  ]
  for (const [pid, slot, title, content] of f1) {
    store.insertMemory({ level: 1, slot, projectId: pid, title, content, keywords: [], source: 'manual' }, 'system', '合成数据')
    out.f1++
  }

  // ── 文库 F2：10 条（教训4/提示词3/规范2/知识1）──
  const f2 = [
    ['lesson', '教训：插件安装', '装 DSH 插件必须显式指定版本号，否则解析到旧版会被兼容性守卫整单回滚。'],
    ['lesson', '教训：LLM 静默失败', 'llm.stream() 失败不抛异常，只回 finish/error；静默 bug 先查这里。'],
    ['lesson', '教训：token 预算', '蒸馏提示词要求的字数必须小于 maxTokens 预算，否则 JSON 中途截断静默丢弃。'],
    ['lesson', '教训：Session 事件', '0.2.x 的 Session 没有 events 数组，只有 snapshotEvents()。'],
    ['prompt', '提示词：分镜', '分镜提示词公式：主体+动作+场景+光线+色调+镜头运动+画质词。'],
    ['prompt', '提示词：生图', '生图必写用途与风格参照；青绿山水风格加石青石绿关键词。'],
    ['prompt', '提示词：改图', '改图描述要保留不变的部分，只写要改的部分。'],
    ['norm', '规范：命名', '文件命名：用途主题-具体动作.扩展名，全中文，去随机后缀。'],
    ['norm', '规范：备份', '备份必须 db+wal+shm 三件一起，只拷 .db 等于没拷。'],
    ['knowledge', '知识：BM25', 'BM25 是词频饱和 + 文档长度归一的检索打分，适合 CJK bigram 分词。'],
  ]
  for (const [slot, title, content] of f2) {
    store.insertMemory({ level: 2, slot, title, content, keywords: [], source: 'manual' }, 'system', '合成数据')
    out.f2++
  }

  // ── 底档 F3：60 条原子事实流水（其中 5 条与 F1 内容完全重复，测门1 查重）──
  const f3Base = [
    '十月三日装了插件市场，版本 1.66.6。',
    '十月二日把 DSH 家目录从 C 盘迁到 D 盘。',
    '九月二十八日南京文旅第一条视频发布，点赞破千。',
    '九月三十日剪辑工程文件按项目整理归档。',
    '十月五日梦见分镜表自动生成的插件，醒来记了三页纸。',
  ]
  const dupSources = store.listMemories({ level: 1, limit: 5 })
  let n = 0
  for (const m of dupSources) {
    store.insertMemory({ level: 3, title: `流水-重复样例${++n}`, content: String(m.content), source: 'capture' }, 'system', '合成数据：与 F1 重复，测写门门1')
    out.f3++
  }
  for (let i = 0; i < 55; i++) {
    store.insertMemory({ level: 3, title: `流水-${String(i + 1).padStart(2, '0')}`, content: `${f3Base[i % f3Base.length]}（第 ${Math.floor(i / f3Base.length) + 1} 周记录）`, source: 'capture' }, 'system', '合成数据')
    out.f3++
  }

  // ── 对话回放脚本 30 轮（A12 / B10 / C5 / 闲聊3），M3 路由回放用 ──
  const replay = []
  const turns = [
    ...Array.from({ length: 12 }, (_, i) => ({ project: 'nanjing', msg: `南京文旅第 ${i + 1} 集的分镜怎么安排` })),
    ...Array.from({ length: 10 }, (_, i) => ({ project: 'coding', msg: `这个插件的 SQLite 表结构帮我看看第 ${i + 1} 处` })),
    ...Array.from({ length: 5 }, (_, i) => ({ project: 'life', msg: `购物清单第 ${i + 1} 项买好了吗` })),
    ...Array.from({ length: 3 }, (_, i) => ({ project: null, msg: `今天天气不错，随便聊聊 ${i + 1}` })),
  ]
  for (const t of turns) replay.push(t)
  writeFileSync(path.join(SANDBOX, 'replay30.json'), JSON.stringify(replay, null, 2), 'utf8')
  return out
}

async function main() {
  const fresh = !existsSync(DB)
  const store = freshStore()
  let counts = store.counts()
  if (fresh || counts.total === 0) {
    const out = seed(store)
    console.log(`[seed] 已生成合成数据：画像 ${out.f0} · 项目 ${out.f1} · 文库 ${out.f2} · 底档 ${out.f3} · 项目域 ${out.projects} · 词表 ${out.lexicon}`)
    writeFileSync(CONFIG, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8')
  } else {
    console.log(`[seed] 库已存在（${counts.total} 条），跳过重建。删 ${DB} 可重建。`)
  }
  counts = store.counts()
  console.log(`[seed] 当前总量 ${counts.total}，分布：`, JSON.stringify(counts.byLevel))
  store.close()

  if (process.argv.includes('--serve')) {
    const port = Number(process.env.PORT || 19398)
    const { createServer } = await import('node:http')
    const store2 = freshStore()
    const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'))
    const log = (m) => console.log(`[serve] ${m}`)
    const curator = new Curator({
      getMode: () => parseCuratorMode(cfg.curator ?? {}).mode,
      dailyBudget: () => Number(cfg.dailyTokenBudget ?? 100000),
      getLlm: () => null, // 沙箱无宿主；问答/增强自动降级为规则
      log,
    })
    const dreamer = new Dreamer({
      store: store2,
      schedule: () => ({ lightEveryTurns: Number(cfg.lightEveryTurns ?? 8), deepIdleMinutes: Number(cfg.deepIdleMinutes ?? 30), peakSuppress: cfg.peakSuppress !== false }),
      snapshotsDir: SNAPS,
      vaultDir: VAULT,
      curator,
      autoApproveLimit: () => Number(cfg.autoApproveLowRiskLimit ?? 3),
      log,
    })
    const capture = createCaptureService({
      store: store2,
      getCfg: () => ({
        enabled: cfg.captureEnabled !== false,
        captureMinChars: Number(cfg.captureMinChars ?? 200),
        captureCooldownMs: Number(cfg.captureCooldownMs ?? 120000),
        maxCapturesPerDay: Number(cfg.maxCapturesPerDay ?? 60),
        auditMode: cfg.auditMode ?? 'all',
        autoApproveLowRiskLimit: Number(cfg.autoApproveLowRiskLimit ?? 3),
      }),
      log,
    })
    const configBackend = {
      get: () => cfg,
      writable: true,
      async update(patch) {
        Object.assign(cfg, patch)
        writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), 'utf8')
        return { ok: true, applied: Object.keys(patch) }
      },
    }
    const handler = createSandmanApi({ version: '0.2.0-sandbox', store: store2, dreamer, snapshotsDir: SNAPS, configBackend, curator, capture, log })
    const server = createServer(handler)
    server.listen(port, '127.0.0.1', () => {
      console.log(`[serve] 九层之台沙箱已启动（M2-M6 全量）：`)
      console.log(`[serve]   面板  http://127.0.0.1:${port}/dsh-sandman/api/ui/panel`)
      console.log(`[serve]   总览  http://127.0.0.1:${port}/dsh-sandman/api/overview`)
    })
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
