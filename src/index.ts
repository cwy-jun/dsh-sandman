// index.ts —— 九层之台（dsh-sandman）薄入口：只负责注册与装配。
// M2-M6 总装：捕获引擎(turn-stopping) / 注入(systemPrompt 分段函数) / 三档做梦 / 馆长。
// 0.2.x 三类死法规避（交接文档血泪）：inject 留空全软等待；settings 用 describe/update
// 适配层 + volatile 投影；webServer 用 ctx.inject 延迟挂载；事件用 ctx.on('agent/turn-stopping')。
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, mkdirSync } from 'node:fs'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { Store } from './store/db.js'
import { Dreamer, DEFAULT_SCHEDULE } from './services/dreamer.js'
import { createCaptureService, type CaptureConfig } from './services/capture.js'
import { Curator, parseCuratorMode, type CuratorMode } from './services/curator.js'
import { composeInjection, DEFAULT_INJECT_OPTS } from './services/inject.js'
import { createSandmanApi, API_PREFIX } from './ui/api.js'
import { takeSnapshot } from './store/snapshot.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function readVersion(): string {
  for (const p of [path.join(HERE, 'package.json'), path.join(HERE, '..', 'package.json')]) {
    try {
      return JSON.parse(readFileSync(p, 'utf8')).version || '0.1.0'
    } catch {
      /* try next */
    }
  }
  return '0.1.0'
}

export const name = 'dsh-sandman'
export const inject = []

export const Config = z.object({
  enabled: z.boolean().default(true),
  dbPath: z.string().default(''),
  vaultDir: z.string().default(''),
  snapshotsDir: z.string().default(''),
  // ── 捕获（M2）──
  captureEnabled: z.boolean().default(true),
  captureMinChars: z.number().default(200),
  captureCooldownMs: z.number().default(120000),
  maxCapturesPerDay: z.number().default(60),
  // ── 注入（M3；默认关——旧记忆栈仍是注入通道，M7 迁移后打开）──
  injectEnabled: z.boolean().default(false),
  // ── 做梦三档（M4）──
  lightEveryTurns: z.number().default(DEFAULT_SCHEDULE.lightEveryTurns),
  deepIdleMinutes: z.number().default(DEFAULT_SCHEDULE.deepIdleMinutes),
  peakSuppress: z.boolean().default(DEFAULT_SCHEDULE.peakSuppress),
  peakWindows: z
    .array(z.object({ start: z.string().default('09:00'), end: z.string().default('12:00') }))
    .default(DEFAULT_SCHEDULE.peakWindows),
  peakLeadMinutes: z.number().default(DEFAULT_SCHEDULE.peakLeadMinutes),
  staleDays: z.number().default(DEFAULT_SCHEDULE.staleDays),
  staleHeatMax: z.number().default(DEFAULT_SCHEDULE.staleHeatMax),
  promoteHeat: z.number().default(DEFAULT_SCHEDULE.promoteHeat),
  // ── 画像预算 ──
  profileBudgetMax: z.number().default(30),
  profileBudgetChars: z.number().default(200),
  // ── 审核策略 ──
  auditMode: z.string().default('all'),
  autoApproveLowRiskLimit: z.number().default(3),
  // ── 馆长（M6）──
  curator: z
    .object({
      mode: z.string().default('dsh'),
      baseUrl: z.string().default(''),
      apiKey: z.string().default(''),
      model: z.string().default(''),
    })
    .default({}),
  dailyTokenBudget: z.number().default(100000),
})

try {
  Object.assign(Config.meta, { volatile: true })
} catch {
  /* meta 不可写时忽略 */
}

const SETTINGS_NS = 'sandman'

