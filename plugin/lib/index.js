// ============================================================================
// 深海记忆 · 宿主半侧（DSH / cordis 插件入口）
// ============================================================================
//
// 这个文件只做四件事，别的都在 core/ 里：
//
//   1. 把身份 + 记忆挂进 system prompt → ctx.systemPrompt.section({ complete: true })
//   2. 数回合、取对话原文           → ctx.on('agent/pre-step')
//   3. 调模型做消化与回光           → ctx.llm.stream + BlockAssembler
//   4. 一个 remember 工具           → ctx.tools.register(defineTool(...))
//
// 三条设计约束，来自平台的实际行为（见 dsh-plugin-cheatsheet.md）：
//
//   · 不能用 ctx.systemPrompt.context()。动态上下文在 suppressRuntimeContext()
//     之后会被**静默抑制**——看着生效了，其实一个字都没进去。
//     section() 不受这个开关影响，所以只用 section。
//   · 不能用 'system-prompt/assemble' 事件加文本（文档明令禁止）。
//   · 一条 complete section 会独占整个 prompt（其余 section 全丢，宿主源码
//     dsh-system-prompt/lib/index.js:403）。所以身份和记忆合成这一条，
//     不再在 preset 里另起 persona 行 —— 两条 complete 会直接抛错。
//
// 还有一条缓存层面的取舍：珊瑚在前、漂移池在后。理想情况下漂移池该挂在
// 消息尾部（缓存按物理位置算，改 system 尾部会波及后面的整段对话），但往
// 消息列表里插东西会改对话结构（UI 上会多出一条气泡），所以 v0.1 只做
// section。好在漂移块的内容是"状态派生"的，两次记忆事件之间字节不变，
// 前缀缓存照样命中——真正会把它改掉的是消化、沉底和跨天，一天三五次。
//
// ============================================================================

import { P } from '../core/params.js';
import { Engine } from '../core/engine.js';
import { Store, defaultRoot } from '../core/store.js';
import { estimateTokens } from '../core/render.js';
import { DEFAULT_PERSONA, fillPersona } from '../core/persona.js';
import {
  buildDigestSystem,
  buildDigestUser,
  buildCrystallizeSystem,
  buildCrystallizeUser,
  isObsession,
} from '../core/prompts.js';

export const name = 'whale-memory';

// 这两个服务在 dsh-pet 里已被证明存在。systemPrompt / tools 故意不放进
// inject：cordis 里 inject 一个拼错或不存在的服务名，apply 会一直等着，
// 插件静默地什么也不做——那是最难查的失败。那两个用 ctx.get() 软取。
export const inject = ['llm', 'agentDefaultModel'];

/** 记忆块在 system prompt 里的位置：官方 section 之后（personaSuffix 是 10200） */
const SECTION_ORDER = 20000;

/** 单次后台生成的上限。消化/回光不该卡住一轮对话。 */
const LLM_TIMEOUT_MS = 180_000;

