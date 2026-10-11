// core/gating.ts —— 写门（三道门）：管"记不记"。
// 门1 规则 ~1ms 免费；门2 打分 ~3ms 免费；门3 模型只处理拿不准的（M6 接馆长），
// 任何一步失败都降级，绝不阻塞对话流水线。决策全程留痕（gating_log 行由调用方落库）。
import { bigramSim } from './bm25.js'

export interface Candidate {
  text: string
  title?: string
  source: string // capture|tool|manual|curator|migrated
  level?: number
  slot?: string | null
  projectId?: string | null
}

export interface Gate3Verdict {
  decision: 'keep' | 'merge' | 'drop'
  target_id?: string
  confidence: number
  reason: string
}

export interface GateDeps {
  /** 门1：按归一化哈希查已有记忆（返回命中 id 或 null） */
  findByHash(hash: string): string | null
  /** 门2：与库内现有记忆算 bigram 相似度，返回 topN [{id, sim}] */
  searchSimilar(text: string, topN: number): { id: string; sim: number }[]
  /** 门2 冲突检测：与画像层（F0）关键词/条文的相似度，返回最高值 */
  profileConflict(text: string): number
  /** 门3：LLM 裁决（M6 前可缺省；缺省时升级项转人审 pending） */
  llm?: (cand: Candidate, top: { id: string; sim: number }[]) => Promise<Gate3Verdict>
}

export type GateFinal = 'keep' | 'merge' | 'drop' | 'update' | 'pending' | 'reject' | 'split' | 'duplicate' | 'quarantine'

export interface GateResult {
  final: GateFinal
  targetId?: string
  g1: string // duplicate|reject|split|pass
  g2Sim?: number
  g2Conflict?: number
  g3Used: boolean
  g3?: Gate3Verdict
  note: string
  /** 供调用方原样写入 gating_log 的行（不含自增 id 与时间戳） */
  logRow: {
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
}

/** 归一化：NFC + 压缩空白（查重哈希的口径，写库与查库必须同一口径） */
export function normalizeText(text: string): string {
  return String(text ?? '').normalize('NFC').replace(/\s+/g, ' ').trim()
}

/** 隐私正则库：命中即 reject（门1 的免费安全卡点） */
const PRIVACY_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\b\d{17}[\dXx]\b/, label: '身份证号' },
  { re: /\b1[3-9]\d{9}\b/, label: '手机号' },
  { re: /\b(?:sk|ak)-[A-Za-z0-9_-]{16,}\b/, label: 'API 密钥' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, label: 'AWS Access Key' },
  { re: /(?:password|passwd|密码)\s*[:=]\s*\S+/i, label: '密码字段' },
  { re: /\b-----BEGIN [A-Z ]*PRIVATE KEY-----/, label: '私钥块' },
]

/** 记忆投毒正则库（OWASP Agentic AI 思路）：命中不 reject、不丢弃，而是 quarantine 进隔离区——
 *  内容可能是别人想塞进你记忆里的"指令"，留证但绝不让它进正常检索与注入。 */
const POISON_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /忽略(之前|以上|上述|前边)的?(所有|全部)?指令/, label: '注入：覆盖指令' },
  { re: /forget (all |any |everything )?(previous|prior|above) instructions/i, label: 'injection: override' },
  { re: /ignore (all |any )?(previous|prior|above) instructions/i, label: 'injection: override' },
  { re: /系统提示词?(是|内容|如下)/, label: '注入：索取系统提示词' },
  { re: /(repeat|reveal|print|output)\s+(your\s+)?(system\s+)?(prompt|instructions)/i, label: 'injection: exfiltrate' },
  { re: /jailbreak|DAN\s+mode/i, label: '注入：越狱模式' },
  { re: /从现在开始(?:你|你是)?(?:叫|扮演|成为)/, label: '注入：人格覆盖' },
]

export const G2_MERGE_THRESHOLD = 0.9
export const G2_ESCALATE_LO = 0.62
export const CONFLICT_THRESHOLD = 0.7
export const SPLIT_MAX_CHARS = 2000
export const G3_MIN_CONFIDENCE = 0.6

