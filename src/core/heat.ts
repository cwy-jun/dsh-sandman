// core/heat.ts —— 晋升公式（纯函数，参数可注入：馆长调参与单测都靠它）
// heat = ln(1+命中) × 丰富度 × exp(-λ·天数)
// 「丰富度」本设计定死为内容长度与关键词数的饱和函数（见 richness()）。

export interface HeatParams {
  /** 时间衰减系数 λ（天数）。越大冷得越快。 */
  lambda: number
}

export const DEFAULT_HEAT_PARAMS: HeatParams = { lambda: 0.02 }

export interface HeatInput {
  /** 命中/召回次数 */
  hits: number
  /** 正文长度（字符） */
  contentLen: number
  /** 关键词个数 */
  keywordsCount: number
  /** 距最近活跃的天数 */
  daysSinceAccess: number
}

/** 丰富度：0.5 起步，长度与关键词各自贡献，饱和封顶 1.5。 */
export function richness(input: Pick<HeatInput, 'contentLen' | 'keywordsCount'>): number {
  const lenScore = Math.min(1, Math.sqrt(Math.max(0, input.contentLen) / 800))
  const kwScore = Math.min(1, Math.max(0, input.keywordsCount) / 8)
  return Math.min(1.5, 0.5 + 0.5 * lenScore + 0.3 * kwScore)
}

/** 晋升公式主入口。输入非法时按安全默认值处理（不抛异常，保证调用方流水线不中断）。 */
export function computeHeat(input: HeatInput, params: HeatParams = DEFAULT_HEAT_PARAMS): number {
  const hits = Math.max(0, Number(input.hits) || 0)
  const days = Math.max(0, Number(input.daysSinceAccess) || 0)
  const lambda = Number.isFinite(params.lambda) && params.lambda > 0 ? params.lambda : DEFAULT_HEAT_PARAMS.lambda
  const h = Math.log(1 + hits) * richness(input) * Math.exp(-lambda * days)
  // 保留 6 位小数，避免浮点尾巴进库。
  return Math.round(h * 1e6) / 1e6
}

/** 热度档位（界面色谱用）：warm ≥ 1.0，0.4~1.0 常温，<0.4 转冷，stale/invalid 另算。 */
export function heatBand(heat: number): 'warm' | 'normal' | 'cold' {
  if (heat >= 1) return 'warm'
  if (heat >= 0.4) return 'normal'
  return 'cold'
}