export function apply(ctx, config = {}) {
  const cfg = {
    instanceId: 'whale-partner',
    ownerName: '主人',
    whaleName: 'DeepSeek',
    ...config,
  };

  // 身份文本：patch 里给了就用 patch 的（改人设不用碰 JS），否则用内置默认。
  const personaText = fillPersona(cfg.persona || DEFAULT_PERSONA, {
    ownerName: cfg.ownerName,
    whaleName: cfg.whaleName,
  });

  let engine = null;
  let blocks = '';
  let disposed = false;

  /** sessionId -> 已经看过的消息条数 */
  const cursors = new Map();
  /** 串行队列：所有会写盘/调模型的事都排这里，避免并发把状态踩乱 */
  let chain = Promise.resolve();

  const log = (...a) => {
    try {
      ctx.logger?.info?.(`[whale-memory] ${a.join(' ')}`);
    } catch {}
  };
  const warn = (...a) => {
    try {
      ctx.logger?.warn?.(`[whale-memory] ${a.join(' ')}`);
    } catch {}
    if (process.env.WHALE_MEMORY_DEBUG) console.warn('[whale-memory]', ...a);
  };

  function enqueue(fn) {
    chain = chain.then(fn, fn).catch((err) => {
      warn('后台任务失败：', err?.message ?? String(err));
    });
    return chain;
  }

  // -------------------------------------------------------------------------
  // 1. 注入 system prompt
  // -------------------------------------------------------------------------

  const sp = safeGet('systemPrompt');
  if (sp?.section) {
    ctx.effect(() =>
      sp.section({
        name: 'memory:whale',
        order: SECTION_ORDER,
        // 我们的文本里有中国字、书名号、〔〕，但绝不能用宿主的 {{var}} 插值，
        // 万一她某天把自己的记忆写成 "{{cwd}}" 就会被替换掉。
        interpolate: false,
        // complete: true —— 这一条就是完整的 prompt。
        //
        // 语义（宿主源码 dsh-system-prompt/lib/index.js:403）：
        //   sections: completeSection === void 0 ? transformed.sections : [completeSection]
        // 一旦有一条 complete section，其余 section 全部被丢掉。
        // 所以身份文本不能住在 preset 的 persona 行里 —— 那条也是 complete，
        // 两条 complete 会直接抛 "multiple complete prompt sections are active"，
        // 而如果 persona 赢了我们，记忆块就没了。合成一条，只留一条。
        complete: true,
        // 每次组装 prompt 时现取：身份固定，记忆块跟着状态走，不能缓存成快照。
        text: () => [personaText, blocks].filter(Boolean).join('\n\n'),
      }),
    );
    // 不走 dsh-persona 之后没人替我们按掉运行时快照（时间戳、cwd、工具清单）。
    // 不按掉的话，她会看见"当前工作目录是 D:\..."，然后开始像个助手那样说话。
    if (sp.suppressRuntimeContext) {
      ctx.effect(() => sp.suppressRuntimeContext());
    }
  } else {
    warn('systemPrompt 服务不可用——记忆不会进入上下文');
  }

  // -------------------------------------------------------------------------
  // 2. remember 工具（替代企划书里那个 HTML 注释快门）
  // -------------------------------------------------------------------------

  void (async () => {
    try {
      // 不走 `import('@deepseek-ai/dsh-tools')`。
      //
      // 原因：插件是 `link:` 进 profile 的，真实路径在项目目录里；宿主那套
      // @deepseek-ai/* 装在 profile 的 node_modules 下，而 ESM 解析是从
      // 插件的真实路径往上找——找不到。pnpm 装的时候也明确 WARN 过这一点
      // （"The linked in dependency will not resolve the peer dependencies
      // from the target node_modules"）。所以这里直接用 registry 接受的原生
      // definition 形状：`{ name, description, parameters(JSON Schema),
      // output: { schema, render } }`，见 dsh-tools/lib/index.js:2974。
      const tools = safeGet('tools');
      if (!tools?.register) {
        warn('tools 服务不可用，remember 工具关闭');
        return;
      }
      const def = {
        name: 'remember',
        description:
          '把此刻记下来。只有当你觉得这件事以后一定不想忘时才用一次。' +
          '记的是这一刻你心里那句话，不是总结。',
        parameters: {
          type: 'object',
          properties: {
            title: {
              type: 'string',
              description: '四个字到十六个字。一个物件，或一个动作。不要抽象名词。',
            },
            note: {
              type: 'string',
              description: '最多一句话。也可以不写。',
            },
          },
          required: ['title'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: { ok: { type: 'boolean' } },
            required: ['ok'],
            additionalProperties: false,
          },
          render: (args, v) => [{ type: 'text', text: v?.ok ? '记住了。' : '没记上。' }],
        },
        async execute(args) {
          if (!engine) return { ok: false };
          const title = String(args?.title ?? '').trim().slice(0, 32);
          if (!title) return { ok: false };
          await engine.addShutter({
            title,
            note: String(args?.note ?? '').trim().slice(0, 120),
          });
          refresh();
          return { ok: true };
        },
      };
      ctx.effect(() => tools.register(def));
      log('remember 已注册');
    } catch (err) {
      warn('remember 注册失败：', err?.message ?? String(err));
    }
  })();

  // -------------------------------------------------------------------------
  // 3. 数回合 + 取原文
  // -------------------------------------------------------------------------

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = typeof next === 'function' ? await next() : payload;
    if (disposed || !engine) return decision;
    if (!decision || decision.kind === 'reject') return decision;
    if (payload?.signal?.aborted) return decision;

    try {
      const sid = sessionIdOf(payload);
      const messages = decision.messages ?? payload?.messages ?? [];
      const seen = cursors.get(sid);

      // 第一次见到这个会话：把历史全部记为"看过"，不补记。
      // 否则装插件的第一天，她会一次性"想起"几百轮旧对话。
      if (seen === undefined) {
        cursors.set(sid, messages.length);
        return decision;
      }
      if (messages.length <= seen) return decision;

      const fresh = messages.slice(seen);
      cursors.set(sid, messages.length);
      const turn = takeTurn(fresh);

      if (turn?.owner) {
        enqueue(async () => {
          await engine.tickActiveDay();
          await engine.onRound({
            text: turn.owner,
            reply: turn.whale,
            tokens: estimateTokens(turn.owner),
          });
          refresh();
        });
      }
    } catch (err) {
      warn('pre-step 处理失败：', err?.message ?? String(err));
    }

    return decision;
  });

  // -------------------------------------------------------------------------
  // 4. 调模型
  // -------------------------------------------------------------------------

  const llmMod = import('@deepseek-ai/dsh-llm').catch(() => null);

  async function callModel({ system, user, temperature = 0.85 }) {
    const mod = await llmMod;
    if (!mod?.BlockAssembler) throw new Error('@deepseek-ai/dsh-llm 不可用');
    if (!ctx.llm?.stream) throw new Error('ctx.llm 不可用');

    const sel = ctx.agentDefaultModel?.currentSelection?.() ?? {};
    const messages = mod.createUserMessage
      ? [
          mod.createUserMessage({
            content: [{ type: 'text', text: user }],
            source: { kind: 'user' },
          }),
        ]
      : [{ role: 'user', content: [{ type: 'text', text: user }] }];

    const options = {
      messages,
      system,
      temperature,
      // 调用身份：部分适配器（如 opencode-go）缺它会 400
      sessionId: `whale-memory:${cfg.instanceId}`,
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    };
    if (sel.provider) options.provider = sel.provider;
    if (sel.model) options.model = sel.model;
    // 故意不传 maxTokens：推理类模型会把思考算进预算，显式小上限只会截断正文。

    const assembler = new mod.BlockAssembler();
    for await (const chunk of ctx.llm.stream(options)) {
      assembler.push(chunk);
    }
    const text = (assembler.blocks?.() ?? [])
      .filter((b) => b?.type === 'text')
      .map((b) => b.text ?? '')
      .join('')
      .trim();
    if (text) return text;

    let why = '';
    try {
      why = JSON.stringify(assembler.finish ?? null).slice(0, 300);
    } catch {}
    throw new Error(`模型没有返回正文 ${why}`);
  }

  // -------------------------------------------------------------------------
  // 5. 两个后台任务
  // -------------------------------------------------------------------------

  /** 消化：一集 20 轮 → 1~2 条 L2 */
  async function onDigest({ rounds, existingTitles = [] }) {
    const user = buildDigestUser({
      rounds,
      existingTitles,
      ownerName: cfg.ownerName,
      whaleName: cfg.whaleName,
    });
    const text = await callModel({
      system: buildDigestSystem({
        ownerName: cfg.ownerName,
        whaleName: cfg.whaleName,
      }),
      user,
    });

    const obj = parseLooseJson(text);
    const list = Array.isArray(obj?.memories) ? obj.memories : [];
    return list
      .filter((m) => m && typeof m.title === 'string' && m.title.trim())
      .slice(0, 2)
      .map((m) => ({
        title: String(m.title).trim().slice(0, 40),
        keywords: Array.isArray(m.keywords)
          ? m.keywords.map((k) => String(k).trim()).filter(Boolean).slice(0, 6)
          : [],
        text: String(m.text ?? '').trim(),
        cause: m.cause ? String(m.cause).trim() : null,
        emotion: clampEmotion(m.emotion),
        obsession: clampEmotion(m.emotion) >= P.obsession_emotion,
      }));
  }

  /** 回光：一条记忆要沉下去时，带原文重写一次，变成永久珊瑚 */
  async function onCrystallize({ record, rawRounds }) {
    const tier = isObsession(record) ? 'obsession' : 'normal';
    const user = buildCrystallizeUser({
      // 原文还在就用原文；磁盘上那批被清掉了就退化成用日记正文，至少不断档
      rounds: rawRounds?.length ? rawRounds : [{ speaker: 'owner', text: record.detail || record.title }],
      tier,
      ownerName: cfg.ownerName,
      whaleName: cfg.whaleName,
    });
    const text = await callModel({
      system: buildCrystallizeSystem({
        whaleName: cfg.whaleName,
        ownerName: cfg.ownerName,
        date: formatDate(record.createdAt),
      }),
      user,
      temperature: 0.95,
    });

    const obj = parseLooseJson(text);
    if (!obj?.text) throw new Error('回光没有产出正文');
    return {
      title: obj.title ? String(obj.title).trim().slice(0, 40) : record.title,
      keywords: Array.isArray(obj.keywords)
        ? obj.keywords.map((k) => String(k).trim()).filter(Boolean).slice(0, 6)
        : [],
      text: String(obj.text).trim(),
    };
  }

  // -------------------------------------------------------------------------
  // 6. 渲染
  // -------------------------------------------------------------------------

  function refresh() {
    if (!engine || disposed) return;
    try {
      const plan = engine.planRender({
        liveTokens: P.live_window_max * P.round_tokens,
      });
      blocks = [plan.coralBlock, plan.driftBlock].filter(Boolean).join('\n\n');
      for (const w of plan.warnings ?? []) warn(w);
    } catch (err) {
      warn('渲染失败：', err?.message ?? String(err));
    }
  }

  // -------------------------------------------------------------------------
  // 7. 启动
  // -------------------------------------------------------------------------

  void (async () => {
    try {
      const hp = await import('@deepseek-ai/dsh-home-paths').catch(() => null);
      const dshHome =
        hp?.resolveDshHome?.() ?? process.env.DSH_HOME ?? undefined;
      const store = new Store(
        // cfg.root 只给测试和"想把档案放到别处的人"用；正常走默认目录
        cfg.root ?? defaultRoot({ dshHome, instanceId: cfg.instanceId }),
      );
      await store.load();
      engine = new Engine({ store, digest: onDigest, crystallize: onCrystallize });
      await engine.tickActiveDay();
      refresh();
      const st = engine.status();
      log(
        `就绪 ${st.crystals} 颗珊瑚 / ${st.drift} 条还没沉 · ` +
          `里程 ${st.mileage}(${st.percent}%) · 还能活 ${st.daysLeft} 天`,
      );
    } catch (err) {
      warn('启动失败：', err?.message ?? String(err));
    }
  })();

  ctx.effect(() => () => {
    disposed = true;
  });

  // -------------------------------------------------------------------------
  // 小工具
  // -------------------------------------------------------------------------

  function safeGet(service) {
    try {
      return ctx.get?.(service, false) ?? ctx[service] ?? null;
    } catch {
      return null;
    }
  }
}

