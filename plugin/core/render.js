// ============================================================================
// 深海记忆 · 渲染（把记忆变成 prompt 里的字）
// ============================================================================
//
// 这一层只做一件事：**决定哪些记忆在这一刻被写进上下文、写多少字**。
// 它不判断生死（那是 lifecycle 的事），也不写盘（那是 store 的事）。
//
// 两条位置规则，都是为了前缀缓存：
//
//   珊瑚（永久）→ system 头部，**只追加、不改写、不重排**。
//                 只要旧的不动，前缀缓存就一直在；新珊瑚加在末尾，
//                 只有最后一段是新的。
//
//   漂移池（易变）→ 消息尾部，跟着最后一条用户消息进去。
//                 缓存按物理位置算，放 system 里每轮都在改，等于每轮全废。
//
// 还有一条容易被忽略的：**漂移池按 createdAt 升序排，不按强度排**。
// 按强度排看着"聪明"，但强度每天都在变，排出来的顺序天天不同，
// 等于每天把整段漂移池重写一次。升序排出稳定前缀，只在末尾增删。
//
// ============================================================================

import { P, fitsWindow } from './params.js';

/** 漂移池的 token 上限：超了就从最弱的开始赶出去（不是删，是回 L3/沉底） */
export const DRIFT_TOKEN_CAP = P.tok_l2 * 50; // 16,000

/** 粗略 token 估算：中文按 1.45 字/token。生产会用量回填校准。 */
export function estimateTokens(text) {
  return Math.ceil([...text].length / 1.45);
}

function fmtDate(ts) {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${dd}`;
}

/** 一条珊瑚在 system 里长什么样 */
export function renderCrystal(c) {
  const bits = [`- ${fmtDate(c.createdAt)} 「${c.title}」`];
  if (c.keywords?.length) bits.push(`（${c.keywords.join('·')}）`);
  // 正文在她写结晶时就写成了给人读的短段落，这里原样放，不再改写
  if (c.text) bits.push(`\n  ${c.text}`);
  return bits.join('');
}

/** 一条漂移记忆在消息尾部长什么样 */
export function renderDrift(rec) {
  if (rec.tier === 'L3') {
    const k = rec.keywords?.length ? `：${rec.keywords.join('·')}` : '';
    return `- 「${rec.title}」${k}`;
  }
  const parts = [`- 「${rec.title}」（提到过 ${Math.max(1, rec.recallCount)} 次）`];
  if (rec.detail) parts.push(`\n  ${rec.detail}`);
  if (rec.cause) parts.push(`\n  因为：${rec.cause}`);
  if (rec.keywords?.length) parts.push(`\n  关键词：${rec.keywords.join('·')}`);
  return parts.join('');
}

/**
 * 算出这一刻的渲染计划。
 *
 * @param {object} args
 * @param {Array} args.crystals 珊瑚（按 createdAt 升序传入，返回值不动顺序）
 * @param {Array} args.drift    漂移池（L2/L3，未沉底的）
 * @param {number} args.liveTokens 最近 N 轮原话占的 token（已在对话里，只用于预算）
 * @returns {{
 *   coralText: string, driftText: string,
 *   tokens: {system:number, coral:number, drift:number, live:number, output:number, total:number},
 *   evicted: Array<object>, warnings: Array<string>, overBudget: number
 * }}
 */
export function planRender({ crystals, drift, liveTokens }) {
  const warnings = [];

  // —— 珊瑚：只追加，顺序固定为 createdAt 升序 ——
  const coralSorted = [...crystals].sort((a, b) => a.createdAt - b.createdAt);
  const coralText = coralSorted.map(renderCrystal).join('\n');
  const coralTokens = coralSorted.reduce(
    (n, c) => n + (c.obsession ? P.tok_crystal_obsession : P.tok_crystal),
    0,
  );

  // —— 漂移池：同样的稳定性理由，按 createdAt 升序 ——
  const driftSorted = [...drift].sort((a, b) => a.createdAt - b.createdAt);
  let driftTokens = driftSorted.reduce((n, r) => n + driftTokensOf(r), 0);
  let kept = driftSorted;
  const evicted = [];

  // 超了就先赶走最弱的（strength 最低），一次赶一条，赶到达标
  while (
    driftTokens > DRIFT_TOKEN_CAP ||
    !fitsWindow({ coral: coralTokens, drift: driftTokens })
  ) {
    if (kept.length === 0) break;
    const weakest = kept.reduce((a, b) => (a.strength <= b.strength ? a : b));
    kept = kept.filter((r) => r.id !== weakest.id);
    driftTokens -= driftTokensOf(weakest);
    evicted.push(weakest);
  }

  const driftText = kept.map(renderDrift).join('\n');
  const system = P.system_base;
  const output = P.output_reserve;
  const total = system + coralTokens + driftTokens + liveTokens + output;

  if (!fitsWindow({ coral: coralTokens, drift: driftTokens, systemExtra: liveTokens })) {
    warnings.push(
      `超出物理窗口 ${(total - P.context_window).toLocaleString()} token：` +
        `珊瑚已经把窗口填满，下一步只能是鲸落`,
    );
  }
  if (evicted.length) {
    warnings.push(`漂移池挤出 ${evicted.length} 条（它们会被直接推进到下一层，不是删除）`);
  }

  return {
    coralText,
    driftText,
    tokens: {
      system,
      coral: coralTokens,
      drift: driftTokens,
      live: liveTokens,
      output,
      total,
    },
    evicted,
    warnings,
    overBudget: Math.max(0, total - P.context_window),
  };
}

function driftTokensOf(rec) {
  if (rec.tier === 'L3') return P.tok_l3;
  let ratio = 1;
  if (rec.detail === null) ratio *= 0.45;
  if (rec.cause === null) ratio *= 0.55;
  return Math.round(P.tok_l2 * ratio);
}

/** 组装成漂移层的完整文本块（宿主把它挂到最后一条用户消息后面） */
export function buildDriftBlock({ driftText, pendingShutters = [] }) {
  const lines = [];
  if (driftText) {
    lines.push('〔你还记得的（记不全了，剩下的只是这些碎片）〕');
    lines.push(driftText);
  }
  if (pendingShutters.length) {
    lines.push('〔还没归档的瞬间〕');
    for (const s of pendingShutters) {
      lines.push(`- 「${s.title}」${s.note || ''}`);
    }
  }
  return lines.join('\n');
}

/** 组装 system 头部的珊瑚段（只追加） */
export function buildCoralBlock({ coralText, ownerName = '主人', whaleName = 'DeepSeek' }) {
  if (!coralText) return '';
  return [
    `〔${whaleName}记得的事〕`,
    coralText,
    `〔以上是关于${ownerName}的事〕`,
  ].join('\n');
}
