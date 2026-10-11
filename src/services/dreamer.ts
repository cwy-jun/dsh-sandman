// services/dreamer.ts —— 三档做梦引擎（M4 实装）。
// 微巩固：每轮免费代码规则（查重/计数/热度，随捕获与注入自然发生）。
// 轻梦：每 N 轮异步；规则信号恒产（近重复/归属建议/积压告警），有馆长模型时增强判断；只产信号不写语义库。
// 深梦：空闲≥30min / 手动 / 工具触发；快照→锁→裁决→收据→DREAMS.md；唯一写库闸门。
// 纪律：永不物理删除；任何模型失败降级规则；收据可回放（input_hash + decisions 全留痕）。
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import type { Store, MemoryRow } from '../store/db.js'
import { Store as StoreClass } from '../store/db.js'
import { takeSnapshot } from '../store/snapshot.js'
import type { Curator } from './curator.js'

export interface PeakWindow {
  /** "HH:MM"，本地时间 */
  start: string
  end: string
}

export interface DreamSchedule {
  lightEveryTurns: number
  deepIdleMinutes: number
  peakSuppress: boolean
  /** 峰时抑制时段（默认 09-12、14-18，对齐 API 峰谷电价峰时；可配） */
  peakWindows: PeakWindow[]
  /** 每个峰时开始前 N 分钟也不触发（默认 15） */
  peakLeadMinutes: number
  /** 冷化标准：N 天未活跃且 heat 低于阈值 → stale（可配，馆长可调） */
  staleDays: number
  staleHeatMax: number
  /** 晋升提案阈值：底档记忆 heat ≥ 此值时，深梦产出"晋升文库"提案（默认 0.5） */
  promoteHeat: number
}

export const DEFAULT_SCHEDULE: DreamSchedule = {
  lightEveryTurns: 8,
  deepIdleMinutes: 30,
  peakSuppress: true,
  peakWindows: [
    { start: '09:00', end: '12:00' },
    { start: '14:00', end: '18:00' },
  ],
  peakLeadMinutes: 15,
  staleDays: 30,
  staleHeatMax: 0.05,
  promoteHeat: 0.5,
}

export interface Signal {
  type: 'signal'
  kind: 'merge' | 'assign' | 'pending-backlog'
  a?: string
  b?: string
  memoryId?: string
  projectId?: string
  sim?: number
  why: string
  conf: number
}

export interface DreamAction {
  type: 'action' | 'proposal'
  action?: string
  resolved?: boolean
  target?: string
  note?: string
  param?: string
  current?: number
  suggested?: number
  reason?: string
  why?: string
  conf?: number
  toLevel?: number
  toSlot?: string
  /** 冲突仲裁建议（judgeConflict 产出，审核队列"采纳"时执行） */
  suggestion?: 'keep-a' | 'keep-b' | 'merge'
  /** 时效改写的 old→new 摘要（留痕视图展示用） */
  oldText?: string
  newText?: string
}

export interface DreamRunSummary {
  id: number
  kind: 'light' | 'deep' | 'manual'
  status: 'done' | 'interrupted' | 'shadow'
  receipt: string
  decisions: (DreamAction | Signal)[]
}

export interface DreamerDeps {
  store: Store
  schedule: () => DreamSchedule
  snapshotsDir: string
  vaultDir: string
  curator?: Curator | null
  /** 审核策略：建议模式的小额自动批上限 */
  autoApproveLimit?: () => number
  log?: (msg: string) => void
}

export class Dreamer {
  readonly windowId: string
  private turns = 0
  private lastUserActivityAt: number
  private running: Promise<DreamRunSummary | null> | null = null
  private deepTimer: ReturnType<typeof setInterval> | null = null
  private lastDeepAt = 0
  private log: (msg: string) => void