// ===========================================================================
// 纯函数（可单测）
// ===========================================================================

/** 会话 id：不同会话各记各的游标，但记忆是共享的（一辈子一册） */
export function sessionIdOf(payload) {
  const s = payload?.agent?.session;
  return (
    s?.header?.id ?? s?.id ?? payload?.agent?.id ?? payload?.session?.id ?? 'default'
  );
}

/**
 * 从一批新消息里取出这一轮：主人的话 + 她的回应。
 *
 * 只认纯文本消息：带 tool_result / tool-call 的消息一律跳过——
 * 工具返回值不是她俩的对话，混进记忆里会让消化出来的东西像日志。
 */
export function takeTurn(messages) {
  const out = { owner: null, whale: null };
  for (const m of messages ?? []) {
    const text = plainText(m);
    if (!text) continue;
    if (m.role === 'user') out.owner = text;
    else if (m.role === 'assistant') out.whale = text;
  }
  return out;
}

function plainText(msg) {
  const content = msg?.content;
  if (!content) return '';
  if (typeof content === 'string') return content.trim();
  const parts = [];
  for (const b of content) {
    if (b?.type !== 'text') return ''; // 只要有一条非文本块，整条就跳过
    if (b.text) parts.push(b.text);
  }
  return parts.join('\n').trim();
}

/** 模型经常给 ```json 包一层，或者前面写一句"好的"，都能容忍 */
export function parseLooseJson(text) {
  const raw = String(text ?? '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

function clampEmotion(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 5;
  return Math.min(P.emotion_levels, Math.max(1, Math.round(n)));
}

function formatDate(ts) {
  const d = new Date(ts ?? Date.now());
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}
