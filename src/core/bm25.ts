// core/bm25.ts —— CJK bigram 分词 + BM25 检索 + bigram 相似度（纯函数）
// 借鉴喵记忆已验证的 CJK bigram 方案：对中日韩文按滑窗二元组分词，
// 对拉丁/数字按词切分。FTS5 表 memories_fts 存的就是这里产出的分词结果。

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
const WORD_RE = /[a-zA-Z0-9_]+/

/** 分词：CJK 连续段取 bigram（长度 1 退化为 unigram），拉丁/数字段取小写词。 */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  const s = String(text ?? '')
  let i = 0
  const n = s.length
  while (i < n) {
    const ch = s[i]
    if (CJK_RE.test(ch)) {
      let j = i
      while (j < n && CJK_RE.test(s[j])) j++
      const seg = s.slice(i, j)
      if (seg.length === 1) tokens.push(seg)
      else for (let k = 0; k + 1 < seg.length; k++) tokens.push(seg.slice(k, k + 2))
      i = j
    } else if (WORD_RE.test(ch)) {
      let j = i
      while (j < n && WORD_RE.test(s[j])) j++
      tokens.push(s.slice(i, j).toLowerCase())
      i = j
    } else {
      i++
    }
  }
  return tokens
}

/** bigram 多重集合（相似度用） */
export function bigramSet(text: string): Map<string, number> {
  const m = new Map<string, number>()
  for (const t of tokenize(text)) m.set(t, (m.get(t) ?? 0) + 1)
  return m
}

/** Dice 相似度（0~1）：2|A∩B| / (|A|+|B|)。完全相同=1，无公共 token=0。 */
export function bigramSim(a: string, b: string): number {
  const A = bigramSet(a)
  const B = bigramSet(b)
  let overlap = 0
  let sum = 0
  for (const [t, c] of A) {
    sum += c
    const cb = B.get(t)
    if (cb) overlap += Math.min(c, cb)
  }
  for (const c of B.values()) sum += c
  return sum === 0 ? 0 : (2 * overlap) / sum
}

/** 覆盖度（0~1）：|A∩B| / min(|A|,|B|)。短画像 vs 长记忆的归属/契合判定用这个——
 *  衡量「短文档的 bigram 被长文档覆盖了多少」，比 Dice 更适合不对称比对。 */
export function bigramContainment(a: string, b: string): number {
  const A = bigramSet(a)
  const B = bigramSet(b)
  let overlap = 0
  let sumA = 0
  let sumB = 0
  for (const [t, c] of A) {
    sumA += c
    const cb = B.get(t)
    if (cb) overlap += Math.min(c, cb)
  }
  for (const c of B.values()) sumB += c
  const denom = Math.min(sumA, sumB)
  return denom === 0 ? 0 : overlap / denom
}

export interface Bm25Doc {
  id: string
  text: string
}

interface DocEntry {
  id: string
  len: number
  tf: Map<string, number>
}

export interface Bm25Index {
  docs: DocEntry[]
  avgdl: number
  idf: Map<string, number>
}

const BM25_K1 = 1.5
const BM25_B = 0.75

/** 构建内存 BM25 索引。M1 规模（千级文档）足够；大规模时换 FTS5 表检索。 */
export function buildIndex(docs: Bm25Doc[]): Bm25Index {
  const entries: DocEntry[] = []
  const df = new Map<string, number>()
  let totalLen = 0
  for (const d of docs) {
    const tf = new Map<string, number>()
    for (const t of tokenize(d.text)) {
      tf.set(t, (tf.get(t) ?? 0) + 1)
      df.set(t, (df.get(t) ?? 0) + 1)
    }
    const len = [...tf.values()].reduce((a, b) => a + b, 0)
    totalLen += len
    entries.push({ id: d.id, len, tf })
  }
  const n = entries.length || 1
  const idf = new Map<string, number>()
  for (const [t, f] of df) idf.set(t, Math.log(1 + (n - f + 0.5) / (f + 0.5)))
  return { docs: entries, avgdl: totalLen / n || 1, idf }
}

/** BM25 查询，返回按分数降序的 [{id, score}]。 */
export function search(index: Bm25Index, query: string, topK = 10): { id: string; score: number }[] {
  const qtf = new Map<string, number>()
  for (const t of tokenize(query)) qtf.set(t, (qtf.get(t) ?? 0) + 1)
  const scores: { id: string; score: number }[] = []
  for (const doc of index.docs) {
    let score = 0
    for (const [t, qf] of qtf) {
      const tf = doc.tf.get(t)
      if (!tf) continue
      const idf = index.idf.get(t) ?? 0
      const denom = tf + BM25_K1 * (1 - BM25_B + (BM25_B * doc.len) / index.avgdl)
      score += idf * ((tf * (BM25_K1 + 1)) / denom) * qf
    }
    if (score > 0) scores.push({ id: doc.id, score })
  }
  scores.sort((a, b) => b.score - a.score)
  return scores.slice(0, topK)
}

/** 把分词结果拼成 FTS5 查询安全的空白分隔串（供 memories_fts 写入/查询用）。 */
export function toFtsText(text: string): string {
  return tokenize(text).join(' ')
}
