// ============================================================================
// 深海记忆 · 风化规则（纯函数，无 IO，无宿主依赖）
// ============================================================================
//
// 这一层只回答一个问题：**一条记忆在某个时刻长什么样**。
// 它不碰磁盘、不碰上下文、不调模型。所有"她忘了什么"的判断都在这里，
// 所以这里可以、也必须被单元测试钉死。
//
// 三个概念，务必分清：
//   tier      —— 住在哪一层（L2 日记 / L3 残片 / CORAL 珊瑚）
//   strength  —— 强度 0..100，只降不升（回血除外）
//   render    —— 塞进上下文的字有多少（**与磁盘上存了多少无关**）
//
// 最后一个是要命的那条：store/render 分离。磁盘永远存全量，`detail=null`
// 只影响往 prompt 里写多少字。否则"忘记"就变成了数据销毁，鲸落时墓志铭拼不出来。
//
// ============================================================================

import { P, clamp, s0 } from './params.js';

/** 记忆形态 */
export const Tier = Object.freeze({
  L2: 'L2', // 中层海水：完整日记，320 token
  L3: 'L3', // 残片：只剩标题 + 关键词，40 token
  CORAL: 'CORAL', // 珊瑚：永久结晶，沉在 system 头部
});

/** 新建一条记忆（刚消化出来的样子） */
export function createRecord({
  id,
  emotion,
  title,
  detail,
  cause,
  keywords = [],
  now = Date.now(),
  obsession = false,
  rawBatchId = null,
}) {
  const e = clamp(Math.round(emotion), 1, P.emotion_levels);
  return {
    id,
    createdAt: now,
    updatedAt: now,
    tier: Tier.L2,
    emotion: e,
    title,
    detail,
    cause,
    keywords: [...keywords],
    strength: s0(e),
    recallCount: 0,
    obsession: obsession || e >= P.obsession_emotion,
    rawBatchId,
    sealed: false,
    // 只涨不跌的里程记录：这条记忆一共沉积了多少 token（结晶时才落账）
    deposited: 0,
  };
}

/**
 * 推进一天的衰减。
 *
 * 关键设计：**按活跃日推进，不按消化次数**。
 * 企划书原案是"每消化一次 ×0.82"，结果一个通宵 8 次消化 = 0.82⁸ = 0.21，
 * 记忆一夜清零。改成"每天最多衰减一次"后，熬夜聊天不再惩罚记忆。
 *
 * 返回新对象 + 本次发生的事件（供日志与 UI 用）。
 */
export function decayOneDay(rec) {
  if (rec.tier === Tier.CORAL) return { rec, events: [] };

  const s = rec.strength * P.decay_per_active_day;
  const next = { ...rec, strength: s, updatedAt: Date.now() };
  const events = [];

  // 剥离顺序：先丢"怎么发生的"（cause），再丢"发生了什么"（detail），
  // 最后才降层。反过来会出现"只剩一句原因、没有事"的怪东西。
  if (s < P.t_strip_detail && next.detail !== null) {
    next.detail = null;
    events.push({ type: 'strip-detail', id: rec.id });
  }
  if (s < P.t_strip_cause && next.cause !== null) {
    next.cause = null;
    events.push({ type: 'strip-cause', id: rec.id });
  }
  if (s < P.t_l2_to_l3 && next.tier === Tier.L2) {
    next.tier = Tier.L3;
    events.push({ type: 'tier-l2-to-l3', id: rec.id });
  }
  if (s < P.t_sink) {
    events.push({ type: 'sink', id: rec.id });
  }
  return { rec: next, events };
}

/** 一条记忆要沉底了（该做回光了） */
export function isSinking(rec) {
  return rec.tier !== Tier.CORAL && rec.strength < P.t_sink;
}

/**
 * 这条记忆此刻要塞进上下文多少 token。
 *
 * 注意：仿真里 L2 一律按 320 算，是**保守上界**（假设她一直没丢细节）。
 * 真实渲染会随 detail/cause 的剥离而变短，所以实际占用只会比仿真更低。
 */
export function renderSize(rec) {
  if (rec.tier === Tier.CORAL) {
    return rec.obsession ? P.tok_crystal_obsession : P.tok_crystal;
  }
  if (rec.tier === Tier.L3) return P.tok_l3;
  // L2：按剩下多少字段给一个比例，full=1.0 / 丢 detail=0.45 / 再丢 cause=0.25
  let ratio = 1;
  if (rec.detail === null) ratio *= 0.45;
  if (rec.cause === null) ratio *= 0.55;
  return Math.round(P.tok_l2 * ratio);
}

/** 回血：被关键词命中，强度 +25（上限 100） */
export function recall(rec, boost = 25) {
  if (rec.tier === Tier.CORAL) {
    return { ...rec, recallCount: rec.recallCount + 1 };
  }
  return {
    ...rec,
    strength: clamp(rec.strength + boost, 0, 100),
    recallCount: rec.recallCount + 1,
    updatedAt: Date.now(),
  };
}

/** 升格为珊瑚（回光完成后调用）。此时才把 token 计入里程。 */
export function toCoral(rec, { title, keywords, text, now = Date.now() }) {
  return {
    ...rec,
    tier: Tier.CORAL,
    title,
    keywords: keywords?.length ? [...keywords] : rec.keywords,
    detail: null,
    cause: null,
    strength: 100,
    sealed: true,
    updatedAt: now,
    deposited: rec.obsession ? P.tok_crystal_obsession : P.tok_crystal,
    // 原始正文仍然保留在磁盘（用于鲸落纪念册），只是不再进上下文
  };
}

// ---------------------------------------------------------------------------
// 解析解：给定情绪，这条记忆活多久（文档与测试共用的那张表）
// ---------------------------------------------------------------------------

/**
 * @returns {{s0:number, daysInL2:number, daysInL3:number, totalDays:number}}
 *   daysInL2 指"从建出来的那天算起，还是完整日记的天数"
 */
export function lifecycle(emotion) {
  const start = s0(emotion);
  let s = start;
  let l2 = 0;
  let l3 = 0;
  let guard = 0;
  while (s >= P.t_sink && guard++ < 1000) {
    if (s >= P.t_l2_to_l3) l2 += 1;
    else l3 += 1;
    s *= P.decay_per_active_day;
  }
  return { s0: start, daysInL2: l2, daysInL3: l3, totalDays: l2 + l3 };
}

/** 整张表（e=1..10），给文档和 UI 用 */
export function lifecycleTable() {
  return Array.from({ length: P.emotion_levels }, (_, i) => {
    const e = i + 1;
    return { emotion: e, ...lifecycle(e) };
  });
}
