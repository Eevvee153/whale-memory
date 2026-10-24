// ============================================================================
// 深海记忆 · 存储层
// ============================================================================
//
// 铁律一条：**磁盘上永远存全量，上下文里才做"忘记"。**
//
// 目录结构（每个 agent 实例一个，绝不共用全局目录）：
//
//   <dshHome>/whale-memory/<instanceId>/
//     state.json          水位、里程、消化游标、待合并的快门
//     memories.json       全部记忆（L2/L3/珊瑚），含已从上下文消失的
//     batches/<id>.json   每集 20 轮原始对话（回光时要用）
//     journal.jsonl       事件流水，只追加，出问题时唯一的现场
//
// 为什么不按会话分目录：记忆是**跨会话**的，一个实例一辈子一册。
// 为什么不放 ~/.dsh/whale_memory：工作会话和角色会话会共用一个脑子。
//
// 写盘用 tmp + rename，保证任何时刻 memeries.json 要么是旧的完整的，
// 要么是新的完整的，不会出现半个 JSON 让她的记忆全丢。
//
// ============================================================================

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const SCHEMA_VERSION = 1;

/** 本地日期键，用于"每个活跃日衰减一次" */
export function dayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function emptyState(instanceId) {
  return {
    version: SCHEMA_VERSION,
    instanceId,
    createdAt: Date.now(),
    // —— 里程：累计沉积进 system 的 token，只增不减 ——
    mileage: 0,
    // —— 节奏 ——
    lastActiveDay: null, // 上次衰减日
    digestCursor: 0, // 已消化到第几轮
    pendingShutters: [], // 快门：等下次消化时合并，绝不直接插 system 头
    // —— 统计 ——
    crystalCount: 0,
    obsessionCount: 0,
    sunkCount: 0,
    // —— 标题去重用的历史清单（只留近 200 条，防止无限涨） ——
    recentTitles: [],
    // —— 上一次 digest 的模型用量（用于滚动校准 token 系数） ——
    usageCalibration: { samples: 0, charsPerToken: 1.45 },
  };
}

export class Store {
  /**
   * @param {string} root  <= <dshHome>/whale-memory/<instanceId>
   */
  constructor(root) {
    this.root = root;
    this.statePath = path.join(root, 'state.json');
    this.memoriesPath = path.join(root, 'memories.json');
    this.batchesDir = path.join(root, 'batches');
    this.journalPath = path.join(root, 'journal.jsonl');
    this.state = null;
    /** @type {Map<string, any>} */
    this.memories = new Map();
    this._writing = Promise.resolve();
  }

  async load() {
    await fs.mkdir(this.batchesDir, { recursive: true });
    this.state = await this._readJson(this.statePath, () =>
      emptyState(path.basename(this.root)),
    );
    const list = await this._readJson(this.memoriesPath, () => []);
    this.memories = new Map(list.map((m) => [m.id, m]));
    return this;
  }

  async _readJson(file, fallback) {
    try {
      const raw = await fs.readFile(file, 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      if (err.code === 'ENOENT') return fallback();
      // 损坏不能静默重建——那等于她一夜之间失忆。留证据，然后炸。
      const broken = `${file}.corrupt-${Date.now()}`;
      await fs.rename(file, broken).catch(() => {});
      throw new Error(
        `whale-memory: ${path.basename(file)} 解析失败，已移到 ${path.basename(broken)}；` +
          `为避免静默失忆，插件停止工作。原始错误：${err.message}`,
      );
    }
  }

  /** 原子写：tmp → rename */
  async _writeJson(file, data) {
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await fs.rename(tmp, file);
  }

  /** 串行化所有落盘，避免并发把同一个文件写坏 */
  _enqueue(fn) {
    const next = this._writing.then(fn, fn);
    this._writing = next.catch(() => {});
    return next;
  }

  async save() {
    return this._enqueue(async () => {
      await this._writeJson(this.statePath, this.state);
      await this._writeJson(this.memoriesPath, [...this.memories.values()]);
    });
  }

  async journal(event) {
    const line = JSON.stringify({ t: Date.now(), ...event }) + '\n';
    return this._enqueue(() => fs.appendFile(this.journalPath, line, 'utf8'));
  }

  // —— 记忆 ——

  all() {
    return [...this.memories.values()];
  }

  get(id) {
    return this.memories.get(id);
  }

  put(rec) {
    this.memories.set(rec.id, rec);
  }

  remove(id) {
    this.memories.delete(id);
  }

  byTier(tier) {
    return this.all().filter((m) => m.tier === tier);
  }

  // —— 原始批次（回光要用） ——

  async putBatch(batchId, rounds) {
    await fs.mkdir(this.batchesDir, { recursive: true });
    await this._writeJson(path.join(this.batchesDir, `${batchId}.json`), {
      id: batchId,
      createdAt: Date.now(),
      rounds,
    });
  }

  async getBatch(batchId) {
    try {
      return await this._readJson(
        path.join(this.batchesDir, `${batchId}.json`),
        () => null,
      );
    } catch {
      return null;
    }
  }

  /** 鲸落之后可以删原始批次——但在那之前一个字都不能删 */
  async dropBatch(batchId) {
    await fs
      .unlink(path.join(this.batchesDir, `${batchId}.json`))
      .catch(() => {});
  }

  // —— 里程 ——

  /** 沉积 token：唯一的水位计时器 */
  deposit(tokens) {
    this.state.mileage += tokens;
  }

  /** 记一次标题，用于去重 */
  rememberTitle(title) {
    const t = this.state.recentTitles;
    t.push(title);
    if (t.length > 200) t.splice(0, t.length - 200);
  }

  titleTaken(title) {
    return this.state.recentTitles.includes(title);
  }
}

/** 默认根目录：<dshHome>/whale-memory/<instanceId> */
export function defaultRoot({ dshHome, instanceId }) {
  const home = dshHome || path.join(os.homedir(), '.dsh');
  return path.join(home, 'whale-memory', instanceId);
}
