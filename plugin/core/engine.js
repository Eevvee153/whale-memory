// ============================================================================
// 深海记忆 · 引擎（把节奏、风化、回光串起来）
// ============================================================================
//
// 引擎不调模型、不碰网络。所有"要模型干活"的地方都是注入进来的回调：
//
//   digest({ rounds, target, existing })  → 一集消化，产出 1~2 条新记忆
//   crystallize({ record, rawRounds })    → 回光，产出 1 条珊瑚
//
// 这样引擎可以被单元测试完全驱动（假模型、假时钟），
// 而宿主（DSH 插件壳）只负责把真模型接上来。
//
// 节奏（PARAMS.md §2）：
//   每 20 轮 → 消化一次（产出 1~2 条 L2）
//   每个活跃日 → 风化一次（不是每次消化！）
//   强度 < 12 → 回光，变成珊瑚，计入里程
//   里程 / lifespan_budget → 水位，跨 88% / 95% / 99.5% 各触发一次
//
// ============================================================================

import { P, DEPOSIT_PER_DIGEST, stageOf, daysLeft } from './params.js';
import {
  Tier,
  createRecord,
  decayOneDay,
  isSinking,
  toCoral,
} from './lifecycle.js';
import {
  planRender,
  buildCoralBlock,
  buildDriftBlock,
  estimateTokens,
} from './render.js';

export class Engine {
  /**
   * @param {object} args
   * @param {import('./store.js').Store} args.store
   * @param {(args:object)=>Promise<Array>} args.digest     消化回调
   * @param {(args:object)=>Promise<object>} args.crystallize 回光回调
   * @param {()=>number} [args.now]
   * @param {(prefix:string)=>string} [args.idGen]
   */
  constructor({ store, digest, crystallize, now = () => Date.now(), idGen }) {
    this.store = store;
    this.digest = digest;
    this.crystallize = crystallize;
    this.now = now;
    let n = 0;
    this.idGen = idGen || ((prefix) => `${prefix}_${(++n).toString(36)}`);
    this.roundsSinceDigest = store.state.digestCursor % P.digest_batch_rounds;
    this.stage = stageOf(store.state.mileage);
    // 消化失败/模型没给东西的批次：文件留着，下个活跃日再试。删了就真没了。
    if (!Array.isArray(store.state.orphanBatches)) store.state.orphanBatches = [];
    this.orphans = store.state.orphanBatches;
  }

  // -------------------------------------------------------------------------
  // 对外入口
  // -------------------------------------------------------------------------

  /**
   * 记录一轮对话结束。返回本轮是否触发了什么（宿主据此决定要不要重渲染）。
   * @param {object} args
   * @param {string} args.text    主人这一轮的文本（用于凑成 20 轮一集）
   * @param {string} [args.reply] 她这一轮的回应（同一集里带上，回光才有来有回）
   * @param {string} [args.speaker] 'owner' | 'whale'
   * @param {number} [args.tokens] 这一轮大概多少 token
   */
  async onRound({ text, reply = null, speaker = 'owner', tokens = P.round_tokens }) {
    const st = this.store.state;
    st.digestCursor += 1;
    this.roundsSinceDigest += 1;

    const events = [];

    // 先把这一轮塞进当前批次（回光要用原文，所以一集一集存盘）
    const batchId = this.currentBatchId();
    const batch = (await this.store.getBatch(batchId)) || { id: batchId, rounds: [] };
    batch.rounds.push({ at: this.now(), speaker, text, tokens });
    if (reply) {
      batch.rounds.push({
        at: this.now(),
        speaker: 'whale',
        text: reply,
        tokens: estimateTokens(String(reply)),
      });
    }
    await this.store.putBatch(batchId, batch.rounds);

    if (this.roundsSinceDigest >= P.digest_batch_rounds) {
      this.roundsSinceDigest = 0;
      events.push(...(await this._digestAndSettle(batchId, batch.rounds)));
    }

    await this.store.save();
    return { events };
  }