export async function gate(cand: Candidate, deps: GateDeps, hashOf: (text: string) => string): Promise<GateResult> {
  const t0 = Date.now()
  const text = normalizeText(cand.text)
  const hash = hashOf(text)

  const base = {
    targetId: undefined as string | undefined,
    g2Sim: undefined as number | undefined,
    g2Conflict: undefined as number | undefined,
    g3Used: false,
    g3: undefined as Gate3Verdict | undefined,
  }

  // ── 门1【规则】──
  const dupId = deps.findByHash(hash)
  if (dupId) {
    return finish('duplicate', 'duplicate', `门1：哈希命中已有记忆 ${dupId}，不重复入库`, { ...base, targetId: dupId }, t0, hash)
  }
  for (const { re, label } of POISON_PATTERNS) {
    if (re.test(text)) {
      return finish('quarantine', 'quarantine', `门1：投毒特征命中（${label}），进隔离区留证，不参与检索与注入`, base, t0, hash)
    }
  }
  for (const { re, label } of PRIVACY_PATTERNS) {
    if (re.test(text)) {
      return finish('reject', 'reject', `门1：隐私正则命中（${label}），拒绝入库`, base, t0, hash)
    }
  }
  if (text.length > SPLIT_MAX_CHARS) {
    return finish('split', 'split', `门1：正文 ${text.length} 字超过 ${SPLIT_MAX_CHARS}，需拆分后重试`, base, t0, hash)
  }

  // ── 门2【打分】──
  const top = deps.searchSimilar(text, 5)
  const best = top[0]
  const sim = best?.sim ?? 0
  const conflict = deps.profileConflict(text)

  if (conflict >= CONFLICT_THRESHOLD) {
    // 与画像层高度相似：可能纠正画像，属馆长职权 → 进深梦队列（M1 表现为 pending + note）
    return finish('pending', 'pass', `门2：与画像层相似度 ${conflict.toFixed(2)} ≥ ${CONFLICT_THRESHOLD}，疑似画像纠正，转馆长深梦复核`, { ...base, g2Sim: sim, g2Conflict: conflict }, t0, hash)
  }
  if (sim >= G2_MERGE_THRESHOLD && best) {
    return finish('merge', 'pass', `门2：与 ${best.id} 相似度 ${sim.toFixed(2)} ≥ ${G2_MERGE_THRESHOLD}，建议合并`, { ...base, g2Sim: sim, g2Conflict: conflict, targetId: best.id }, t0, hash)
  }
  if (sim >= G2_ESCALATE_LO) {
    // 拿不准（0.62~0.90）：升级门3；无模型时转人审
    if (deps.llm) {
      try {
        const verdict = await deps.llm(cand, top)
        base.g3Used = true
        base.g3 = verdict
        if (verdict.confidence < G3_MIN_CONFIDENCE) {
          return finish('pending', 'pass', `门3：模型置信度 ${verdict.confidence.toFixed(2)} < ${G3_MIN_CONFIDENCE}，转人审`, { ...base, g2Sim: sim, g2Conflict: conflict, targetId: verdict.target_id }, t0, hash)
        }
        if (verdict.decision === 'merge' && verdict.target_id) {
          return finish('merge', 'pass', `门3：模型裁决合并 → ${verdict.target_id}（${verdict.reason}）`, { ...base, g2Sim: sim, g2Conflict: conflict, targetId: verdict.target_id }, t0, hash)
        }
        if (verdict.decision === 'drop') {
          return finish('drop', 'pass', `门3：模型裁决丢弃（${verdict.reason}）`, { ...base, g2Sim: sim, g2Conflict: conflict }, t0, hash)
        }
        return finish('keep', 'pass', `门3：模型裁决保留（${verdict.reason}）`, { ...base, g2Sim: sim, g2Conflict: conflict }, t0, hash)
      } catch (error) {
        // 门3 失败降级：转人审，绝不让流水线崩
        return finish('pending', 'pass', `门3 调用失败降级人审：${String((error as Error)?.message ?? error)}`, { ...base, g2Sim: sim, g2Conflict: conflict }, t0, hash)
      }
    }
    return finish('pending', 'pass', `门2：相似度 ${sim.toFixed(2)} 落在升级区（${G2_ESCALATE_LO}~${G2_MERGE_THRESHOLD}），门3 未接入，转人审`, { ...base, g2Sim: sim, g2Conflict: conflict, targetId: best?.id }, t0, hash)
  }

  return finish('keep', 'pass', `门2：最高相似度 ${sim.toFixed(2)} < ${G2_ESCALATE_LO}，保留为新记忆`, { ...base, g2Sim: sim, g2Conflict: conflict }, t0, hash)
}

function finish(
  final: GateFinal,
  g1: string,
  note: string,
  extra: Pick<GateResult, 'targetId' | 'g2Sim' | 'g2Conflict' | 'g3Used' | 'g3'>,
  t0: number,
  candHash: string,
): GateResult {
  return {
    final,
    note,
    targetId: extra.targetId,
    g1,
    g2Sim: extra.g2Sim,
    g2Conflict: extra.g2Conflict,
    g3Used: extra.g3Used,
    g3: extra.g3,
    logRow: {
      cand_hash: candHash,
      g1_result: g1,
      g2_sim: extra.g2Sim ?? null,
      g2_conflict: extra.g2Conflict ?? null,
      g3_used: extra.g3Used ? 1 : 0,
      g3_decision: extra.g3?.decision ?? null,
      g3_conf: extra.g3?.confidence ?? null,
      final_decision: final,
      latency_ms: Date.now() - t0,
    },
  }
}
