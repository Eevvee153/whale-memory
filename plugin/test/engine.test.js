// ============================================================================
// 引擎与规则的单元测试（node --test）
// ============================================================================
//
// 这些测试钉死的是**会产生"她性格变了/她失忆了"的**那几个点，
// 不是覆盖率。按优先级：
//
//   1. 生命周期表 = 文档里的表（数字对不上，整篇 PARAMS.md 作废）
//   2. 剥离顺序（先丢原因再丢事情，不能反过来）
//   3. 零丢失（沉底 ≠ 删除；沉底后一定留得下一条珊瑚）
//   4. 里程单调（水位只能涨，涨了才能叫"寿命"）
//   5. 渲染顺序稳定（顺序一变，前缀缓存全废）
//
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { P } from '../core/params.js';
import {
  Tier,
  createRecord,
  decayOneDay,
  isSinking,
  renderSize,
  toCoral,
  lifecycle,
  lifecycleTable,
} from '../core/lifecycle.js';
import { Store } from '../core/store.js';
import { Engine, dayKeyOf } from '../core/engine.js';
import { planRender, DRIFT_TOKEN_CAP } from '../core/render.js';

async function tmpRoot(name) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `wm-${name}-`));
  return dir;
}

// ---------------------------------------------------------------------------

test('生命周期表与 PARAMS.md §3 一致', () => {
  const byE = Object.fromEntries(lifecycleTable().map((r) => [r.emotion, r]));
  // 文档里那张表：e / S₀ / L2 天 / L3 天 / 合计
  assert.deepEqual(
    [1, 5, 10].map((e) => [e, byE[e].s0, byE[e].daysInL2, byE[e].daysInL3, byE[e].totalDays]),
    [
      [1, 46, 2, 5, 7],
      [5, 70, 4, 5, 9],
      [10, 100, 6, 5, 11],
    ],
  );
});

test('风化：先丢原因，再丢事情，最后降层、沉底', () => {
  let rec = createRecord({
    id: 'm1',
    emotion: 5,
    title: 't',
    detail: '发生了什么',
    cause: '为什么',
    keywords: ['k'],
  });
  const seen = [];
  for (let day = 0; day < 12; day += 1) {
    const { rec: next } = decayOneDay(rec);
    rec = next;
    seen.push({
      day,
      strength: Math.round(rec.strength * 100) / 100,
      detail: rec.detail,
      cause: rec.cause,
      tier: rec.tier,
    });
  }
  const detailGoneDay = seen.find((s) => s.detail === null).day;
  const causeGoneDay = seen.find((s) => s.cause === null).day;
  const l3Day = seen.find((s) => s.tier === Tier.L3).day;

  assert.ok(detailGoneDay <= causeGoneDay, 'detail 不能比 cause 活得久');
  assert.ok(l3Day < detailGoneDay, 'e=5 时降层（D4）应早于丢细节（D6）');
  assert.equal(isSinking(rec), true, '第 12 天应该已经沉底');
  // 强度单调下降
  for (let i = 1; i < seen.length; i += 1) {
    assert.ok(seen[i].strength <= seen[i - 1].strength + 1e-9, '强度只能降');
  }
});

test('renderSize 随字段剥离而变小，珊瑚按 320/840 计', () => {
  const full = createRecord({ id: 'a', emotion: 5, title: 't', detail: 'd', cause: 'c' });
  assert.equal(renderSize(full), P.tok_l2);
  assert.equal(renderSize({ ...full, detail: null }), Math.round(P.tok_l2 * 0.45));
  assert.equal(renderSize({ ...full, detail: null, cause: null }), Math.round(P.tok_l2 * 0.45 * 0.55));
  assert.equal(renderSize({ ...full, tier: Tier.L3 }), P.tok_l3);
  assert.equal(renderSize({ ...full, tier: Tier.CORAL }), P.tok_crystal);
  assert.equal(renderSize({ ...full, tier: Tier.CORAL, obsession: true }), P.tok_crystal_obsession);
});

test('toCoral 才落账 deposited，且此前为 0', () => {
  const rec = createRecord({ id: 'a', emotion: 5, title: 't', detail: 'd', cause: 'c' });
  assert.equal(rec.deposited, 0, '还没沉底就不能计入里程');
  const coral = toCoral(rec, { title: 'T', keywords: ['k'], text: '正文' });
  assert.equal(coral.tier, Tier.CORAL);
  assert.equal(coral.deposited, P.tok_crystal);
  assert.equal(coral.detail, null, '珊瑚只留正文，不留中间态字段');
});

test('渲染：珊瑚顺序只由 createdAt 决定，与输入顺序无关', () => {
  const mk = (id, ts) => ({ ...createRecord({ id, emotion: 5, title: id, detail: 'd' }), createdAt: ts, tier: Tier.CORAL, text: 'x' });
  const a = mk('a', 300);
  const b = mk('b', 100);
  const c = mk('c', 200);
  const p1 = planRender({ crystals: [a, b, c], drift: [], liveTokens: 0 });
  const p2 = planRender({ crystals: [c, a, b], drift: [], liveTokens: 0 });
  assert.equal(p1.coralText, p2.coralText, '顺序不能随输入变化');
  assert.match(p1.coralText, /「b」[\s\S]*「c」[\s\S]*「a」/, '必须按时间升序');
});