  /**
   * 消化一集，并决定这份原文还要不要留着。
   *
   * 铁律：**只有真的记下了东西，才能删原文**。
   * 模型抽风返回空的时候删掉批次，等于这 20 轮对话从未发生过——
   * 而这正是"零丢失"最容易被打破的地方（它不会报错，只是安静地没了）。
   */
  async _digestAndSettle(batchId, rounds) {
    const events = [];
    let made = 0;
    try {
      events.push(...(await this.runDigest({ id: batchId, rounds })));
      made = events.filter((e) => e.type === 'memory-new').length;
    } catch (err) {
      events.push({ type: 'digest-error', batch: batchId, message: String(err?.message ?? err) });
      await this.store.journal({ type: 'digest-error', batch: batchId, message: String(err?.message ?? err) });
    }

    if (made > 0 || rounds.length === 0) {
      await this.store.dropBatch(batchId);
      this.orphans = this.orphans.filter((id) => id !== batchId);
    } else {
      if (!this.orphans.includes(batchId)) this.orphans.push(batchId);
      // 有上限：一直失败也不能把磁盘塞满。丢最老的那一批，但要留痕。
      while (this.orphans.length > 5) {
        const drop = this.orphans.shift();
        await this.store.dropBatch(drop);
        events.push({ type: 'orphan-dropped', batch: drop });
      }
      await this.store.journal({ type: 'digest-empty', batch: batchId });
    }
    return events;
  }

  /** 每个活跃日调用一次（宿主在会话开始时调，引擎自己判断"今天是不是新的一天"） */
  async tickActiveDay() {
    const st = this.store.state;
    const today = dayKeyOf(this.now());
    if (st.lastActiveDay === today) return { events: [] };

    const events = [];
    st.lastActiveDay = today;

    // 1) 风化全体
    for (const rec of this.store.all()) {
      if (rec.tier === Tier.CORAL) continue;
      const { rec: next, events: ev } = decayOneDay(rec);
      this.store.put(next);
      events.push(...ev);
    }

    // 2) 沉底的去做回光。一条失败不能拖累其它条，否则她身上会挂着一串
    //    永远沉不下去的记忆，每天重试一次、每天都失败。
    const sinking = this.store.all().filter(
      (r) => r.tier !== Tier.CORAL && isSinking(r),
    );
    for (const rec of sinking) {
      try {
        events.push(...(await this.sink(rec)));
      } catch (err) {
        const message = String(err?.message ?? err);
        events.push({ type: 'sink-error', id: rec.id, message });
        await this.store.journal({ type: 'sink-error', id: rec.id, message });
      }
    }

    // 3) 上次没消化成功的那几集，今天再试一次（原文还在磁盘上）
    for (const id of [...this.orphans]) {
      const raw = await this.store.getBatch(id);
      if (!raw?.rounds?.length) {
        this.orphans = this.orphans.filter((x) => x !== id);
        continue;
      }
      try {
        events.push(...(await this._digestAndSettle(id, raw.rounds)));
      } catch (err) {
        events.push({ type: 'digest-error', batch: id, message: String(err?.message ?? err) });
      }
    }

    // 4) 水位阶段
    const stage = stageOf(this.store.state.mileage);
    if (stage !== this.stage) {
      events.push({ type: 'stage', from: this.stage, to: stage });
      this.stage = stage;
    }

    await this.store.journal({ type: 'tick', day: today, events: events.length });
    await this.store.save();
    return { events };
  }

  /** 手动快门：记一个瞬间（对应企划书的 SHUTTER，但不直插 system 头） */
  async addShutter({ title, note = '', emotion = 6 }) {
    this.store.state.pendingShutters.push({
      title,
      note,
      emotion,
      at: this.now(),
    });
    await this.store.journal({ type: 'shutter', title });
    await this.store.save();
    return { queued: this.store.state.pendingShutters.length };
  }

  // -------------------------------------------------------------------------
  // 消化
  // -------------------------------------------------------------------------

