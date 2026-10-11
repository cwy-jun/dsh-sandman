// store/db.ts —— node:sqlite 封装：WAL、迁移、CRUD、审计日志、dream_lock 租约锁、三件备份。
// store 层是 core 的"数据库适配器 + 运行态"：core 保持纯函数，这里负责落库与文件。
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, copyFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { migrate, makeMemoryId, validSlot, type SqlExec } from '../core/schema.js'
import { computeHeat, type HeatParams } from '../core/heat.js'
import { bigramSim, bigramContainment, toFtsText } from '../core/bm25.js'
import type { GateDeps } from '../core/gating.js'
import type { RouterDeps, ProjectBrief, LexiconEntry } from '../core/router.js'
import { writeMirror } from './mirror.js'

export interface StoreOptions {
  dbPath: string
  vaultDir: string
  heatParams?: HeatParams
}

export interface MemoryInput {
  level: number
  slot?: string | null
  projectId?: string | null
  title: string
  content: string
  keywords?: string[]
  importance?: number
  status?: string
  source: string
}

export interface MemoryPatch {
  title?: string
  content?: string
  keywords?: string[]
  status?: string
  level?: number
  slot?: string | null
  projectId?: string | null
  importance?: number
}

/** memories 表行（node:sqlite 返回 unknown，这里钉死类型） */
export interface MemoryRow {
  id: string
  level: number
  slot: string | null
  project_id: string | null
  title: string
  content: string
  keywords: string
  heat: number
  importance: number
  status: string
  source: string
  version: number
  content_hash: string
  created_at: number
  updated_at: number
  last_accessed_at: number | null
  hits: number
}

export interface GatingLogRow {
  cand_hash: string
  g1_result: string
  g2_sim: number | null
  g2_conflict: number | null
  g3_used: number
  g3_decision: string | null
  g3_conf: number | null
  final_decision: string
  latency_ms: number
}

export interface RouterLogRow {
  msg_hash: string
  project_id: string | null
  conf: number
  r1_hit: number
  r2_top: string
  r3_used: number
  scope: string
  latency_ms: number
}

export class Store {
  readonly db: DatabaseSync
  readonly dbPath: string
  readonly vaultDir: string
  private heatParams: HeatParams

  constructor(opts: StoreOptions) {
    this.dbPath = opts.dbPath
    this.vaultDir = opts.vaultDir
    this.heatParams = opts.heatParams ?? { lambda: 0.02 }
    mkdirSync(path.dirname(opts.dbPath), { recursive: true })
    mkdirSync(opts.vaultDir, { recursive: true })
    this.db = new DatabaseSync(opts.dbPath)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    migrate(this.db as unknown as SqlExec)
  }

  static hash(text: string): string {
    return createHash('sha256').update(String(text), 'utf8').digest('hex')
  }

  private randHex8(): string {
    return randomBytes(4).toString('hex')
  }

  // ───────────────────────── 记忆 CRUD ─────────────────────────