function createSettingsHandle(svc: any, configSchema: unknown, initialConfig: Record<string, unknown>, log: (m: string) => void) {
  if (svc && typeof svc.register === 'function') {
    return svc.register(SETTINGS_NS, configSchema, { base: initialConfig ?? {} })
  }
  if (!svc) return null
  try {
    const meta = (configSchema as { meta?: Record<string, unknown> })?.meta
    if (meta && meta.volatile !== true) meta.volatile = true
  } catch {
    /* ignore */
  }
  const live: Record<string, unknown> = { ...(initialConfig ?? {}) }
  const watchers = new Set<(cfg: Record<string, unknown>) => void>()
  const read = () => {
    if (typeof svc.describe !== 'function') return null
    let rows
    try {
      rows = svc.describe({ redactSecrets: true })
    } catch {
      return null
    }
    const row = Array.isArray(rows) ? rows.find((r: any) => r && r.ns === SETTINGS_NS) : null
    if (!row || !row.value) return null
    Object.assign(live, row.value)
    return live
  }
  read()
  return {
    get() {
      return read() ?? live
    },
    watch(cb: (cfg: Record<string, unknown>) => void) {
      watchers.add(cb)
      return () => watchers.delete(cb)
    },
    async update(patch: Record<string, unknown>) {
      if (typeof svc.update !== 'function') throw new Error('当前 DSH 设置服务不支持写配置')
      const result = await svc.update(SETTINGS_NS, patch)
      const next = read() ?? live
      for (const cb of [...watchers]) {
        try {
          cb(next)
        } catch (error) {
          log(`设置变更回调失败：${String((error as Error)?.message ?? error)}`)
        }
      }
      return result
    },
  }
}

interface Cfg {
  enabled: boolean
  dbPath: string
  vaultDir: string
  snapshotsDir: string
  captureEnabled: boolean
  captureMinChars: number
  captureCooldownMs: number
  maxCapturesPerDay: number
  injectEnabled: boolean
  lightEveryTurns: number
  deepIdleMinutes: number
  peakSuppress: boolean
  peakWindows: { start: string; end: string }[]
  peakLeadMinutes: number
  staleDays: number
  staleHeatMax: number
  promoteHeat: number
  profileBudgetMax: number
  profileBudgetChars: number
  auditMode: string
  autoApproveLowRiskLimit: number
  curator: Record<string, unknown>
  dailyTokenBudget: number
}

function normalizeCfg(raw: Record<string, unknown>): Cfg {
  const c = raw && typeof raw === 'object' ? raw : {}
  return {
    enabled: c.enabled !== false,
    dbPath: String(c.dbPath ?? ''),
    vaultDir: String(c.vaultDir ?? ''),
    snapshotsDir: String(c.snapshotsDir ?? ''),
    captureEnabled: c.captureEnabled !== false,
    captureMinChars: Number(c.captureMinChars ?? 200),
    captureCooldownMs: Number(c.captureCooldownMs ?? 120000),
    maxCapturesPerDay: Number(c.maxCapturesPerDay ?? 60),
    injectEnabled: c.injectEnabled === true,
    lightEveryTurns: Number(c.lightEveryTurns ?? 8),
    deepIdleMinutes: Number(c.deepIdleMinutes ?? 30),
    peakSuppress: c.peakSuppress !== false,
    peakWindows: Array.isArray(c.peakWindows) && c.peakWindows.length > 0
      ? (c.peakWindows as { start: string; end: string }[])
      : DEFAULT_SCHEDULE.peakWindows,
    peakLeadMinutes: Number(c.peakLeadMinutes ?? 15),
    staleDays: Number(c.staleDays ?? 30),
    staleHeatMax: Number(c.staleHeatMax ?? 0.05),
    promoteHeat: Number(c.promoteHeat ?? 0.5),
    profileBudgetMax: Number(c.profileBudgetMax ?? 30),
    profileBudgetChars: Number(c.profileBudgetChars ?? 200),
    auditMode: String(c.auditMode ?? 'all'),
    autoApproveLowRiskLimit: Number(c.autoApproveLowRiskLimit ?? 3),
    curator: c.curator && typeof c.curator === 'object' ? (c.curator as Record<string, unknown>) : { mode: 'dsh', baseUrl: '', apiKey: '', model: '' },
    dailyTokenBudget: Number(c.dailyTokenBudget ?? 100000),
  }
}

