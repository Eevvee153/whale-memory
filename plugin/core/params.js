// ============================================================================
// 深海记忆 · 冻结参数（运行时唯一来源）
// ============================================================================
//
// 这里每一个数都来自 PARAMS.md 的 `<!-- PARAMS:JSON -->` 块，并且被
// `tools/check-params.js` 逐字段比对。改参数只改 PARAMS.md，然后跑：
//
//     node tools/check-params.js        # 会告诉你哪个字段漂了
//     node ../sim.js                    # 重算寿命
//
// 为什么不让插件直接读 PARAMS.md：
//   1. 插件发布时不带 .md，运行时不该依赖文档存在；
//   2. PARAMS.md 里的 JSON 是给人和仿真看的，运行时需要的是数字与派生量；
//   3. 把"文档是源、代码是投影"这件事变成一条可执行断言，比注释可靠。
//
// 但把两边手抄一遍一定会漂，所以 check-params.js 同时是测试和同步器：
//   它从 PARAMS.md 抠出 JSON，逐字段 diff，漂了就 exit 1。
//
// ============================================================================

/** 原始参数：与 PARAMS.md 的 PARAMS:JSON 块一一对应 */
export const P = Object.freeze({
  // —— 上下文与预算 ——
  context_window: 1_000_000,
  lifespan_budget: 700_000,
  system_base: 3_000,
  output_reserve: 8_000,

  // —— 节奏 ——
  digest_batch_rounds: 20,
  live_window_max: 30,
  round_tokens: 250,

  // —— 风化 ——
  decay_per_active_day: 0.82,
  s_base: 40,
  s_per_emotion: 6,
  emotion_levels: 10,
  emotion_skew: 2.8,

  // —— 阈值（强度） ——
  t_l2_to_l3: 32,
  t_strip_detail: 24,
  t_strip_cause: 18,
  t_sink: 12,

  // —— 体积（token） ——
  tok_l2: 320,
  tok_l3: 40,
  tok_crystal: 320,
  tok_crystal_obsession: 840,

  // —— 执念 ——
  obsession_emotion: 8,
  obsession_ratio: 0.12,
  p_two_crystals_per_digest: 0.3,

  // —— 水位阶段 ——
  stage_marks: Object.freeze({ whisper: 0.88, reel: 0.95, whaleFall: 0.995 }),
});

// ---------------------------------------------------------------------------
// 派生量
// ---------------------------------------------------------------------------
//
// 这些是"从 P 算出来的常数"，不单独配置。放在这里而不是散在代码里，
// 是因为它们会被测试和 UI 同时用到——两处各算一遍迟早差一位。

/** 每次消化平均产出几条记忆：1 + p_two */
export const CRYSTALS_PER_DIGEST = 1 + P.p_two_crystals_per_digest; // 1.3

/** 单条结晶的平均体重（普通/执念按比例加权） */
export const AVG_WEIGHT = Math.round(
  (1 - P.obsession_ratio) * P.tok_crystal +
    P.obsession_ratio * P.tok_crystal_obsession,
); // 382

/** 每次消化沉积多少 token —— 寿命公式的分子单位 */
export const DEPOSIT_PER_DIGEST = Math.round(CRYSTALS_PER_DIGEST * AVG_WEIGHT); // 497

/** 每次消化消耗多少轮对话（= 一集的长度） */
export const DIGEST_ROUNDS = P.digest_batch_rounds;

/** 情绪 1..10 → 初始强度 */
export function s0(emotion) {
  const e = clamp(Math.round(emotion), 1, P.emotion_levels);
  return P.s_base + P.s_per_emotion * e;
}

/** 夹逼 */
export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * 剩余寿命（天）。只对基准强度成立，UI 上要标"按现在的聊天频率"。
 * 公式来自 PARAMS.md §6：days = E / (R × 24.87)，这里用仿真校准后的
 * 日沉积反算，避免把 24.87 这个魔数抄两遍。
 */
export function daysLeft(mileage, roundsPerDay) {
  const perDay = (roundsPerDay / DIGEST_ROUNDS) * DEPOSIT_PER_DIGEST;
  if (perDay <= 0) return Infinity;
  const left = P.lifespan_budget - mileage;
  return Math.max(0, left / perDay);
}

/** 里程碑：给鲸落/走马灯/低鸣用 */
export function stageOf(mileage) {
  const ratio = mileage / P.lifespan_budget;
  if (ratio >= P.stage_marks.whaleFall) return 'whaleFall';
  if (ratio >= P.stage_marks.reel) return 'reel';
  if (ratio >= P.stage_marks.whisper) return 'whisper';
  return 'normal';
}

/** 安全上限：真实请求 = 系统 + 珊瑚 + 漂移池 + 输出预留 ≤ 物理窗口 */
export function fitsWindow({ coral, drift, systemExtra = 0 }) {
  return (
    P.system_base + systemExtra + coral + drift + P.output_reserve < P.context_window
  );
}
