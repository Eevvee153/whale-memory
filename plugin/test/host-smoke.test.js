// ============================================================================
// 冒烟测试：apply() 能不能在"什么都没有"的宿主里活下来
// ============================================================================
//
// 这个测试不验证行为，只验证一件事：**插件加载时不会炸**。
//
// 宿主里最难查的失败是"插件装上了，但 apply 从来没被调用"——
// 比如 inject 写了一个不存在的服务名，cordis 就一直等，永远不 apply。
// 所以这里刻意给一个残缺的 ctx（没有 systemPrompt、没有 tools、没有 llm），
// 要求 apply 照样跑完、照样把档案建起来。
//
// 真实宿主里那些 @deepseek-ai/* 包这里是装不到的，正好也顺带验证了
// 动态 import 的 .catch(() => null) 兜底没有漏。
//
// ============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { apply } from '../lib/index.js';

function fakeCtx() {
  const disposers = [];
  const handlers = new Map();
  return {
    disposers,
    handlers,
    get: () => null, // systemPrompt / tools 都拿不到
    effect: (fn) => {
      const d = fn();
      if (typeof d === 'function') disposers.push(d);
      return d;
    },
    on: (name, fn) => {
      handlers.set(name, fn);
      return () => handlers.delete(name);
    },
    logger: { info() {}, warn() {} },
    llm: null,
    agentDefaultModel: null,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 删临时目录：后台的 boot 可能还在写，ENOTEMPTY 就再试几次（Windows 上很常见） */
async function rmDir(p) {
  for (let i = 0; i < 10; i += 1) {
    try {
      await fs.rm(p, { recursive: true, force: true });
      return;
    } catch {
      await sleep(50);
    }
  }
}

test('apply(): 残缺宿主里也能启动，并把档案目录建出来', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'whale-memory-'));
  try {
    const ctx = fakeCtx();
    apply(ctx, { root, instanceId: 'smoke' });

    // 启动是异步的（要等 store.load 落盘），等它一下
    let state = null;
    for (let i = 0; i < 60 && !state; i += 1) {
      await sleep(50);
      state = await fs
        .readFile(path.join(root, 'state.json'), 'utf8')
        .then((s) => JSON.parse(s))
        .catch(() => null);
    }

    assert.ok(state, 'state.json 没建出来：说明 apply 里的启动路径挂了');
    // instanceId 落的是档案目录名（Store 用 basename 兜底），不是 config 里那个
    assert.equal(state.instanceId, path.basename(root));
    assert.equal(state.mileage, 0);
    assert.deepEqual(state.pendingShutters, []);
    // 新档案第一个活跃日不该产生任何记忆
    assert.equal(state.crystalCount, 0);

    // agent/pre-step 必须挂上了
    assert.ok(ctx.handlers.has('agent/pre-step'), 'pre-step 钩子没挂上');
  } finally {
    await rmDir(root);
  }
});

test('apply(): pre-step 在 engine 还没就绪时也不炸', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'whale-memory-'));
  try {
    const ctx = fakeCtx();
    apply(ctx, { root, instanceId: 'smoke2' });
    const handler = ctx.handlers.get('agent/pre-step');
    assert.equal(typeof handler, 'function');

    // 立刻调用（此时 engine 可能还是 null）
    const decision = await handler(
      { agent: { session: { header: { id: 's1' } } }, messages: [] },
      async () => ({ kind: 'ok', messages: [] }),
    );
    assert.equal(decision.kind, 'ok');
  } finally {
    await rmDir(root);
  }
});
