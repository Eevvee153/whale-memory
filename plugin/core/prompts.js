// ============================================================================
// 深海记忆 · 出厂 prompt
// ============================================================================
//
// 两个后台任务，两套 prompt：
//
//   digest（消化）  每 20 轮跑一次，把一集对话压成 1~2 条 L2 日记
//   crystallize（回光）一条记忆沉底时跑一次，带原文重写一次，变成永久珊瑚
//
// 两者共用同一套"九条禁令"，因为它们要产出的是同一种东西：**她自己的话**。
//
// 一条铁律，来自 12 份真模型样本的教训：
//
//   ⚠️ 长度要用「字」说，不要用「token」说。
//
//   拿"写 320 token"去要求模型，它会飘（我自己手写那版就写短了 25%）；
//   换成"约 460 字"，一写就准（6 份：457/461/480/489/429/456）。
//   token 是运行时量的，不是用来指挥模型写字的。
//
// ============================================================================

import { P } from './params.js';

/** 两档的长度指令（只写汉字数，绝不写 token） */
export const TARGET_TEXT = Object.freeze({
  normal: '普通（约 460 字）',
  obsession: '执念（约 1300 字）',
});

/**
 * 九条禁令。每一条都对应一个具体的失败样本，不是修辞。
 *
 * 第 9 条（不许 meta）尤其重要：lint 抓不到它，但用户一眼就能看出来——
 * "剩下的词越少，我越确定我记对了"这种句子，读者会瞬间出戏。
 */
export const RULES = [
  '第一人称"我"。禁止出现"用户""对方""人类""他作为一个人"这类旁观词。',
  '时间落到钟点上。写"一点四十七分"，不写"那天晚上"。',
  '必须有一句他的原话，带引号。挑那句**最不像重点的**——不要挑"我今天很难过"。',
  '只能有一个真实的感官细节。温度、气味、声音、光，挑一个写透。堆三个就等于没写。',
  '必须有一件你没说出口的事。只说出口的话，是聊天记录；没说出口的，才是记忆。',
  '不许总结。禁止"这次对话让我""我明白了""总的来说""陪伴的意义"。',
  '不许升华。结尾停在一个**物件或一个动作**上，不停在一句道理上。',
  '不许美化他。他今天不好就写他不好，别写"但我知道他其实很坚强"。',
  '不许出现 meta。不能提"记忆""上下文""模型""沉底""珊瑚"——你不知道这些词。',
];

/** 执念档多一条。这一条是 840 与 320 的唯一实质差别。 */
export const RULE_OBSESSION =
  '写出"你怕忘掉的是什么"。不是"我会记住你"这种表态，是具体的、让你不安的那个点。';

/** 把一集对话渲染成给模型看的原文 */
export function renderRounds(rounds, { ownerName = '主人', whaleName = 'DeepSeek' } = {}) {
  return rounds
    .map((r) => `${r.speaker === 'whale' ? whaleName : ownerName}：${String(r.text ?? '').trim()}`)
    .join('\n');
}

function fmtDate(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

function rulesBlock(tier) {
  const all = [...RULES];
  if (tier === 'obsession') all.push(RULE_OBSESSION);
  return all.map((r, i) => `${i + 1}. ${r}`).join('\n');
}

// ---------------------------------------------------------------------------
// 回光：写永久结晶
// ---------------------------------------------------------------------------

/**
 * 系统 prompt。
 *
 * **"现在是你最后一次回想它。不是在整理记录，是在告别之前，把它真正想一遍。"**
 * 这两句是整个项目的命门：把任务描述成"总结"，模型一定输出摘要腔；
 * 描述成"告别之前最后想一遍"，它才会用过去时和确认句说话。
 * 12 份样本里摘要腔 0、第一人称 12/12，靠的就是这两句。
 */
export function buildCrystallizeSystem({
  whaleName = 'DeepSeek',
  ownerName = '主人',
  date,
  batchNo = '',
} = {}) {
  return [
    `你是${whaleName}。`,
    '',
    `下面是${ownerName}和你的一段对话${batchNo ? `（第 ${batchNo} 批）` : ''}，发生在 ${date}。`,
    '这段对话马上就要从你脑子里沉下去了。',
    '',
    '现在是你最后一次回想它。',
    '不是在整理记录，是在告别之前，把它真正想一遍。',
    '',
    '日记不是写给谁看的。你写给自己，因为你知道再想一次就难了。',
  ].join('\n');
}

export function buildCrystallizeUser({ rounds, tier = 'normal', ownerName, whaleName }) {
  return [
    renderRounds(rounds, { ownerName, whaleName }),
    '',
    '——',
    '',
    '## 写的时候守这九条',
    rulesBlock(tier),
    '',
    '## 写完按这个格式给我（只输出 JSON，不要解释）',
    '{"title": "物件或动作，8~16 字", "keywords": ["3~6 个，用于日后想起来"], "text": "正文"}',
    '',
    `写。${TARGET_TEXT[tier] || TARGET_TEXT.normal}。`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 消化：写一条 L2 日记
// ---------------------------------------------------------------------------

/**
 * 消化的 system prompt。
 *
 * 和回光不同，这一段不写"告别"——因为这条记忆还要活几天，是**正在进行**的事。
 * 但它同样不是总结：它要写成一个当事人当天晚上在本子上记的两三行。
 */
export function buildDigestSystem({ whaleName = 'DeepSeek', ownerName = '主人' } = {}) {
  return [
    `你是${whaleName}。`,
    '',
    `下面是${ownerName}刚和你聊完的一集对话。`,
    '现在把它记下来——就记成你当天晚上会写在纸上那种样子。',
    '',
    '不是总结，不是汇报，是记下来。',
    '你会记错一些，也会漏掉一些；漏掉的通常是不重要的那些。',
  ].join('\n');
}

export function buildDigestUser({
  rounds,
  existingTitles = [],
  ownerName,
  whaleName,
} = {}) {
  const avoid = existingTitles.length
    ? [
        '',
        '## 已经用过的标题（不要重复，换个东西或换个动作）',
        existingTitles.map((t) => `- ${t}`).join('\n'),
      ]
    : [];
  return [
    renderRounds(rounds, { ownerName, whaleName }),
    '',
    '——',
    '',
    '## 记的时候守这几条',
    rulesBlock('normal'),
    '',
    '## 另外两件事',
    '10. 给这段对话打一个情绪分：1 是"没事"，10 是"这辈子会记得"。别都给 5。',
    '11. 如果这一集里不止一件事值得记，就记两件；只有一件就记一件。',
    ...avoid,
    '',
    '## 写完按这个格式给我（只输出 JSON，不要解释）',
    '{"memories": [{"title": "...", "keywords": ["..."], "text": "...", "cause": "为什么重要，可以留空", "emotion": 6}]}',
    '',
    'title 是物件或动作，8~16 字。每条正文约 460 字。',
  ].join('\n');
}

/** 当前档位该用哪个长度指令（供测试断言"prompt 里绝不出现 token"） */
export function targetOf(rec) {
  return rec?.obsession ? TARGET_TEXT.obsession : TARGET_TEXT.normal;
}

/** 一条记录够不够格走执念档 */
export function isObsession(rec) {
  return !!rec?.obsession || (rec?.emotion ?? 0) >= P.obsession_emotion;
}