test('渲染：漂移池超限时挤最弱的，且不删数据', () => {
  const mk = (i, strength) => ({
    ...createRecord({ id: `m${i}`, emotion: 5, title: `t${i}`, detail: 'd', cause: 'c' }),
    createdAt: i,
    strength,
  });
  const drift = Array.from({ length: 80 }, (_, i) => mk(i, 100 - i));
  const plan = planRender({ crystals: [], drift, liveTokens: 0 });
  assert.ok(plan.tokens.drift <= DRIFT_TOKEN_CAP, '超限后必须压到上限内');
  // 80 条 × 320 = 25,600，上限 16,000 → 必须挤出 30 条，且挤的是最强的那些的反面
  assert.equal(plan.evicted.length, 30);
  assert.ok(plan.evicted.some((r) => r.id === 'm79'), '最弱的那条必须被挤出');
  assert.ok(!plan.evicted.some((r) => r.id === 'm0'), '最强的那条不许被挤出');
});

test('引擎：零丢失、里程单调、结晶数等于沉底数', async () => {
  const root = await tmpRoot('engine');
  let clock = Date.UTC(2026, 0, 1, 14, 0, 0);
  const now = () => clock;

  const store = new Store(root);
  await store.load();

  const created = [];
  const engine = new Engine({
    store,
    now,
    digest: async () => [
      {
        title: `记忆${created.length + 1}`,
        text: '正文',
        keywords: ['k'],
        emotion: 5,
      },
    ],
    crystallize: async ({ record }) => ({
      title: `结晶-${record.title}`,
      keywords: ['k'],
      text: '回光',
    }),
  });

  const crystals = [];
  // 10 天 × 20 轮 = 10 次消化 = 10 条记忆
  for (let day = 0; day < 10; day += 1) {
    for (let r = 0; r < 20; r += 1) {
      const { events } = await engine.onRound({ text: `第${day}天第${r}轮` });
      crystals.push(...events.filter((e) => e.type === 'crystal'));
    }
    await engine.tickActiveDay().then(({ events }) => {
      crystals.push(...events.filter((e) => e.type === 'crystal'));
    });
    clock += 24 * 3600 * 1000;
  }

  const all = store.all();
  const coral = all.filter((m) => m.tier === Tier.CORAL);
  assert.equal(coral.length, store.state.crystalCount, '结晶数应与计数一致');
  assert.equal(coral.length, crystals.length, '每次回光都应留下一条珊瑚');

  // 零丢失：10 次消化 = 10 条记忆，一条都不能凭空消失
  // （沉底不是删除，只是从上下文里退场——磁盘上永远还在）
  assert.equal(all.length, 10, '不许有任何一条记忆被真删掉');

  // 里程单调，且等于已沉积珊瑚之和
  const sum = coral.reduce((n, c) => n + c.deposited, 0);
  assert.equal(store.state.mileage, sum, '里程必须等于沉积总和');

  // 沉底的都留下了珊瑚
  for (const m of all) {
    if (m.tier !== Tier.CORAL) continue;
    assert.ok(m.title.startsWith('结晶-'), '每条珊瑚都应来自一次回光');
  }
  await fs.rm(root, { recursive: true, force: true });
});

test('引擎：快门不直插上下文，只在消化时合并', async () => {
  const root = await tmpRoot('shutter');
  let clock = Date.UTC(2026, 0, 1, 14, 0, 0);
  const store = new Store(root);
  await store.load();
  const engine = new Engine({
    store,
    now: () => clock,
    digest: async () => [],
    crystallize: async () => ({ title: 'x', keywords: [], text: '' }),
  });

  await engine.addShutter({ title: '临走那句', note: '他说改完说一声', emotion: 9 });
  let plan = engine.planRender();
  assert.equal(plan.coralText, '', '快门绝不能立刻进珊瑚');
  assert.match(plan.driftBlock, /临走那句/, '快门先出现在漂移块里');

  for (let r = 0; r < 20; r += 1) await engine.onRound({ text: `r${r}` });
  assert.equal(store.state.pendingShutters.length, 0, '消化后队列清空');
  const shutters = store.all().filter((m) => m.id.startsWith('shutter'));
  assert.equal(shutters.length, 1, '快门要变成一条正式记忆');
  await fs.rm(root, { recursive: true, force: true });
});

test('存储：损坏的 memories.json 必须停机，不能静默失忆', async () => {
  const root = await tmpRoot('corrupt');
  const store = new Store(root);
  await store.load();
  await fs.writeFile(path.join(root, 'memories.json'), '{不是 JSON', 'utf8');
  const broken = new Store(root);
  await assert.rejects(() => broken.load(), /解析失败/);
  await fs.rm(root, { recursive: true, force: true });
});

test('dayKeyOf 用本地日期，跨零点算新的一天', () => {
  const a = dayKeyOf(new Date(2026, 0, 1, 23, 59, 0).getTime());
  const b = dayKeyOf(new Date(2026, 0, 2, 0, 1, 0).getTime());
  assert.notEqual(a, b);
  assert.equal(dayKeyOf(new Date(2026, 0, 1, 0, 1, 0).getTime()), a);
});