  constructor(private deps: DreamerDeps, windowId?: string, now: number = Date.now()) {
    this.windowId = windowId ?? `win-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
    this.lastUserActivityAt = now
    this.log = deps.log ?? (() => {})
  }

  // ───────────────────────── 调度面 ─────────────────────────

  noteUserTurn(now: number = Date.now()): { turns: number; lightDue: boolean } {
    this.turns++
    this.lastUserActivityAt = now
    const due = this.turns % Math.max(1, this.deps.schedule().lightEveryTurns) === 0
    if (due) this.run('light', now).catch((e) => this.log(`轻梦失败：${String((e as Error)?.message ?? e)}`))
    return { turns: this.turns, lightDue: due }
  }

  idleMs(now: number = Date.now()): number {
    return now - this.lastUserActivityAt
  }

  /** 当前是否处于峰时抑制（任一窗口 [start-lead, end) 内，本地时间） */
  isPeakHour(now: number = Date.now()): boolean {
    const sched = this.deps.schedule()
    if (!sched.peakSuppress) return false
    const d = new Date(now)
    const cur = d.getHours() * 60 + d.getMinutes()
    for (const w of sched.peakWindows ?? []) {
      const [sh, sm] = String(w.start ?? '0:0').split(':').map((x) => parseInt(x, 10))
      const [eh, em] = String(w.end ?? '0:0').split(':').map((x) => parseInt(x, 10))
      const s = sh * 60 + (sm || 0) - Math.max(0, sched.peakLeadMinutes ?? 0)
      const e = eh * 60 + (em || 0)
      if (cur >= s && cur < e) return true
    }
    return false
  }

  /** 空闲深梦定时器（宿主内启动；60s 粒度） */
  startIdleTimer() {
    if (this.deepTimer) return
    this.deepTimer = setInterval(() => {
      const now = Date.now()
      if (now - this.lastDeepAt < 5 * 60 * 1000) return
      if (this.isPeakHour(now)) return
      if (this.idleMs(now) >= this.deps.schedule().deepIdleMinutes * 60_000) {
        this.lastDeepAt = now
        this.run('deep', now).catch((e) => this.log(`空闲深梦失败：${String((e as Error)?.message ?? e)}`))
      }
    }, 60_000)
  }

  stopIdleTimer() {
    if (this.deepTimer) clearInterval(this.deepTimer)
    this.deepTimer = null
  }

  // ───────────────────────── 执行面 ─────────────────────────

  async run(kind: 'light' | 'deep' | 'manual', now: number = Date.now()): Promise<DreamRunSummary | null> {
    if (this.running) return null
    this.running = kind === 'light' ? this.runLight(now) : this.runDeep(kind, now)
    try {
      return await this.running
    } finally {
      this.running = null
    }
  }

  /** 轻梦：产信号不写库 */
  private async runLight(now: number): Promise<DreamRunSummary> {
    const store = this.deps.store
    const signals: Signal[] = []
    for (const pair of store.findNearDuplicates(0.9, 10)) {
      signals.push({ type: 'signal', kind: 'merge', a: pair.a.id, b: pair.b.id, sim: pair.sim, why: `近重复（相似度 ${pair.sim.toFixed(2)}）：${pair.a.title} ↔ ${pair.b.title}`, conf: pair.sim })
    }
    for (const sug of store.suggestProjectAssignments(0.65, 10)) {
      signals.push({ type: 'signal', kind: 'assign', memoryId: sug.memory.id, projectId: sug.projectId, sim: sug.sim, why: `「${sug.memory.title}」高度疑似属于项目，建议归档`, conf: sug.sim })
    }
    const backlog = store.listPending(200).filter((m) => m.status === 'pending').length
    if (backlog >= 5) signals.push({ type: 'signal', kind: 'pending-backlog', why: `审核队列积压 ${backlog} 条，建议尽快处理或调大自动批`, conf: 1 })

    let enhanced = 0
    const curator = this.deps.curator
    if (curator && signals.length > 0) {
      // 馆长增强：只对拿不准的（conf 0.62~0.9）信号做模型复核
      for (const s of signals) {
        if (s.conf >= 0.62 && s.conf < 0.9) {
          try {
            const verdict = await curator.chat({
              system: '你是记忆整理员。判断两条记忆是否应合并/某记忆是否属于某项目。只回答 yes 或 no。',
              user: s.why,
              maxTokens: 10,
              purpose: 'sandman-lightdream',
            })
            s.conf = /^\s*yes/i.test(verdict) ? Math.max(s.conf, 0.85) : 0.3
            enhanced++
          } catch {
            /* 模型失败保持规则置信度 */
          }
        }
      }
    }

    const inputHash = StoreClass.hash(`light:${now}:${signals.length}`)
    const receipt = `轻梦：扫描出 ${signals.length} 条信号（近重复 ${signals.filter((s) => s.kind === 'merge').length} · 归属建议 ${signals.filter((s) => s.kind === 'assign').length} · 积压 ${backlog}）${enhanced ? `，馆长复核 ${enhanced} 条` : ''}。`
    const id = this.deps.store.recordDreamRun({ kind: 'light', status: 'done', inputHash, decisions: signals, receipt })
    return { id: Number(id), kind: 'light', status: 'done', receipt, decisions: signals }
  }

  /** 深梦：唯一写库闸门（快照 → 锁 → 裁决 → 收据 → 日记） */
  private async runDeep(kind: 'deep' | 'manual', now: number): Promise<DreamRunSummary | null> {
    const store = this.deps.store
    let snapshotId: string | null = null
    try {
      snapshotId = takeSnapshot(store, this.deps.snapshotsDir).id
    } catch (e) {
      this.log(`深梦快照失败（继续执行）：${String((e as Error)?.message ?? e)}`)
    }
    if (!store.acquireDreamLock(this.windowId)) {
      const inputHash = StoreClass.hash(`${kind}:${now}:locked`)
      const id = store.recordDreamRun({ kind, status: 'interrupted', snapshotId, inputHash, receipt: `未抢到 dream_lock（持有 ${store.dreamLockInfo().holder}），放弃本次做梦`, decisions: [] })
      return { id: Number(id), kind, status: 'interrupted', receipt: '锁被持有，放弃', decisions: [] }
    }
    try {
      const decisions: DreamAction[] = []
      const notes: string[] = []
      const limit = this.deps.autoApproveLimit?.() ?? 3

      // ① 小额自动批：低风险的 pending（重要度≤2、非隔离）直接通过，≤ limit 条
      const pending = store.listPending(200).filter((m) => m.status === 'pending' && m.importance <= 2)
      for (const m of pending.slice(0, Math.max(0, limit))) {
        store.updateMemory(m.id, { status: 'active' }, 'curator', '深梦小额自动批')
        decisions.push({ type: 'action', action: 'approve', target: m.id, note: `自动批准「${m.title}」`, resolved: true })
        notes.push(`批准「${m.title}」`)
      }

      // ② 近重复合并：低分卡归档进高分卡（不物理删除），两卡的镜像随之更新
      for (const pair of store.findNearDuplicates(0.9, 10)) {
        const winner = pair.a.heat >= pair.b.heat ? pair.a : pair.b
        const loser = winner.id === pair.a.id ? pair.b : pair.a
        if (loser.status !== 'active') continue
        store.touchAccess(winner.id, 2)
        store.updateMemory(loser.id, { status: 'archived' }, 'curator', `合并入 ${winner.id}（相似度 ${pair.sim.toFixed(2)}，保留 heat 更高者）`)
        decisions.push({ type: 'action', action: 'merge', target: loser.id, note: `「${loser.title}」合并入「${winner.title}」（${pair.sim.toFixed(2)}）`, resolved: true, why: loser.id })
        notes.push(`合并「${loser.title}」→「${winner.title}」`)
      }

      // ③ 项目归属：覆盖度 ≥0.8 的直接归档进项目层（深梦职权），0.65~0.8 留提案
      for (const sug of store.suggestProjectAssignments(0.65, 20)) {
        if (sug.sim >= 0.8) {
          store.updateMemory(sug.memory.id, { level: 1, slot: 'ops', projectId: sug.projectId }, 'curator', `深梦归属判定（${sug.sim.toFixed(2)}）`)
          decisions.push({ type: 'action', action: 'assign', target: sug.memory.id, note: `「${sug.memory.title}」归入项目（${sug.sim.toFixed(2)}）`, resolved: true })
          notes.push(`归档「${sug.memory.title}」→ 项目`)
        } else {
          decisions.push({ type: 'proposal', action: 'assign', target: sug.memory.id, reason: `「${sug.memory.title}」疑似属于项目（${sug.sim.toFixed(2)}）`, conf: sug.sim })
        }
      }

      // ③.5 晋升提案（管家管晋升）：底档中 heat 高于阈值的记忆 → 建议晋升文库（level 2）
      const promoteHeat = this.deps.schedule().promoteHeat ?? 0.5
      const promotes = store.promoteCandidates(promoteHeat, 3)
      for (const m of promotes) {
        decisions.push({
          type: 'proposal',
          action: 'promote',
          target: m.id,
          toLevel: 2,
          toSlot: 'knowledge',
          reason: `「${m.title}」heat ${Number(m.heat).toFixed(2)} ≥ ${promoteHeat}，被频繁命中，建议由底档晋升文库`,
          conf: Number(m.heat),
          resolved: false,
        })
      }
      if (promotes.length) notes.push(`晋升提案 ${promotes.length} 条（待你确认）`)

      // ③.6 冲突仲裁：相似度 0.5~0.9 的疑似矛盾对 → 馆长判定 → 只产提案不进执行（审核制）
      const curator = this.deps.curator
      const pendingChanges: { memoryId: string; changeType: string; oldContent: string; newContent: string; reason: string }[] = []
      if (curator) {
        const pairs = store.findConflictPairs(0.5, 0.9, 6)
        let arbitrated = 0
        for (const pair of pairs) {
          try {
            const verdict = await curator.judgeConflict(
              { title: pair.a.title, content: pair.a.content },
              { title: pair.b.title, content: pair.b.content },
            )
            if (verdict?.contradict) {
              arbitrated++
              decisions.push({
                type: 'proposal',
                action: 'resolve',
                target: pair.a.id,
                why: pair.b.id,
                suggestion: verdict.suggestion,
                reason: `「${pair.a.title}」与「${pair.b.title}」疑似矛盾（相似度 ${pair.sim.toFixed(2)}）：${verdict.reason}。建议：${verdict.suggestion === 'keep-a' ? '保留 A 归档 B' : verdict.suggestion === 'keep-b' ? '保留 B 归档 A' : '合并表述'}`,
                conf: pair.sim,
                resolved: false,
              })
            }
          } catch {
            /* 单对失败不中断整轮做梦 */
          }
        }
        if (arbitrated) notes.push(`冲突仲裁提案 ${arbitrated} 条（待你确认）`)

        // ③.7 时效改写：时间敏感表述 × 当前日期 + 近期对话证据 → 馆长判定 → 改写并留痕
        const today = `${new Date(now).getFullYear()}-${String(new Date(now).getMonth() + 1).padStart(2, '0')}-${String(new Date(now).getDate()).padStart(2, '0')}`
        const candidates = store.timeSensitiveCandidates(10).slice(0, 6)
        let rewritten = 0
        for (const m of candidates) {
          try {
            const log = store.listSessionLog({ projectId: m.project_id && m.project_id !== 'global' ? m.project_id : undefined, limit: 8 })
            const evidence = log.map((r) => `${r.role === 'user' ? '用户' : '助手'}：${String(r.content).slice(0, 120)}`).join('\n')
            const verdict = await curator.judgeRewrite({ title: m.title, content: m.content }, evidence, today)
            if (verdict?.outdated && verdict.newContent && verdict.newContent !== m.content) {
              store.updateMemory(m.id, { content: verdict.newContent }, 'curator', `时效改写：${verdict.reason}`)
              pendingChanges.push({ memoryId: m.id, changeType: 'rewrite', oldContent: m.content, newContent: verdict.newContent, reason: verdict.reason })
              decisions.push({
                type: 'action',
                action: 'rewrite',
                target: m.id,
                note: `时效改写「${m.title}」`,
                reason: verdict.reason,
                oldText: String(m.content).slice(0, 80),
                newText: verdict.newContent.slice(0, 80),
                resolved: true,
              })
              rewritten++
            }
          } catch {
            /* 单条失败不中断 */
          }
        }
        if (rewritten) notes.push(`时效改写 ${rewritten} 条（旧文已留痕）`)
      }

      // ④ 冷记忆：久未活跃且 heat 极低 → stale（失效不删除；参数可配）
      const staleDays = this.deps.schedule().staleDays ?? 30
      const staleHeatMax = this.deps.schedule().staleHeatMax ?? 0.05
      const stales = store.staleCandidates(staleDays, staleHeatMax, 20)
      for (const m of stales) {
        store.updateMemory(m.id, { status: 'stale' }, 'curator', `深梦冷化（${staleDays} 天未活跃且 heat<${staleHeatMax}）`)
        decisions.push({ type: 'action', action: 'stale', target: m.id, note: `冷化「${m.title}」`, resolved: true })
      }
      notes.push(`冷化 ${stales.length} 条`)

      // ⑤ heat 全量重算（晋升公式的权威执行）
      const recomputed = store.recomputeAllHeat(now)
      notes.push(`重算 heat ${recomputed} 条`)

      // ⑥ 馆长调参提案（模型可用才产；current 一律用真实配置值，防模型瞎编"现状"）
      if (curator) {
        try {
          const sched = this.deps.schedule()
          const props = await curator.proposeParams(
            {
              pending: store.listPending(200).length,
              counts: store.counts(),
              stale: stales.length,
              schedule: sched,
            },
            {
              lightEveryTurns: sched.lightEveryTurns,
              deepIdleMinutes: sched.deepIdleMinutes,
              staleDays: sched.staleDays,
              staleHeatMax: sched.staleHeatMax,
              peakLeadMinutes: sched.peakLeadMinutes,
            },
          )
          for (const p of props ?? []) {
            decisions.push({ type: 'proposal', action: 'param', param: p.param, current: p.current, suggested: p.suggested, reason: p.reason, resolved: false })
          }
          if (props?.length) notes.push(`馆长提出 ${props.length} 条调参建议（待你确认）`)
        } catch (e) {
          this.log(`馆长调参提案失败（跳过）：${String((e as Error)?.message ?? e)}`)
        }
      }

      const inputHash = StoreClass.hash(`${kind}:${now}:${decisions.length}:${recomputed}`)
      const receipt = `${kind === 'manual' ? '手动' : '深梦'}完成：${notes.join('；')}。快照 ${snapshotId ?? '无'}。`
      const id = store.recordDreamRun({ kind, status: 'done', snapshotId, inputHash, decisions, receipt })
      // 改写留痕挂上本次做梦的 run id（审计链：memory_changes → dream_runs 收据）
      for (const c of pendingChanges) {
        try {
          store.recordMemoryChange({ ...c, dreamRunId: Number(id) })
        } catch (e) {
          this.log(`改写留痕失败（不影响主流程）：${String((e as Error)?.message ?? e)}`)
        }
      }
      this.writeDreamsJournal(kind, now, receipt, decisions)
      return { id: Number(id), kind, status: 'done', receipt, decisions }
    } catch (error) {
      const inputHash = StoreClass.hash(`${kind}:${now}:error`)
      const id = store.recordDreamRun({ kind, status: 'interrupted', snapshotId, inputHash, receipt: `做梦中断：${String((error as Error)?.message ?? error)}`, decisions: [] })
      return { id: Number(id), kind, status: 'interrupted', receipt: `中断：${String((error as Error)?.message ?? error)}`, decisions: [] }
    } finally {
      store.releaseDreamLock(this.windowId)
    }
  }

  /** 梦境日记：人能读的 Markdown，追加进镜像库（随 vault 一起被导出/备份） */
  private writeDreamsJournal(kind: string, now: number, receipt: string, decisions: DreamAction[]) {
    try {
      const dir = path.join(this.deps.vaultDir, '系统')
      mkdirSync(dir, { recursive: true })
      const file = path.join(dir, 'DREAMS.md')
      if (!existsSync(file)) {
        appendFileSync(file, '# 梦境日记\n\n九层之台的做梦记录。每条 = 一次整理：做了什么、为什么、留了哪些提案等你拍板。\n\n', 'utf8')
      }
      const lines = [`## ${new Date(now).toLocaleString('zh-CN')} · ${kind}`, '', `> ${receipt}`, '']
      for (const d of decisions) {
        if (d.type === 'proposal') lines.push(`- ⏳ 提案：${d.reason ?? ''}${d.param ? `（${d.param}: ${d.current} → ${d.suggested}）` : ''}`)
        else if (d.action === 'rewrite') lines.push(`- ✏️ 时效改写「${d.note?.replace('时效改写', '') ?? d.target}」：${d.reason ?? ''}`)
      }
      lines.push('')
      appendFileSync(file, lines.join('\n'), 'utf8')
    } catch (e) {
      this.log(`写梦境日记失败：${String((e as Error)?.message ?? e)}`)
    }
  }

  /** DREAMS.md 全文（梦境页阅读器） */
  readDreamsJournal(): string {
    try {
      const file = path.join(this.deps.vaultDir, '系统', 'DREAMS.md')
      return existsSync(file) ? readFileSync(file, 'utf8') : ''
    } catch {
      return ''
    }
  }
}
