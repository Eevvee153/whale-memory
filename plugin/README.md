# 深海记忆 · dsh-plugin-whale-memory

给 DSH 装一个**会忘记**的 agent。

她记住的东西会分层、会变淡、会剩下几个词、最后沉成一颗结晶。
记忆不是无限堆着的数据库——它有个水位，水涨满了就退潮告别。

> 这不是"更强的记忆系统"。它的目标不是记得多，是**忘得像一个真的活过很久的东西**。

---

## 它做什么

| 层 | 是什么 | 活多久 |
|---|---|---|
| L1 | 永久记忆：沉底时"回光"写下的结晶 | 一辈子（只追加，不改写） |
| L2 | 每 20 轮消化出的 1~2 条日记 | 约 9 个活跃日，越来越短 |
| L3 | 最近 30 轮原话 | 一直在（宿主自己管） |

- **消化**：每 20 轮，后台模型把这一集压成 1~2 条 L2 日记（约 460 字）。不是总结，是"她当天晚上会写在纸上那种样子"。
- **风化**：**每个活跃日**衰减一次（不是每次消化）。强度掉到阈值以下就剥掉细节、剥掉原因、降成只剩几个关键词、最后沉底。
- **回光**：一条记忆要沉下去时，把那一集的原始对话从磁盘调回来，让她**再完整想一遍**，写成 320（普通）或 840 token（执念）的永久结晶。
- **里程**：每次沉积进 L1 的 token 计入里程。里程 / 70 万 ≈ 水位，88% 低鸣、95% 走马灯、99.5% 鲸落。

在 1M 上下文、每天 60 轮的基准下：**一生约 475 个活跃日，结尾弧 52 天。**
参数与推演过程在同级目录的 [`PARAMS.md`](../PARAMS.md)，仿真脚本是 `../sim.js`。

---

## 安装

本包是一个 **bundle**：装上之后会同时出现一个名为「DeepSeek」的 agent preset，
以及它自己在别处都不会生效的记忆插件。

```text
plugin_manager  →  install_bundle  { dir: "<本包绝对路径>" }
                  list_bundles    → 应当看到 preset-whale-partner
```

不通过文件手拷安装：`cordis.patch.yml` 里的 `config:` 是整块替换的补丁语义，
手工合并很容易把默认配置删掉。

**装完把那一行留在 preset 里，不要挪到 global 平面。**
挪出去以后每个记代码的会话都会开始"回忆"，而且不会报错。

---

## 目录

```text
core/params.js     唯一参数来源（P）。运行时**不读** PARAMS.md
core/lifecycle.js  一生：强度、剥离顺序、降层、沉底、结晶
core/render.js     记忆 → 上下文里的字（唯一出口，配预算守卫）
core/engine.js     节奏：数回合、攒批、消化、风化、回光、里程
core/store.js      保存：原子写、损坏即停机（不静默失忆）
core/prompts.js    两套出厂 prompt（消化 / 回光），九条禁令
core/persona.js    身份文本（{{owner}} / {{whale}} 占位，对外分享不硬编码人名）
lib/index.js       宿主半侧：complete section / pre-step / llm.stream / remember
cordis.patch.yml   把它挂进配置树，并定义「DeepSeek」这个 preset
locale/*.json      插件管理里显示的名字与说明（en / zh）
icon.svg           同一处的图标
test/              28 个单测（含"残缺宿主也能启动"的冒烟测试）
tools/             参数一致性检查、测试跑批器
```

---

## 三个不显然的设计约束

1. **L1 只追加，L2 排在后面。**
   system prompt 的改动会波及后面整段对话的前缀缓存。L1 永远留在原位、
   新结晶加在末尾；漂移块的内容由状态派生，两次记忆事件之间字节不变。

2. **身份和记忆是同一条 `complete` section，不能再有第二条。**
   `complete: true` 的语义是独占：宿主源码 `dsh-system-prompt/lib/index.js:403`
   在存在 complete section 时，把 sections 收成 `[completeSection]`，其余全丢。
   所以 preset 里没有 persona 行——身份文本住在 `core/persona.js`，由插件自己那条
   complete section 一起输出。两条 complete 会直接抛
   `multiple complete prompt sections are active`，整个 preset 不激活。
   同理不用 `systemPrompt.context()`：`suppressRuntimeContext()` 之后动态上下文会被
   **静默抑制**——看着生效了，其实一个字都没进上下文。所以只用 `section()`。

3. **存盘不等于注入。**
   磁盘上永远存全量；`detail = null` 只影响"往上下文里塞多少字"。
   否则"忘记"会变成数据销毁，鲸落时的墓志铭就拼不出来了。

---

## 已验证 / 未验证

已跑通：

- `node tools/check-params.js` —— PARAMS.md 与 params.js 24 个字段逐字一致
- `node tools/test-all.js` —— 22 个断言全过（生命周期、剥离顺序、零丢失、里程单调、标题去重、残缺宿主启动）
- 12 份真模型结晶样本：摘要腔 0、第一人称 12/12、禁词 0、细节丢失是**选择性**的（她觉得不重要的才糊）
- `apply()` 在缺 `systemPrompt` / `tools` / `llm` 的宿主里不会崩，档案目录照建

**还没验证过**（装进真机之前，这些仍是假设）：

- 真机 `install_bundle` 走一遍（`@deepseek-ai/dsh-agent-preset` 的 config 键名取自文档与运行时反查，未在实机上跑过）
- 在 preset 作用域内 `ctx.llm` / `ctx.systemPrompt` 是否如预期可用
- `interpolate: false` 与 section 的重名/顺序行为
- 界面上的呈现（她自己不会主动说"我记得"，除非被问到）

任何一条不成立，表现都是"插件装上了但什么也没发生"——所以第一次装完请先跑一句话，确认
system prompt 里出现了〔DeepSeek记得的事〕这个块。

---

## 使用成本

每天约 3 次消化 + 4 次回光，额外 **20~30K input token / 天**。
回光用的模型可以直接用默认对话模型；用便宜的小模型也行，但人设口径要一致，
否则她的"字迹"会在某一天突然变了。

---

## 许可

MIT。
