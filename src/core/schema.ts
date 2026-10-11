// core/schema.ts —— schema v1（字段级定稿见《九层之台-M1详细设计》第 2 节）
// + 迁移链执行器。本层零宿主依赖：只操作调用方传入的最小 SQL 接口（SqlExec），
// node:sqlite / better-sqlite3 / 内存假实现都能跑，便于单测。

/** 最小 SQL 执行接口（node:sqlite 的 DatabaseSync 结构上兼容） */
export interface SqlExec {
  exec(sql: string): unknown
  prepare(sql: string): {
    run(...args: unknown[]): unknown
    get(...args: unknown[]): unknown
    all(...args: unknown[]): unknown[]
  }
}

/** schema v1 DDL —— 十一张表 + FTS5 索引（逐字按 M1 设计定稿） */
export const SCHEMA_V1_DDL = `
-- ============ 主数据 ============
CREATE TABLE IF NOT EXISTS memories (
  id            TEXT PRIMARY KEY,              -- 时间前缀 UUID（格式 yyMMddHHmmss-xxxxxxxx，id 即创建序）
  level         INTEGER NOT NULL,              -- 0 画像 / 1 项目 / 2 文库 / 3 底档
  slot          TEXT,                          -- 槽位：identity|preference|rule|goal（F0）
                                               --       structure|decision|todo|ops|review（F1）
                                               --       lesson|prompt|norm|knowledge（F2）
                                               --       NULL（F3 无槽位）
  project_id    TEXT,                          -- 项目域 id；F0 填 'global'
  title         TEXT NOT NULL,
  content       TEXT NOT NULL,
  keywords      TEXT NOT NULL DEFAULT '[]',    -- JSON 数组
  heat          REAL NOT NULL DEFAULT 0,       -- 由 heat.ts 计算，不手工写
  importance    INTEGER NOT NULL DEFAULT 2,    -- 1~3
  status        TEXT NOT NULL DEFAULT 'active',-- active|archived|stale|invalid（失效不删除）
  source        TEXT NOT NULL,                 -- capture|tool|manual|curator|migrated
  version       INTEGER NOT NULL DEFAULT 1,
  content_hash  TEXT NOT NULL,                 -- 归一化文本 sha256（写门门1查重用）
  created_at    INTEGER NOT NULL,              -- ms
  updated_at    INTEGER NOT NULL,
  last_accessed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mem_ls    ON memories(level, status);
CREATE INDEX IF NOT EXISTS idx_mem_proj  ON memories(project_id, status);
CREATE INDEX IF NOT EXISTS idx_mem_heat  ON memories(heat DESC);
CREATE INDEX IF NOT EXISTS idx_mem_hash  ON memories(content_hash);

CREATE TABLE IF NOT EXISTS memory_versions (      -- 每次编辑留旧版，可 diff 可还原
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id   TEXT NOT NULL REFERENCES memories(id),
  version     INTEGER NOT NULL,
  content     TEXT NOT NULL,
  changed_by  TEXT NOT NULL,                    -- user|curator|system
  change_note TEXT,
  ts          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  profile    TEXT NOT NULL DEFAULT '',          -- 项目画像文（Router R2 的比对对象）
  status     TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS project_lexicon (      -- Router R1 词表
  project_id TEXT NOT NULL REFERENCES projects(id),
  term       TEXT NOT NULL,
  weight     REAL NOT NULL DEFAULT 1,
  source     TEXT NOT NULL DEFAULT 'auto',      -- auto|manual
  PRIMARY KEY (project_id, term)
);

-- ============ 审计 ============
CREATE TABLE IF NOT EXISTS gating_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  cand_hash     TEXT NOT NULL,
  g1_result     TEXT,                           -- duplicate|reject|split|pass
  g2_sim        REAL,                           -- BM25 top1 相似度
  g2_conflict   REAL,
  g3_used       INTEGER NOT NULL DEFAULT 0,
  g3_decision   TEXT, g3_conf REAL,
  final_decision TEXT NOT NULL,                 -- keep|merge|drop|update|pending
  latency_ms    INTEGER,
  ts            INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS router_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  msg_hash     TEXT NOT NULL,
  project_id   TEXT,                            -- 判定结果，NULL=闲聊
  conf         REAL NOT NULL,
  r1_hit       INTEGER NOT NULL DEFAULT 0,
  r2_top       TEXT,                            -- JSON: 前两名分数
  r3_used      INTEGER NOT NULL DEFAULT 0,
  scope        TEXT NOT NULL,                   -- project|mixed|chat
  hits_n       INTEGER, filtered_n INTEGER,
  latency_ms   INTEGER,
  ts           INTEGER NOT NULL
);

-- ============ 做梦 ============
CREATE TABLE IF NOT EXISTS dream_lock (           -- 多窗口互斥（单行锁）
  id INTEGER PRIMARY KEY CHECK (id = 1),
  window_id TEXT NOT NULL,
  lease_until INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS dream_runs (           -- 收据与可重放审计
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,                     -- light|deep|manual
  status     TEXT NOT NULL,                     -- done|interrupted|shadow
  snapshot_id TEXT,                             -- 快照目录名
  input_hash TEXT NOT NULL,                     -- 输入快照 sha256（可离线重放验证）
  decisions  TEXT NOT NULL DEFAULT '[]',        -- JSON：[{action,target,why,conf}]
  receipt    TEXT NOT NULL DEFAULT '',          -- 人读摘要
  ts         INTEGER NOT NULL
);

-- ============ 元 ============
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL,
  note TEXT
);

-- 全文检索（CJK bigram 分词器由 bm25.ts 实现，FTS5 存分词结果）
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(title, content, keywords);
`