export function apply(ctx: any, config: Record<string, unknown> = {}) {
  const log = (msg: string) => {
    try {
      ctx.logger?.info?.(`dsh-sandman: ${msg}`)
    } catch {
      /* ignore */
    }
    console.log(`[dsh-sandman] ${msg}`)
  }

  let settings: ReturnType<typeof createSettingsHandle> | null = null
  const adoptSettings = (svc: unknown) => {
    try {
      settings = createSettingsHandle(svc, Config, config, log)
      if (settings) log('设置服务已接入（配置可在「设置 → 插件」里查看与修改）')
    } catch (error) {
      log(`设置服务不可用（改用静态配置）：${String((error as Error)?.message ?? error)}`)
    }
  }
  try {
    adoptSettings(ctx.get?.('settings'))
    ctx.inject(['settings'], (sctx: any) => adoptSettings(sctx.settings), 'dsh-sandman: settings')
  } catch (error) {
    log(`接入设置服务失败：${String((error as Error)?.message ?? error)}`)
  }

  const getCfg = (): Cfg => normalizeCfg(settings?.get?.() ? { ...config, ...settings.get() } : config)
  if (getCfg().enabled === false) {
    log('配置里 enabled=false，九层之台不启动')
    return
  }

  const home = process.env.DSH_HOME || ctx.baseDir || process.cwd()
  const cfg0 = getCfg()
  const dbPath = cfg0.dbPath || path.join(home, 'storages', 'dsh-sandman', 'sandman.db')
  const vaultDir = cfg0.vaultDir || path.join(home, 'memory-vault-sandman')
  const snapshotsDir = cfg0.snapshotsDir || path.join(home, 'storages', 'dsh-sandman', 'snapshots')
  mkdirSync(path.dirname(dbPath), { recursive: true })

  let store: Store
  try {
    store = new Store({ dbPath, vaultDir })
  } catch (error) {
    log(`记忆库打开失败：${String((error as Error)?.stack ?? error)}`)
    return
  }

  // ── 馆长（M6）：dsh 模式懒取宿主 llm 与模型路由（agentDefaultModel，memory-eternal M4 取证写法）──
  const curator = new Curator({
    getMode: (): CuratorMode => parseCuratorMode(getCfg().curator).mode,
    dailyBudget: () => getCfg().dailyTokenBudget,
    getLlm: () => {
      try {
        const sel = ctx.get?.('agentDefaultModel')?.currentSelection?.()
        const route = sel ? { provider: String(sel.provider ?? sel.id ?? ''), model: String(sel.model ?? '') } : null
        const llm = ctx.get?.('llm')
        if (!llm || !route) return null
        return { llm, route }
      } catch {
        return null
      }
    },
    log,
  })

  // ── 做梦引擎（M4）──
  const dreamer = new Dreamer(
    {
      store,
      schedule: () => ({
        lightEveryTurns: getCfg().lightEveryTurns,
        deepIdleMinutes: getCfg().deepIdleMinutes,
        peakSuppress: getCfg().peakSuppress,
        peakWindows: getCfg().peakWindows,
        peakLeadMinutes: getCfg().peakLeadMinutes,
        staleDays: getCfg().staleDays,
        staleHeatMax: getCfg().staleHeatMax,
        promoteHeat: getCfg().promoteHeat,
      }),
      snapshotsDir,
      vaultDir,
      curator,
      autoApproveLimit: () => getCfg().autoApproveLowRiskLimit,
      log,
    },
    undefined,
    Date.now(),
  )

  // ── 捕获引擎（M2）：门3 = 馆长快模型裁决，失败转人审 ──
  const capture = createCaptureService({
    store,
    getCfg: (): CaptureConfig => ({
      enabled: getCfg().captureEnabled,
      captureMinChars: getCfg().captureMinChars,
      captureCooldownMs: getCfg().captureCooldownMs,
      maxCapturesPerDay: getCfg().maxCapturesPerDay,
      auditMode: getCfg().auditMode,
      autoApproveLowRiskLimit: getCfg().autoApproveLowRiskLimit,
    }),
    gate3: async (cand, top) => {
      try {
        const out = await curator.chat({
          system: '你是记忆写门的第三道门。判断候选记忆与记忆库相似条目的关系。纪律：无充分理由时倾向 keep（保留每个事实，宁可多记不漏记）；仅高度雷同才 merge，明确无价值才 drop。只输出严格 JSON：{"decision":"keep|merge|drop","target_id":"相似条目id或省略","confidence":0~1,"reason":"一句话"}。',
          user: `候选：${cand.title}\n${cand.text.slice(0, 600)}\n\n相似条目：\n${top.map((t) => `${t.id}（相似度 ${t.sim.toFixed(2)}）`).join('\n')}`,
          maxTokens: 200,
          purpose: 'sandman-gate3',
        })
        const parsed = JSON.parse(out.match(/\{[\s\S]*\}/)?.[0] ?? '{}') as { decision?: string; target_id?: string; confidence?: number; reason?: string }
        const decision = ['keep', 'merge', 'drop'].includes(String(parsed.decision)) ? (parsed.decision as 'keep' | 'merge' | 'drop') : 'keep'
        return { decision, target_id: parsed.target_id, confidence: Number(parsed.confidence ?? 0.5), reason: String(parsed.reason ?? '') }
      } catch {
        return { decision: 'keep', confidence: 0.5, reason: '馆长不可用，转人审' }
      }
    },
    log,
  })
  try {
    capture.attach(ctx)
  } catch (error) {
    log(`捕获引擎挂载失败：${String((error as Error)?.message ?? error)}`)
  }

  const configBackend = {
    get: () => getCfg() as unknown as Record<string, unknown>,
    writable: !!settings,
    async update(patch: Record<string, unknown>) {
      if (!settings || typeof settings.update !== 'function') return { ok: false as const, error: '当前宿主不支持写配置' }
      const allowed = new Set([...Object.keys(Config.dict || {}), 'curator'])
      const clean: Record<string, unknown> = {}
      for (const key of Object.keys(patch || {})) if (allowed.has(key)) clean[key] = patch[key]
      if (Object.keys(clean).length === 0) return { ok: false as const, error: '无可写入字段' }
      try {
        await settings.update(clean)
        return { ok: true as const, applied: Object.keys(clean) }
      } catch (error) {
        return { ok: false as const, error: String((error as Error)?.message ?? error) }
      }
    },
  }

  // ── HTTP 面 ──
  const apiHandler = createSandmanApi({
    version: readVersion(),
    store,
    dreamer,
    snapshotsDir,
    configBackend,
    curator,
    capture,
    log,
  })
  try {
    ctx.inject(['webServer'], (webCtx: any) => {
      webCtx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler: apiHandler })
      log(`HTTP 面已挂载 ${API_PREFIX}（面板：${API_PREFIX}/ui/panel）`)
    }, 'dsh-sandman: api routes')
  } catch (error) {
    log(`挂载 HTTP 面失败：${String((error as Error)?.message ?? error)}`)
  }

  // ── 注入（M3）：systemPrompt 分段函数，宿主每轮现调，天然新鲜；injectEnabled 默认关 ──
  let disposeSection: (() => void) | null = null
  try {
    ctx.inject(['systemPrompt'], (spCtx: any) => {
      try {
        disposeSection = spCtx.systemPrompt.section({
          name: 'dsh-sandman: memory',
          order: 610,
          text: () => {
            const cfg = getCfg()
            if (!cfg.injectEnabled) return ''
            try {
              const plan = composeInjection(
                store,
                capture.state.lastRoute,
                capture.state.lastUserText,
                { ...DEFAULT_INJECT_OPTS, profileBudgetMax: cfg.profileBudgetMax, profileBudgetChars: cfg.profileBudgetChars },
              )
              return plan.staticSection
            } catch {
              return ''
            }
          },
        })
        log('注入分段已注册（injectEnabled=false 时静默，M7 迁移后打开）')
      } catch (error) {
        log(`注入提示词分段失败：${String((error as Error)?.message ?? error)}`)
      }
    }, 'dsh-sandman: prompt section')
  } catch (error) {
    log(`注册提示词分段失败：${String((error as Error)?.message ?? error)}`)
  }

  // ── agent 工具：sandman ──
  try {
    ctx.inject(['tools'], (toolCtx: any) => {
      toolCtx.tools.register(
        defineTool({
          name: 'sandman',
          description:
            '九层之台记忆系统工具。action="status" 总览；action="dream"（kind="light|deep|manual"）做梦；' +
            'action="snapshot" 快照；action="inject" 预览注入段；action="ask"（q="问题"）问馆长；' +
            'action="review"（kind="pending|failures"）看审核队列/失败记忆。',
          parameters: {
            action: { type: 'string', required: true, description: 'status | dream | snapshot | inject | ask | review' },
            kind: { type: 'string', description: 'dream: light|deep|manual；review: pending|failures' },
            q: { type: 'string', description: 'action="ask" 的问题' },
          },
          output: { schema: { type: 'string' }, render(_a: unknown, value: unknown) { return [{ type: 'text', text: String(value ?? '') }] } },
          timeoutMs: 120000,
          async execute(args: Record<string, unknown>) {
            const action = String(args.action || '').toLowerCase()
            if (action === 'status') {
              const c = store.counts()
              const b = curator.budget()
              return [
                `九层之台 v${readVersion()}：记忆 ${c.total}（画像 ${c.byLevel[0] ?? 0}/项目 ${c.byLevel[1] ?? 0}/文库 ${c.byLevel[2] ?? 0}/底档 ${c.byLevel[3] ?? 0}）· 项目域 ${c.projects}`,
                `捕获：${JSON.stringify(capture.stats)}`,
                `馆长：模式 ${parseCuratorMode(getCfg().curator).mode.kind} · 预算 ${b.used}/${b.limit} tok（自本次启动起，重启归零）`,
                `面板：${API_PREFIX}/ui/panel`,
              ].join('\n')
            }
            if (action === 'dream') {
              const kind = (['light', 'deep', 'manual'].includes(String(args.kind)) ? args.kind : 'manual') as 'light' | 'deep' | 'manual'
              const run = await dreamer.run(kind)
              return run ? `做梦完成（${kind}）：收据 #${run.id}。${run.receipt}` : '没抢到 dream_lock 或已有任务在跑。'
            }
            if (action === 'snapshot') {
              const s = takeSnapshot(store, snapshotsDir)
              return `快照已创建：${s.id}（含 ${(s.manifest.files as string[]).length} 个文件）`
            }
            if (action === 'inject') {
              const cfg = getCfg()
              const plan = composeInjection(store, capture.state.lastRoute, capture.state.lastUserText, {
                ...DEFAULT_INJECT_OPTS,
                profileBudgetMax: cfg.profileBudgetMax,
                profileBudgetChars: cfg.profileBudgetChars,
              })
              return `注入预览（${plan.stats.count} 条 · 约 ${plan.stats.tokens} tok · 开关 ${cfg.injectEnabled ? '开' : '关'}）：\n${plan.staticSection || '（空）'}`
            }
            if (action === 'ask') {
              const q = String(args.q ?? '').trim()
              if (!q) return '请提供 q 参数。'
              const out = await curator.ask(store, q)
              return `${out.answer}\n\n（来源：${out.sources.map((s) => s.title).join('、') || '无'}${out.usedModel ? '' : '；模型不可用，直引'}）`
            }
            if (action === 'review') {
              const kind = String(args.kind ?? 'pending')
              if (kind === 'failures') {
                const f = store.recentGatingFailures(10)
                return f.length ? f.map((r) => `- ${r.final_decision} @ ${new Date(Number(r.ts)).toLocaleString('zh-CN')}：${String(r.cand_hash).slice(0, 12)}`).join('\n') : '没有失败记忆。'
              }
              const p = store.listPending(20)
              return p.length ? p.map((m) => `- [${m.status}] ${m.title}（${m.id}）`).join('\n') : '审核队列空空如也。'
            }
            return '未知 action（可用：status | dream | snapshot | inject | ask | review）'
          },
        }),
      )
      log('工具 sandman 已注册')
    }, 'dsh-sandman: tool')
  } catch (error) {
    log(`注册工具失败：${String((error as Error)?.message ?? error)}`)
  }

  // ── 生命周期：定时器随插件卸载清理 ──
  ctx.effect?.(
    () => {
      dreamer.startIdleTimer()
      return () => {
        dreamer.stopIdleTimer()
        try {
          disposeSection?.()
        } catch {
          /* ignore */
        }
        try {
          store.close()
        } catch {
          /* ignore */
        }
      }
    },
    'dsh-sandman: lifecycle',
  )

  log(`九层之台已激活 v${readVersion()}（M2-M6 全量）：库 ${dbPath} · 镜像 ${vaultDir}`)
}