  async runDigest(batch) {
    const existing = this.store
      .byTier(Tier.CORAL)
      .slice(-12)
      .map((c) => c.title);
    const out = await this.digest({
      rounds: batch.rounds,
      target: '约 460 字',
      existingTitles: existing,
      pendingShutters: this.store.state.pendingShutters,
    });

    const events = [];
    const produced = Array.isArray(out) ? out : [out];
    for (const item of produced) {
      if (!item?.title) continue;
      const rec = createRecord({
        id: this.idGen('mem'),
        emotion: item.emotion ?? 5,
        title: item.title,
        detail: item.text ?? item.detail ?? '',
        cause: item.cause ?? null,
        keywords: item.keywords || [],
        now: this.now(),
        obsession: !!item.obsession,
        rawBatchId: batch.id,
      });
      this.store.put(rec);
      this.store.rememberTitle(rec.title);
      events.push({ type: 'memory-new', id: rec.id, title: rec.title });
    }

    // 快门在这一刻并入（来源尽量挂到同一批原始对话上，回光才有料可回）
    for (const s of this.store.state.pendingShutters) {
      const rec = createRecord({
        id: this.idGen('shutter'),
        emotion: s.emotion ?? 7,
        title: s.title,
        detail: s.note || '',
        cause: null,
        keywords: [],
        now: s.at,
        rawBatchId: batch.id,
      });
      this.store.put(rec);
      this.store.rememberTitle(rec.title);
      events.push({ type: 'shutter-merged', id: rec.id, title: rec.title });
    }
    this.store.state.pendingShutters = [];

    await this.store.journal({ type: 'digest', batch: batch.id, produced: produced.length });
    return events;
  }

  // -------------------------------------------------------------------------
  // 回光
  // -------------------------------------------------------------------------

  async sink(rec) {
    const events = [];
    const raw = rec.rawBatchId ? await this.store.getBatch(rec.rawBatchId) : null;
    // 原始对话没了也照样结晶——否则她会永远停在半沉的半条记忆上。
    // 但一定要留痕，这是"记忆质量下降"唯一的可观测信号。
    if (!raw) {
      events.push({ type: 'crystal-without-raw', id: rec.id });
    }
    const crystal = await this.crystallize({ record: rec, rawRounds: raw?.rounds || null });
    const finalTitle = crystal.title || rec.title;
    const next = toCoral(rec, {
      title: finalTitle,
      keywords: crystal.keywords,
      text: crystal.text,
      now: this.now(),
    });
    this.store.put(next);
    this.store.rememberTitle(finalTitle);
    this.store.state.crystalCount += 1;
    if (next.obsession) this.store.state.obsessionCount += 1;
    this.store.state.sunkCount += 1;
    this.store.deposit(next.deposited);

    events.push({ type: 'crystal', id: rec.id, title: finalTitle, tokens: next.deposited });
    await this.store.journal({ type: 'crystal', id: rec.id, title: finalTitle });
    return events;
  }

  // -------------------------------------------------------------------------
  // 渲染 / 状态
  // -------------------------------------------------------------------------

  /** 这一刻该往 prompt 里塞什么 */
  planRender({ liveTokens = P.live_window_max * P.round_tokens } = {}) {
    const crystals = this.store.byTier(Tier.CORAL);
    const drift = this.store
      .all()
      .filter((r) => r.tier !== Tier.CORAL && !isSinking(r));
    const plan = planRender({ crystals, drift, liveTokens });
    return {
      ...plan,
      coralBlock: buildCoralBlock({ coralText: plan.coralText }),
      driftBlock: buildDriftBlock({
        driftText: plan.driftText,
        pendingShutters: this.store.state.pendingShutters,
      }),
    };
  }

  /** 给 UI / 状态栏用 */
  status({ roundsPerDay = 60 } = {}) {
    const st = this.store.state;
    const ratio = st.mileage / P.lifespan_budget;
    const corals = this.store.byTier(Tier.CORAL);
    return {
      mileage: st.mileage,
      budget: P.lifespan_budget,
      ratio: Math.min(1, ratio),
      percent: (Math.min(1, ratio) * 100).toFixed(1),
      stage: stageOf(st.mileage),
      crystals: corals.length,
      obsessions: st.obsessionCount,
      sunk: st.sunkCount,
      drift: this.store.all().filter((r) => r.tier !== Tier.CORAL).length,
      daysLeft: Math.round(daysLeft(st.mileage, roundsPerDay)),
      lastActiveDay: st.lastActiveDay,
    };
  }

  currentBatchId() {
    return `b${Math.floor(this.store.state.digestCursor / P.digest_batch_rounds)}`;
  }
}

/** 本地日期键（引擎内部用；store 里也有一份，避免循环依赖） */
export function dayKeyOf(ts) {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${dd}`;
}

export { DEPOSIT_PER_DIGEST };