export interface Migration {
  version: number
  name: string
  statements: string[]
}

/** 迁移链：追加新迁移到数组尾部，严禁修改已发布的迁移。 */
export const MIGRATIONS: Migration[] = [
  { version: 1, name: 'm1-schema-v1', statements: [SCHEMA_V1_DDL] },
  // v2（M2~M6）：命中计数列。heat 公式里的「命中」需要落库计数，晋升/衰减全靠它。
  { version: 2, name: 'm2-hits-column', statements: ['ALTER TABLE memories ADD COLUMN hits INTEGER NOT NULL DEFAULT 0'] },
  // v3（2026-10-11）：① 馆长对话持久化（切会话/重载面板不丢历史）② 个性化指令（全局 + 按工作区）。
  {
    version: 3,
    name: 'm3-curator-chat-persona',
    statements: [
      `CREATE TABLE IF NOT EXISTS curator_chat (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  role       TEXT NOT NULL,                -- user|curator
  content    TEXT NOT NULL,
  sources    TEXT NOT NULL DEFAULT '[]',   -- JSON：[{id,title}]
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_curator_chat_time ON curator_chat(created_at);`,
      `CREATE TABLE IF NOT EXISTS personalization (
  id         TEXT PRIMARY KEY,
  scope      TEXT NOT NULL,                -- global|workspace
  workspace  TEXT,                         -- 工作区名（scope=workspace 时填）
  match      TEXT,                         -- 工作区命中关键词（对路由项目名/最近文本做子串匹配）
  content    TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);`,
      `CREATE TABLE IF NOT EXISTS session_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role       TEXT NOT NULL,                -- user|assistant
  content    TEXT NOT NULL,
  project_id TEXT,                         -- 本轮路由命中的项目域（可空）
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_log_session ON session_log(session_id, id);`,
    ],
  },
  // v4（2026-10-11）：时效改写留痕。深梦改写记忆时旧文进此表（审计/面板"留痕"视图），
  // memories 本体只留新版（版本链在 memory_versions，变更链在 memory_changes，两者互补）。
  {
    version: 4,
    name: 'm4-memory-changes',
    statements: [
      `CREATE TABLE IF NOT EXISTS memory_changes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id    TEXT NOT NULL,
  change_type  TEXT NOT NULL,              -- rewrite（时效改写）|arbitrate（冲突仲裁）|stale|merge|promote
  old_content  TEXT,
  new_content  TEXT,
  reason       TEXT,
  dream_run_id INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_changes_mem ON memory_changes(memory_id, id);`,
    ],
  },
]

const VERSIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL,
  note TEXT
);`

/** 执行迁移链：返回实际应用的迁移。幂等，可安全重复调用。 */
export function migrate(db: SqlExec, now: () => number = Date.now): { from: number; to: number; applied: string[] } {
  // schema_version 表自身可能不存在（全新库），先保底建出来再读版本号。
  db.exec(VERSIONS_DDL)
  const rows = db.prepare('SELECT version FROM schema_version ORDER BY version').all() as { version: number }[]
  const appliedVersions = new Set(rows.map((r) => r.version))
  const applied: string[] = []
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const m of MIGRATIONS) {
      if (appliedVersions.has(m.version)) continue
      for (const stmt of m.statements) db.exec(stmt)
      db.prepare('INSERT OR REPLACE INTO schema_version (version, applied_at, note) VALUES (?, ?, ?)').run(
        m.version,
        now(),
        m.name,
      )
      applied.push(`${m.version}:${m.name}`)
    }
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* 回滚失败时保留原始错误 */
    }
    throw error
  }
  return { from: rows.length ? Math.min(...rows.map((r) => r.version)) : 0, to: MIGRATIONS[MIGRATIONS.length - 1].version, applied }
}

/** 时间前缀 ID：yyMMddHHmmss-xxxxxxxx（id 即创建序）。随机部分由调用方注入，保持本函数纯。 */
export function makeMemoryId(nowMs: number, randHex8: string): string {
  const d = new Date(nowMs)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  const stamp = `${String(d.getFullYear()).slice(2)}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  return `${stamp}-${randHex8.toLowerCase()}`
}

/** 四层九位的槽位合法性校验（写库前最后一道纯函数关卡） */
export const LEVEL_SLOTS: Record<number, readonly string[]> = {
  0: ['identity', 'preference', 'rule', 'goal'],
  1: ['structure', 'decision', 'todo', 'ops', 'review'],
  2: ['lesson', 'prompt', 'norm', 'knowledge'],
  3: [],
}

export function validSlot(level: number, slot: string | null): boolean {
  const allowed = LEVEL_SLOTS[level]
  if (!allowed) return false
  if (allowed.length === 0) return slot === null || slot === ''
  return slot !== null && allowed.includes(slot)
}