  insertMemory(input: MemoryInput, changedBy = 'system', note?: string) {
    const now = Date.now()
    const level = input.level
    const slot = input.slot ?? null
    if (!validSlot(level, slot)) {
      throw new Error(`层 ${level} 不接受槽位 ${JSON.stringify(slot)}`)
    }
    const projectId = level === 0 ? 'global' : input.projectId ?? null
    const title = String(input.title ?? '').trim()
    const content = String(input.content ?? '').trim()
    if (!title || !content) throw new Error('title 与 content 不能为空')
    const keywords = Array.isArray(input.keywords) ? input.keywords.map(String) : []
    const id = makeMemoryId(now, this.randHex8())
    const hash = Store.hash(content)
    const status = input.status ?? 'active'
    const importance = Math.min(3, Math.max(1, input.importance ?? 2))
    const heat = computeHeat(
      { hits: 0, contentLen: content.length, keywordsCount: keywords.length, daysSinceAccess: 0 },
      this.heatParams,
    )
    this.db
      .prepare(
        `INSERT INTO memories
         (id, level, slot, project_id, title, content, keywords, heat, importance, status, source, version, content_hash, created_at, updated_at, last_accessed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      )
      .run(id, level, slot, projectId, title, content, JSON.stringify(keywords), heat, importance, status, input.source, hash, now, now, now)
    this.db
      .prepare('INSERT INTO memory_versions (memory_id, version, content, changed_by, change_note, ts) VALUES (?, 1, ?, ?, ?, ?)')
      .run(id, content, changedBy, note ?? '创建', now)
    this.ftsUpsert(id, title, content, keywords)
    const row = this.getMemory(id) as MemoryRow
    writeMirror(this.vaultDir, { ...row, project_name: this.projectName(row.project_id) })
    return row
  }

  updateMemory(id: string, patch: MemoryPatch, changedBy: string, note?: string) {
    const old = this.getMemory(id)
    if (!old) throw new Error(`记忆不存在：${id}`)
    const now = Date.now()
    const title = patch.title ?? old.title
    const content = patch.content ?? old.content
    const keywords = patch.keywords ?? safeJsonArray(old.keywords)
    const status = patch.status ?? old.status
    const level = patch.level ?? old.level
    const slot = patch.slot === undefined ? old.slot : patch.slot
    const projectId = patch.projectId ?? old.project_id
    const importance = patch.importance ?? old.importance
    const newVersion = old.version + 1
    const hash = content === old.content ? old.content_hash : Store.hash(content)
    this.db
      .prepare('INSERT INTO memory_versions (memory_id, version, content, changed_by, change_note, ts) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, old.version, old.content, changedBy, note ?? `保存 v${newVersion}`, now)
    this.db
      .prepare(
        `UPDATE memories SET title=?, content=?, keywords=?, status=?, level=?, slot=?, project_id=?,
         importance=?, version=?, content_hash=?, updated_at=? WHERE id=?`,
      )
      .run(title, content, JSON.stringify(keywords), status, level, slot, projectId, importance, newVersion, hash, now, id)
    this.ftsUpsert(id, title, content, keywords)
    const row = this.getMemory(id) as MemoryRow
    writeMirror(this.vaultDir, { ...row, project_name: this.projectName(row.project_id) })
    return row
  }

  getMemory(id: string): MemoryRow | undefined {
    return this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined
  }

  listMemories(filter: { level?: number; status?: string; projectId?: string; q?: string; limit?: number; offset?: number } = {}): MemoryRow[] {
    const limit = Math.min(500, filter.limit ?? 100)
    const offset = filter.offset ?? 0
    if (filter.q) {
      const tokens = toFtsText(filter.q).split(' ').filter(Boolean)
      if (tokens.length > 0) {
        const match = tokens.map((t) => `"${t}"`).join(' AND ')
        const conds: string[] = []
        const args: (string | number)[] = []
        if (filter.level !== undefined) { conds.push('m.level = ?'); args.push(filter.level) }
        if (filter.status) { conds.push('m.status = ?'); args.push(filter.status) }
        if (filter.projectId) { conds.push('m.project_id = ?'); args.push(filter.projectId) }
        const where = conds.length ? `AND ${conds.join(' AND ')}` : ''
        return this.db
          .prepare(
            `SELECT m.* FROM memories m JOIN memories_fts f ON f.rowid = m.rowid
             WHERE memories_fts MATCH ? ${where} ORDER BY m.updated_at DESC LIMIT ? OFFSET ?`,
          )
          .all(match, ...args, limit, offset) as unknown as MemoryRow[]
      }
    }
    const conds: string[] = []
    const args: (string | number)[] = []
    if (filter.level !== undefined) { conds.push('level = ?'); args.push(filter.level) }
    if (filter.status) { conds.push('status = ?'); args.push(filter.status) }
    if (filter.projectId) { conds.push('project_id = ?'); args.push(filter.projectId) }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
    return this.db
      .prepare(`SELECT * FROM memories ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
      .all(...args, limit, offset) as unknown as MemoryRow[]
  }

  listVersions(id: string) {
    return this.db
      .prepare('SELECT id, memory_id, version, changed_by, change_note, ts FROM memory_versions WHERE memory_id = ? ORDER BY version DESC')
      .all(id) as Record<string, unknown>[]
  }

  restoreVersion(id: string, version: number, changedBy = 'user') {
    const row = this.db
      .prepare('SELECT content FROM memory_versions WHERE memory_id = ? AND version = ?')
      .get(id, version) as { content: string } | undefined
    if (!row) throw new Error(`版本不存在：v${version}`)
    return this.updateMemory(id, { content: row.content }, changedBy, `还原到 v${version}`)
  }

  versionsContent(id: string) {
    return this.db
      .prepare('SELECT version, content, changed_by, change_note, ts FROM memory_versions WHERE memory_id = ? ORDER BY version DESC')
      .all(id) as Record<string, unknown>[]
  }

  /** 命中计数 + 活跃时间 + heat 重算（重复/合并/召回命中时调用） */
  touchAccess(id: string, weight = 1): void {
    const row = this.getMemory(id)
    if (!row) return
    const now = Date.now()
    const hits = (row.hits ?? 0) + weight
    const days = row.last_accessed_at ? (now - row.last_accessed_at) / 86400000 : 0
    const heat = computeHeat(
      { hits, contentLen: row.content.length, keywordsCount: safeJsonArray(row.keywords).length, daysSinceAccess: Math.max(0, days) },
      this.heatParams,
    )
    this.db.prepare('UPDATE memories SET hits = ?, last_accessed_at = ?, heat = ? WHERE id = ?').run(hits, now, heat, id)
  }

  /** 全量重算 heat（馆长治理/定期整理用）：返回重算条数 */
  recomputeAllHeat(now: number = Date.now()): number {
    const rows = this.db
      .prepare("SELECT id, hits, content, keywords, last_accessed_at FROM memories WHERE status = 'active'")
      .all() as { id: string; hits: number; content: string; keywords: string; last_accessed_at: number | null }[]
    const stmt = this.db.prepare('UPDATE memories SET heat = ? WHERE id = ?')
    for (const r of rows) {
      const days = r.last_accessed_at ? (now - r.last_accessed_at) / 86400000 : 30
      const heat = computeHeat(
        { hits: r.hits ?? 0, contentLen: r.content.length, keywordsCount: safeJsonArray(r.keywords).length, daysSinceAccess: Math.max(0, days) },
        this.heatParams,
      )
      stmt.run(heat, r.id)
    }
    return rows.length
  }

  /** 审核队列（含隔离区） */
  listPending(limit = 100): MemoryRow[] {
    return this.db.prepare("SELECT * FROM memories WHERE status IN ('pending','quarantine') ORDER BY created_at ASC LIMIT ?").all(limit) as unknown as MemoryRow[]
  }

  /** 失败记忆视图：写门 reject/drop 留痕 */
  recentGatingFailures(limit = 50): Record<string, unknown>[] {
    return this.db
      .prepare("SELECT * FROM gating_log WHERE final_decision IN ('reject','drop') ORDER BY ts DESC LIMIT ?")
      .all(limit) as unknown as Record<string, unknown>[]
  }

  /** 今日自动捕获条数（日上限判定） */
  capturesSince(startMs: number): number {
    const row = this.db.prepare("SELECT COUNT(*) n FROM memories WHERE source = 'capture' AND created_at >= ?").get(startMs) as { n: number }
    return row.n
  }

  /** 项目内按热度排序（注入用） */
  topProjectCards(projectId: string, limit = 8): MemoryRow[] {
    return this.db
      .prepare("SELECT * FROM memories WHERE project_id = ? AND status = 'active' ORDER BY heat DESC, updated_at DESC LIMIT ?")
      .all(projectId, limit) as unknown as MemoryRow[]
  }

  /** 全文检索 + heat 排序（文库 top-K / 馆长问答取上下文用）。
   *  问答场景用 OR 召回再按 heat 排序——AND 会把"装插件要注意什么"里的口语词全卡死。 */
  searchCards(q: string, limit = 8): MemoryRow[] {
    const tokens = toFtsText(q).split(' ').filter(Boolean)
    if (tokens.length === 0) return []
    const match = tokens.map((t) => `"${t}"`).join(' OR ')
    const rows = this.db
      .prepare(
        `SELECT m.* FROM memories m JOIN memories_fts f ON f.rowid = m.rowid
         WHERE memories_fts MATCH ? AND m.status = 'active' ORDER BY m.heat DESC LIMIT ?`,
      )
      .all(match, limit) as unknown as MemoryRow[]
    return rows
  }

  /** 冷记忆候选（过期标记用；失效不删除，只降状态）。
   *  显著性地板：画像层（level 0）不因时间被冷化——画像冷化只能走"时效改写"（改写留痕），
   *  防止"用户是谁/规矩是什么"这类高价值老记忆被天数一刀切误杀（干扰性遗忘的克制版）。 */
  staleCandidates(idleDays = 30, maxHeat = 0.1, limit = 100): MemoryRow[] {
    const since = Date.now() - idleDays * 86400000
    return this.db
      .prepare("SELECT * FROM memories WHERE status = 'active' AND level > 0 AND heat < ? AND last_accessed_at < ? LIMIT ?")
      .all(maxHeat, since, limit) as unknown as MemoryRow[]
  }

  /** 时效改写候选：画像/项目层中含时间敏感表述的活跃记忆（深梦"时效改写"步骤用） */
  timeSensitiveCandidates(limit = 10): MemoryRow[] {
    const rows = this.db
      .prepare("SELECT * FROM memories WHERE status = 'active' AND level IN (0, 1) ORDER BY updated_at ASC LIMIT 200")
      .all() as unknown as MemoryRow[]
    return rows.filter((r) => TIME_SENSITIVE_RE.test(`${r.title}\n${r.content}`)).slice(0, limit)
  }

  /** 冲突仲裁候选：同层相似度落在 [minSim, maxSim) 的疑似矛盾对（太高归"近重复合并"管，别越界）。
   *  默认 minSim 0.5：纯反对的短规 bigram 相似度反而不高（~0.34），同主题修正型记忆（旧规 vs 新规）才落在 0.5~0.9，
   *  误报由馆长 LLM 判定滤掉（contradict=false 即弃），宁多送审不漏真冲突。 */
  findConflictPairs(minSim = 0.5, maxSim = 0.9, limit = 6): { a: MemoryRow; b: MemoryRow; sim: number }[] {
    const rows = this.db.prepare("SELECT * FROM memories WHERE status = 'active'").all() as unknown as MemoryRow[]
    const out: { a: MemoryRow; b: MemoryRow; sim: number }[] = []
    for (let i = 0; i < rows.length && out.length < limit; i++) {
      for (let j = i + 1; j < rows.length && out.length < limit; j++) {
        if (rows[i].level !== rows[j].level) continue
        const sim = bigramSim(`${rows[i].title}\n${rows[i].content}`, `${rows[j].title}\n${rows[j].content}`)
        if (sim >= minSim && sim < maxSim) out.push({ a: rows[i], b: rows[j], sim })
      }
    }
    return out.sort((x, y) => y.sim - x.sim)
  }

  /** 变更留痕（memory_changes）：改写/仲裁的 old→new 成对留底，审计与面板"留痕"视图的数据源 */
  recordMemoryChange(input: { memoryId: string; changeType: string; oldContent?: string | null; newContent?: string | null; reason?: string; dreamRunId?: number | null }) {
    this.db
      .prepare('INSERT INTO memory_changes (memory_id, change_type, old_content, new_content, reason, dream_run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(String(input.memoryId), String(input.changeType), input.oldContent ?? null, input.newContent ?? null, input.reason ?? null, input.dreamRunId ?? null, Date.now())
  }

  /** 最近变更留痕（新→旧） */
  listMemoryChanges(limit = 100): Record<string, unknown>[] {
    return this.db.prepare('SELECT * FROM memory_changes ORDER BY id DESC LIMIT ?').all(limit) as unknown as Record<string, unknown>[]
  }

  /** 疑似重复对（做梦合并建议用）：同层内 bigram 相似度 ≥ 阈值的前 N 对 */
  findNearDuplicates(threshold = 0.9, limit = 20): { a: MemoryRow; b: MemoryRow; sim: number }[] {
    const rows = this.db.prepare("SELECT * FROM memories WHERE status = 'active'").all() as unknown as MemoryRow[]
    const out: { a: MemoryRow; b: MemoryRow; sim: number }[] = []
    for (let i = 0; i < rows.length && out.length < limit; i++) {
      for (let j = i + 1; j < rows.length && out.length < limit; j++) {
        if (rows[i].level !== rows[j].level) continue
        const sim = bigramSim(`${rows[i].title}\n${rows[i].content}`, `${rows[j].title}\n${rows[j].content}`)
        if (sim >= threshold) out.push({ a: rows[i], b: rows[j], sim })
      }
    }
    return out.sort((x, y) => y.sim - x.sim)
  }

  /** 项目归属建议：F3 未挂项目卡与各项目画像的覆盖度 ≥ 阈值（短画像被长记忆覆盖多少） */
  suggestProjectAssignments(threshold = 0.65, limit = 20): { memory: MemoryRow; projectId: string; sim: number }[] {
    const pool = this.db
      .prepare("SELECT * FROM memories WHERE status = 'active' AND level = 3 AND (project_id IS NULL OR project_id = '') LIMIT 200")
      .all() as unknown as MemoryRow[]
    const deps = this.routerDeps()
    const profiles = new Map(deps.projects.map((p) => [p.id, p.profile]))
    const out: { memory: MemoryRow; projectId: string; sim: number }[] = []
    for (const m of pool) {
      let best: { projectId: string; sim: number } | null = null
      for (const p of deps.projects) {
        const sim = bigramContainment(profiles.get(p.id) ?? '', `${m.title}\n${m.content}`)
        if (sim >= threshold && (!best || sim > best.sim)) best = { projectId: p.id, sim }
      }
      if (best && out.length < limit) out.push({ memory: m, projectId: best.projectId, sim: best.sim })
    }
    return out
  }

  /** 写门审计查询（梦境/审核页看原始判定） */
  recentGating(limit = 50): Record<string, unknown>[] {
    return this.db.prepare('SELECT * FROM gating_log ORDER BY ts DESC LIMIT ?').all(limit) as unknown as Record<string, unknown>[]
  }

  /** 最近路由判定（可解释：这句话为什么归这个项目） */
  recentRoutes(limit = 50): Record<string, unknown>[] {
    return this.db.prepare('SELECT * FROM router_log ORDER BY ts DESC LIMIT ?').all(limit) as unknown as Record<string, unknown>[]
  }

  counts() {
    const byLevel = this.db.prepare("SELECT level, COUNT(*) n FROM memories WHERE status='active' GROUP BY level").all() as { level: number; n: number }[]
    const byStatus = this.db.prepare('SELECT status, COUNT(*) n FROM memories GROUP BY status').all() as { status: string; n: number }[]
    const total = (this.db.prepare('SELECT COUNT(*) n FROM memories').get() as { n: number }).n
    const projects = (this.db.prepare("SELECT COUNT(*) n FROM projects WHERE status='active'").get() as { n: number }).n
    return {
      total,
      projects,
      byLevel: Object.fromEntries(byLevel.map((r) => [r.level, r.n])),
      byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.n])),
    }
  }

  // ───────────────────────── 项目 / 词表 ─────────────────────────

  upsertProject(id: string, name: string, profile = '') {
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO projects (id, name, profile, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, profile=excluded.profile, updated_at=excluded.updated_at`,
      )
      .run(id, name, profile, now, now)
  }

  addLexicon(projectId: string, term: string, weight = 1, source = 'manual') {
    this.db
      .prepare('INSERT OR REPLACE INTO project_lexicon (project_id, term, weight, source) VALUES (?, ?, ?, ?)')
      .run(projectId, term, weight, source)
  }

  listProjects(): { id: string; name: string; profile: string }[] {
    return this.db.prepare("SELECT id, name, profile FROM projects WHERE status='active' ORDER BY updated_at DESC").all() as { id: string; name: string; profile: string }[]
  }

  projectName(projectId: string | null | undefined): string | null {
    if (!projectId || projectId === 'global') return projectId === 'global' ? 'global' : null
    const row = this.db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId) as { name: string } | undefined
    return row?.name ?? null
  }

  // ───────────────────────── core 适配器 ─────────────────────────

  /** 全库语料（写门门2 相似度用）：小库全量 bigram 足够；大库后可换 FTS 检索 */
  corpus(): { id: string; text: string }[] {
    const rows = this.db.prepare("SELECT id, title, content, keywords FROM memories WHERE status='active'").all() as { id: string; title: string; content: string; keywords: string }[]
    return rows.map((r) => ({ id: r.id, text: `${r.title}\n${r.content}\n${safeJsonArray(r.keywords).join(' ')}` }))
  }

  /** 画像层语料（冲突检测用） */
  profileCorpus(): string[] {
    const rows = this.db.prepare("SELECT title, content FROM memories WHERE level=0 AND status='active'").all() as { title: string; content: string }[]
    return rows.map((r) => `${r.title}\n${r.content}`)
  }

  gateDeps(): GateDeps {
    return {
      findByHash: (hash) => {
        const row = this.db.prepare('SELECT id FROM memories WHERE content_hash = ? LIMIT 1').get(hash) as { id: string } | undefined
        return row?.id ?? null
      },
      searchSimilar: (text, topN) => {
        const corpus = this.corpus()
        return corpus
          .map((c) => ({ id: c.id, sim: bigramSim(text, c.text) }))
          .filter((c) => c.sim > 0)
          .sort((a, b) => b.sim - a.sim)
          .slice(0, topN)
      },
      profileConflict: (text) => {
        let best = 0
        for (const p of this.profileCorpus()) best = Math.max(best, bigramSim(text, p))
        return best
      },
    }
  }

  routerDeps(): RouterDeps {
    const rawLex = this.db.prepare('SELECT project_id, term, weight FROM project_lexicon').all() as unknown as { project_id: string; term: string; weight: number }[]
    const lexicon: LexiconEntry[] = rawLex.map((r) => ({ projectId: r.project_id, term: r.term, weight: r.weight }))
    const projects = this.listProjects() as ProjectBrief[]
    const profiles = new Map(projects.map((p) => [p.id, p.profile]))
    return {
      lexicon,
      projects,
      profileScore: (message, projectId) => bigramSim(message, profiles.get(projectId) ?? ''),
    }
  }

  // ───────────────────────── 审计日志 ─────────────────────────

  logGating(row: GatingLogRow) {
    this.db
      .prepare(
        `INSERT INTO gating_log (cand_hash, g1_result, g2_sim, g2_conflict, g3_used, g3_decision, g3_conf, final_decision, latency_ms, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.cand_hash, row.g1_result, row.g2_sim, row.g2_conflict, row.g3_used,
        row.g3_decision, row.g3_conf, row.final_decision, row.latency_ms, Date.now(),
      )
  }

  logRouter(row: RouterLogRow) {
    this.db
      .prepare(
        `INSERT INTO router_log (msg_hash, project_id, conf, r1_hit, r2_top, r3_used, scope, latency_ms, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.msg_hash, row.project_id, row.conf, row.r1_hit, row.r2_top, row.r3_used, row.scope, row.latency_ms, Date.now())
  }

  // ───────────────────────── 做梦：锁 + 收据 ─────────────────────────

  /** 抢锁（60s 租约，过期可窃取；同窗口续约）。返回是否抢到。 */
  acquireDreamLock(windowId: string, ttlMs = 60000): boolean {
    const now = Date.now()
    const until = now + ttlMs
    const tx = () => {
      const row = this.db.prepare('SELECT window_id, lease_until FROM dream_lock WHERE id = 1').get() as { window_id: string; lease_until: number } | undefined
      if (!row) {
        this.db.prepare('INSERT INTO dream_lock (id, window_id, lease_until) VALUES (1, ?, ?)').run(windowId, until)
        return true
      }
      if (row.window_id === windowId || row.lease_until < now) {
        this.db.prepare('UPDATE dream_lock SET window_id = ?, lease_until = ? WHERE id = 1').run(windowId, until)
        return true
      }
      return false
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const ok = tx()
      this.db.exec('COMMIT')
      return ok
    } catch (e) {
      try { this.db.exec('ROLLBACK') } catch { /* ignore */ }
      throw e
    }
  }

  releaseDreamLock(windowId: string): boolean {
    const r = this.db.prepare("UPDATE dream_lock SET window_id = '', lease_until = 0 WHERE id = 1 AND window_id = ?").run(windowId)
    return Number(r.changes) > 0
  }

  dreamLockInfo() {
    const row = this.db.prepare('SELECT window_id, lease_until FROM dream_lock WHERE id = 1').get() as { window_id: string; lease_until: number } | undefined
    return { holder: row?.window_id || null, leaseUntil: row?.lease_until ?? 0, now: Date.now() }
  }

  recordDreamRun(run: { kind: string; status: string; snapshotId?: string | null; inputHash: string; decisions?: unknown[]; receipt?: string }) {
    const r = this.db
      .prepare('INSERT INTO dream_runs (kind, status, snapshot_id, input_hash, decisions, receipt, ts) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(run.kind, run.status, run.snapshotId ?? null, run.inputHash, JSON.stringify(run.decisions ?? []), run.receipt ?? '', Date.now())
    return Number(r.lastInsertRowid)
  }

  listDreamRuns(limit = 50) {
    return this.db.prepare('SELECT * FROM dream_runs ORDER BY ts DESC LIMIT ?').all(limit) as Record<string, unknown>[]
  }

  getDreamRun(id: number): Record<string, unknown> | undefined {
    return this.db.prepare('SELECT * FROM dream_runs WHERE id = ?').get(id) as Record<string, unknown> | undefined
  }

  /** 更新某次做梦的决议 JSON（提案采纳/驳回后置 resolved） */
  updateDreamRunDecisions(id: number, decisions: unknown[]): boolean {
    const r = this.db.prepare('UPDATE dream_runs SET decisions = ? WHERE id = ?').run(JSON.stringify(decisions), id)
    return Number(r.changes) > 0
  }

  // ───────────────────────── 馆长对话持久化（v3）────────────────────────
  // 目的：面板重载 / 切换会话后馆长对话不丢；馆长每次问答都能读到近期上下文。

  appendCuratorChat(role: 'user' | 'curator', content: string, sources: unknown[] = []): number {
    const r = this.db
      .prepare('INSERT INTO curator_chat (role, content, sources, created_at) VALUES (?, ?, ?, ?)')
      .run(role === 'curator' ? 'curator' : 'user', String(content ?? ''), JSON.stringify(sources ?? []), Date.now())
    // 只保留最近 500 条（滚动窗口，不无限增长）
    this.db
      .prepare('DELETE FROM curator_chat WHERE id NOT IN (SELECT id FROM curator_chat ORDER BY id DESC LIMIT 500)')
      .run()
    return Number(r.lastInsertRowid)
  }

  /** 按时间正序返回（最早的在前，便于直接渲染成对话流） */
  listCuratorChat(limit = 200): Record<string, unknown>[] {
    const rows = this.db
      .prepare('SELECT id, role, content, sources, created_at FROM curator_chat ORDER BY id DESC LIMIT ?')
      .all(limit) as Record<string, unknown>[]
    return rows.reverse()
  }

  clearCuratorChat(): number {
    return Number(this.db.prepare('DELETE FROM curator_chat').run().changes)
  }

  // ───────────────────────── 个性化指令（v3）────────────────────────
  // 全局指令常驻注入；工作区指令在「路由命中该项目域 / 最近文本命中关键词」时注入。

  listPersonalization(onlyEnabled = false): Record<string, unknown>[] {
    const sql = onlyEnabled
      ? 'SELECT * FROM personalization WHERE enabled = 1 ORDER BY scope ASC, updated_at ASC'
      : 'SELECT * FROM personalization ORDER BY scope ASC, updated_at ASC'
    return this.db.prepare(sql).all() as Record<string, unknown>[]
  }

  upsertPersonalization(input: {
    id?: string
    scope?: string
    workspace?: string | null
    match?: string | null
    content?: string
    enabled?: boolean
  }): Record<string, unknown> {
    const now = Date.now()
    // 语义：未提供的字段回退到已有值（支持「仅开关」更新，不会把 content 冲掉）
    const existing = input.id
      ? (this.db.prepare('SELECT * FROM personalization WHERE id = ?').get(String(input.id)) as Record<string, unknown> | undefined)
      : undefined
    const id = existing ? String(existing.id) : `persona-${now}-${this.randHex8()}`
    const scope = input.scope === 'workspace' ? 'workspace' : input.scope === 'global' ? 'global' : existing ? String(existing.scope) : 'global'
    const workspace = input.workspace !== undefined ? input.workspace ?? null : existing ? (existing.workspace as string | null) : null
    const match = input.match !== undefined ? input.match ?? null : existing ? (existing.match as string | null) : null
    const content = input.content !== undefined ? String(input.content) : existing ? String(existing.content) : ''
    const enabled = input.enabled !== undefined ? (input.enabled ? 1 : 0) : existing ? Number(existing.enabled) : 1
    this.db
      .prepare(
        `INSERT INTO personalization (id, scope, workspace, match, content, enabled, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET scope = excluded.scope, workspace = excluded.workspace,
           match = excluded.match, content = excluded.content, enabled = excluded.enabled, updated_at = excluded.updated_at`,
      )
      .run(id, scope, workspace, match, content, enabled, now)
    return this.db.prepare('SELECT * FROM personalization WHERE id = ?').get(id) as Record<string, unknown>
  }

  deletePersonalization(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM personalization WHERE id = ?').run(String(id)).changes) > 0
  }

  // ───────────────────────── 项目对话流水（v3）─────────────────────────
  // 馆长"看见项目对话"的数据底座：每轮 user/assistant 原文（截断）+ 路由项目域。

  appendSessionTurn(sessionId: string, userText: string, assistantText: string, projectId: string | null): void {
    const now = Date.now()
    const ins = this.db.prepare(
      'INSERT INTO session_log (session_id, role, content, project_id, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    const clamp = (s: string) => String(s ?? '').slice(0, 1200)
    if (userText) ins.run(String(sessionId || 'unknown'), 'user', clamp(userText), projectId, now)
    if (assistantText) ins.run(String(sessionId || 'unknown'), 'assistant', clamp(assistantText), projectId, now)
    // 滚动窗口：只保留最近 2000 行
    this.db
      .prepare('DELETE FROM session_log WHERE id NOT IN (SELECT id FROM session_log ORDER BY id DESC LIMIT 2000)')
      .run()
  }

  /** 会话/项目对话流（时间正序）。projectId 与 sessionId 都可空 = 最近全部。 */
  listSessionLog(opts: { sessionId?: string; projectId?: string; limit?: number } = {}): Record<string, unknown>[] {
    const where: string[] = []
    const args: unknown[] = []
    if (opts.sessionId) { where.push('session_id = ?'); args.push(opts.sessionId) }
    if (opts.projectId) { where.push('project_id = ?'); args.push(opts.projectId) }
    const sql = `SELECT id, session_id, role, content, project_id, created_at FROM session_log
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY id DESC LIMIT ?`
    args.push(opts.limit ?? 60)
    const rows = this.db.prepare(sql).all(...(args as never[])) as Record<string, unknown>[]
    return rows.reverse()
  }

  /** 晋升候选：底档中 heat 高于阈值的活跃记忆（深梦提案用） */
  promoteCandidates(minHeat = 0.5, limit = 3): MemoryRow[] {
    return this.db
      .prepare("SELECT * FROM memories WHERE level = 3 AND status = 'active' AND heat >= ? ORDER BY heat DESC LIMIT ?")
      .all(minHeat, limit) as unknown as MemoryRow[]
  }

  // ───────────────────────── FTS5 同步 ─────────────────────────

  private ftsRowid(id: string): number | null {
    const row = this.db.prepare('SELECT rowid FROM memories WHERE id = ?').get(id) as { rowid: number } | undefined
    return row?.rowid ?? null
  }

  private ftsUpsert(id: string, title: string, content: string, keywords: string[]) {
    const rowid = this.ftsRowid(id)
    if (rowid === null) return
    this.db.prepare('DELETE FROM memories_fts WHERE rowid = ?').run(rowid)
    this.db
      .prepare('INSERT INTO memories_fts (rowid, title, content, keywords) VALUES (?, ?, ?, ?)')
      .run(rowid, toFtsText(title), toFtsText(content), toFtsText(keywords.join(' ')))
  }

  // ───────────────────────── 备份（db+wal+shm 三件） ─────────────────────────

  backupFiles(destDir: string): string[] {
    mkdirSync(destDir, { recursive: true })
    // TRUNCATE 检查点把 WAL 内容并回主库，之后单拷 .db 即一致；wal/shm 存在则一并拷（纪律：三件一起）。
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    const copied: string[] = []
    for (const suffix of ['', '-wal', '-shm']) {
      const src = this.dbPath + suffix
      if (existsSync(src)) {
        copyFileSync(src, path.join(destDir, path.basename(this.dbPath) + suffix))
        copied.push(path.basename(this.dbPath) + suffix)
      }
    }
    return copied
  }

  checkpoint() {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
  }

  close() {
    try { this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)") } catch { /* ignore */ }
    this.db.close()
  }
}

function safeJsonArray(raw: unknown): string[] {
  try {
    const v = JSON.parse(String(raw ?? '[]'))
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}

/** 时间敏感表述（时效改写的候选信号）：进行态 / 近期计划 / 截止预计 / 序号推进。
 *  命中只代表"值得让馆长判一眼"，判不改写就什么都不发生。 */
export const TIME_SENSITIVE_RE =
  /正在|进行中|推进中|本周|下周|下下周|明天|后天|截止|预计|计划|即将|将要|待办|待定|暂定|下一步|现阶段|第[0-9一二三四五六七八九十百]+(条|集|版|阶段|步)|[0-9]{1,2}月[0-9]{1,2}[日号]|下(一|二|三|四|五)(周|个)|coming soon|next (week|month)|deadline/i
