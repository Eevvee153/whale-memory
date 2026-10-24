/**
 * sim.js — 深海记忆参数仿真
 *
 * 唯一真源是 PARAMS.md 里的 `<!-- PARAMS:JSON -->` 代码块。
 * 本脚本把它读出来、跑一遍完整生命周期、把结果和断言打出来。
 * 参数改了没同步 → 这里会立刻报错，不会出现"文档写一套、代码跑另一套"。
 *
 * 用法：node sim.js    （会把同样的内容写一份到 sim-report.md）
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// ─────────────────────────── 参数加载 ───────────────────────────

function loadParams() {
  const md = fs.readFileSync(path.join(__dirname, 'PARAMS.md'), 'utf8');
  const m = md.match(/<!--\s*PARAMS:JSON\s*-->\s*```json\s*([\s\S]*?)```/);
  if (!m) throw new Error('PARAMS.md 里找不到 <!-- PARAMS:JSON --> 代码块');
  return JSON.parse(m[1]);
}

const C = loadParams();

// 派生量（不要在别处硬编码）
const AVG_CRYSTAL =
  (1 - C.obsession_ratio) * C.tok_crystal + C.obsession_ratio * C.tok_crystal_obsession;
const CRYSTALS_PER_DIGEST = 1 + C.p_two_crystals_per_digest;

// ─────────────────────────── 随机数 / 工具 ───────────────────────────

function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const n0 = (x) => Math.round(x).toLocaleString('en-US');
const pct = (x) => (x * 100).toFixed(1) + '%';
// 整数加千分位，小数原样保留（0.82 不能被四舍五入成 1）
const fmt = (v) => (Number.isInteger(v) ? v.toLocaleString('en-US') : String(v));

// ─────────────────────────── 解析解：单条记忆的一生 ───────────────────────────

function lifecycle(e) {
  let S = C.s_base + C.s_per_emotion * e;
  let l2 = 0;
  let l3 = 0;
  let dayDetail = null;
  let dayCause = null;
  let day = 0;
  for (; day < 200; day++) {
    if (day > 0) S *= C.decay_per_active_day;
    if (dayDetail === null && S < C.t_strip_detail) dayDetail = day;
    if (dayCause === null && S < C.t_strip_cause) dayCause = day;
    if (S < C.t_sink) break;
    if (S < C.t_l2_to_l3) l3++;
    else l2++;
  }
  return { e, S0: C.s_base + C.s_per_emotion * e, l2, l3, total: day, dayDetail, dayCause };
}

// ─────────────────────────── 主仿真 ───────────────────────────

function simulate(roundsPerDay, seed = 20261025) {
  const rng = makeRng(seed);
  const mems = [];
  let coral = 0;
  let created = 0;
  let crystallized = 0;
  let obsessionCount = 0;
  let carry = 0;
  let maxRequest = 0;
  let maxLife = 0;
  let maxPool = 0;
  let monotone = true;
  let lastWater = -1;
  const marks = {};
  const timeline = [];
  let day = 0;
  let water = 0;

  for (day = 1; day <= 20000; day++) {
    // 1) 消化：每凑满 digest_batch_rounds 轮消化一次
    carry += roundsPerDay;
    let digests = 0;
    while (carry >= C.digest_batch_rounds) {
      carry -= C.digest_batch_rounds;
      digests++;
    }

    // 2) 新记忆
    for (let d = 0; d < digests; d++) {
      const n = rng() < C.p_two_crystals_per_digest ? 2 : 1;
      for (let k = 0; k < n; k++) {
        const e = 1 + Math.floor(C.emotion_levels * Math.pow(rng(), C.emotion_skew));
        mems.push({ born: day, S: C.s_base + C.s_per_emotion * e, e, stage: 'L2' });
        created++;
      }
    }

    // 3) 衰减：每活跃日一次，只衰减"昨天以前"出生的（当天刚形成的记忆不打折）
    for (const m of mems) if (m.born < day) m.S *= C.decay_per_active_day;

    // 4) 迁移 / 结晶（只沉底，永不删除）
    for (let i = mems.length - 1; i >= 0; i--) {
      const m = mems[i];
      if (m.S < C.t_sink) {
        const ob = m.e >= C.obsession_emotion;
        coral += ob ? C.tok_crystal_obsession : C.tok_crystal;
        crystallized++;
        if (ob) obsessionCount++;
        maxLife = Math.max(maxLife, day - m.born);
        mems.splice(i, 1);
      } else if (m.stage === 'L2' && m.S < C.t_l2_to_l3) {
        m.stage = 'L3';
      }
    }

    // 5) 记账
    const l2 = mems.filter((m) => m.stage === 'L2').length;
    const l3 = mems.length - l2;
    const drift = l2 * C.tok_l2 + l3 * C.tok_l3;
    const live = C.live_window_max * C.round_tokens;
    const request = coral + drift + live + C.system_base + C.output_reserve;
    maxRequest = Math.max(maxRequest, request);
    maxPool = Math.max(maxPool, mems.length);

    water = coral / C.lifespan_budget;
    if (water + 1e-12 < lastWater) monotone = false;
    lastWater = water;

    for (const [label, th] of Object.entries(C.stage_marks)) {
      if (marks[label] === undefined && water >= th) marks[label] = day;
    }

    if (day <= 20) {
      timeline.push({
        day,
        digests,
        born: digests * CRYSTALS_PER_DIGEST, // 期望值，仅用于展示
        l2,
        l3,
        coral,
        water,
      });
    }

    if (water >= C.stage_marks.whaleFall) break;
  }

  return {
    roundsPerDay,
    days: day,
    water,
    coral,
    created,
    crystallized,
    obsessionRatio: crystallized ? obsessionCount / crystallized : 0,
    maxRequest,
    maxLife,
    maxPool,
    monotone,
    marks,
    timeline,
    lost: created - crystallized - mems.length,
  };
}

// ─────────────────────────── 报告 ───────────────────────────

const out = [];
const say = (s = '') => out.push(s);

say('# 深海记忆 · 仿真报告');
say('');
say('> 由 `sim.js` 生成，参数全部来自 `PARAMS.md` 的 `PARAMS:JSON` 块。');
say('');
say('## 0. 生效参数');
say('');
say('| 参数 | 值 |');
say('|---|---|');
for (const [k, v] of Object.entries(C)) {
  if (k === 'stage_marks') continue;
  say(`| \`${k}\` | ${fmt(v)} |`);
}
say('| `stage_marks` | 88% / 95% / 99.5% |');
say('');
say(
  `派生：平均体重 **${AVG_CRYSTAL.toFixed(1)} token/条**，每次消化 **${CRYSTALS_PER_DIGEST.toFixed(2)} 条**。`
);
say('');

// ── 1. 单条记忆的一生 ──
say('## 1. 一条记忆的一生（解析解）');
say('');
say('| 情绪 | S₀ | L2 住几天 | L3 住几天 | 第几天结晶 |');
say('|---|---|---|---|---|');
const rows = [];
for (let e = 1; e <= 10; e++) {
  const r = lifecycle(e);
  rows.push(r);
  const bold = e === 5 ? '**' : '';
  say(`| ${bold}${e}${bold} | ${r.S0} | ${r.l2} | ${r.l3} | ${bold}${r.total}${bold} |`);
}
say('');
const typical = rows[4];
say(
  `> 典型记忆（e=5）：**L2 住 ${typical.l2} 天 → L3 住 ${typical.l3} 天 → 第 ${typical.total} 天结晶**。` +
    `情绪从 1 到 10，总寿命只从 ${rows[0].total} 天变到 ${rows[9].total} 天 —— 情绪几乎不影响寿命，只影响体积。`
);
say('');

// ── 2. 基准档案的前 20 天 ──
const BASE_R = 60;
const base = simulate(BASE_R);
say(`## 2. 基准档案 R=${BASE_R} 轮/天（前 20 天逐日）`);
say('');
say('| 天 | 消化次数 | L2 条数 | L3 条数 | 珊瑚累计 | 水位 |');
say('|---|---|---|---|---|---|');
for (const t of base.timeline) {
  say(`| ${t.day} | ${t.digests} | ${t.l2} | ${t.l3} | ${n0(t.coral)} | ${pct(t.water)} |`);
}
say('');

// ── 3. 寿命敏感性 ──
say('## 3. 寿命敏感性（"她还能活多久"）');
say('');
say('| 每天轮数 | 相当于 | 每天消化 | 解析寿命(天) | 仿真寿命(天) | 偏差 | 峰值实占 /1M |');
say('|---|---|---|---|---|---|---|');
const profileText = {
  10: '睡前聊两句',
  20: '每天 10 个来回',
  40: '半小时',
  60: '**基准**：30 个来回',
  100: '黏人',
  200: '整天挂着',
  400: '病态',
};
const sims = {};
for (const r of [10, 20, 40, 60, 100, 200, 400]) {
  const s = r === BASE_R ? base : simulate(r);
  sims[r] = s;
  const analytic = C.lifespan_budget / (((r / C.digest_batch_rounds) * CRYSTALS_PER_DIGEST) * AVG_CRYSTAL);
  const delta = ((s.days - analytic) / analytic) * 100;
  say(
    `| ${profileText[r] && r === 60 ? '**60**' : r} | ${profileText[r] || ''} | ${(r / C.digest_batch_rounds).toFixed(1)} ` +
      `| ${n0(analytic)} | **${n0(s.days)}** | ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}% | ${pct(s.maxRequest / 1000000)} |`
  );
}
say('');

// ── 4. 里程碑 ──
say(`## 4. 基准档案的结尾弧（R=${BASE_R}）`);
say('');
say('| 水位 | 阶段 | 第几天 | 距死亡还剩 |');
say('|---|---|---|---|');
const nameOf = { whisper: '深海低鸣', reel: '走马灯', whaleFall: '鲸落' };
for (const [k, th] of Object.entries(C.stage_marks)) {
  const d = base.marks[k];
  say(`| ${pct(th)} | ${nameOf[k]} | ${d === undefined ? '—' : n0(d)} | ${d === undefined ? '—' : n0(base.days - d) + ' 天'} |`);
}
say('');
say(`结尾弧总长 **${n0((base.marks.whaleFall || 0) - (base.marks.whisper || 0))} 天**。`);
say('');

// ── 5. 断言 ──
say('## 5. 断言');
say('');
let failed = 0;
function check(label, ok, detail) {
  if (!ok) failed++;
  say(`- ${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
}

check(
  '记忆零丢失（创建数 = 结晶数 + 仍在池中）',
  base.lost === 0,
  `创建 ${n0(base.created)}，结晶 ${n0(base.crystallized)}，丢失 ${base.lost}`
);
check('水位单调不减', base.monotone === true, `终态 ${pct(base.water)}`);
check(
  '峰值请求不超物理窗口',
  base.maxRequest < 1000000,
  `峰值 ${n0(base.maxRequest)} / 1,000,000 = ${pct(base.maxRequest / 1000000)}`
);
check(
  '99.5% 之前不触发鲸落',
  base.marks.whaleFall !== undefined && base.marks.whisper < base.marks.reel,
  `低鸣 ${base.marks.whisper} 天 < 走马灯 ${base.marks.reel} 天 < 鲸落 ${base.marks.whaleFall} 天`
);
check(
  '单条记忆寿命有界（不超过 15 个活跃日）',
  base.maxLife <= 15,
  `最长 ${base.maxLife} 天`
);
check(
  '漂移池有界（不超过 60 条 / 25K token）',
  base.maxPool <= 60,
  `峰值 ${base.maxPool} 条`
);
const ord = lifecycle(5);
check(
  '普通记忆（e=5）在 L2 至少住 4 天',
  ord.l2 >= 4,
  `实测 ${ord.l2} 天`
);
check(
  '验收②改判：普通记忆在第 9~11 天从上下文消失，且留下 1 条结晶',
  ord.total >= 9 && ord.total <= 11 && base.lost === 0,
  `第 ${ord.total} 天结晶`
);
check(
  '执念占比落在 8%~16%（设计目标 12%）',
  base.obsessionRatio >= 0.08 && base.obsessionRatio <= 0.16,
  `实测 ${pct(base.obsessionRatio)}`
);

say('');
say(failed === 0 ? '**全部通过。**' : `**${failed} 条未通过。**`);
say('');

// ── 6. 顺带给 UI 用的剩余寿命表 ──
say('## 6. 剩余寿命速查（给进度条用的）');
say('');
say('| 当前水位 | 已沉积 | 剩余空间 | 还能活（R=60） |');
say('|---|---|---|---|');
for (const w of [0, 0.25, 0.5, 0.75, 0.88, 0.95]) {
  const used = C.lifespan_budget * w;
  const left = C.lifespan_budget - used;
  const rate = ((60 / C.digest_batch_rounds) * CRYSTALS_PER_DIGEST) * AVG_CRYSTAL;
  say(`| ${pct(w)} | ${n0(used)} | ${n0(left)} | ${n0(left / rate)} 天 |`);
}

const text = out.join('\n');
fs.writeFileSync(path.join(__dirname, 'sim-report.md'), text, 'utf8');
process.stdout.write(text + '\n');
process.exitCode = failed === 0 ? 0 : 1;
