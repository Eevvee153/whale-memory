// verify.js —— 把 6 份真模型样本过一遍，看三件事：
//   1. 具体细节（橘子 / 一点四十七 / 明天再买 / 六个点）留没留住
//   2. 执念档会不会自动缩回普通档的写法（缩了就没有两档的必要）
//   3. 实际长度落在哪，用来校正"1 token ≈ 几汉字"
//
// 用法：node verify.js
// 读 samples/*.json，写 samples/verify-report.md

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'samples');
const TIERS = ['normal', 'obsession'];

// ---------- 读样本 ----------

function loadSample(file) {
  const raw = fs.readFileSync(path.join(DIR, file), 'utf8');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error(`${file}: 找不到 JSON 对象`);
  const obj = JSON.parse(raw.slice(start, end + 1));
  if (typeof obj.text !== 'string' || !obj.text.length) throw new Error(`${file}: 缺少 text`);
  return { file, ...obj };
}

// ---------- 量 ----------

const CJK = /[\u4e00-\u9fff]/g;

function countCJK(s) {
  const m = s.match(CJK);
  return m ? m.length : 0;
}

// 含标点的总字数（不数空白）
function countChars(s) {
  return s.replace(/\s/g, '').length;
}

// 1 token ≈ 1.45 汉字 —— 这个系数是估的，见报告最后一节
const CHARS_PER_TOKEN = 1.45;

// ---------- 检 ----------

const BANNED = ['用户', '人类', '这段对话', '这次对话', '我明白了', '总的来说', '意义', '上下文', '模型', '珊瑚', '沉底'];

// 明细：这几个是这段对话里"丢了就说明记忆失真"的硬细节
const DETAILS = {
  '橘子': /橘子/,
  '汽水': /汽水/,
  '1:47': /(一点四十七|1[:：]47|1点47)/,
  '明天再买': /明天再买/,
  '六个点': /(六个点|省略号|……|\.\.\.)/,
  '被看着': /被看着/,
};

// 对话里出现过的时刻，只有这一个。多出来的就是生成时编造的。
const ALLOWED_TIMES = new Set(['一点四十七', '一点四十七分', '1点47', '1点47分']);
const TIME_RE = /([0-9零一二三四五六七八九十两]+点[0-9零一二三四五六七八九十]+分?|[0-9]{1,2}[:：][0-9]{2})/g;

// 摘要腔 / 假深刻的指纹
const SUMMARY_TONE = /(用户|对方|人类|汇报|综上所述|总的来说|我明白了|这次对话|这段对话)/;
const GRANDIOSE = /(陪伴的意义|让我明白|我想我明白|真正重要的|成长|治愈)/;

// 执念档必须有的东西：她怕忘掉什么
const FEAR = /(怕|担心|不敢|不敢说|怕的是|怕忘)/;

function check(s) {
  const text = s.text;
  const chars = countChars(text);
  const cjk = countCJK(text);
  const details = {};
  for (const [k, re] of Object.entries(DETAILS)) details[k] = re.test(text);
  const times = (text.match(TIME_RE) || []).filter(t => !ALLOWED_TIMES.has(t.replace(/分$/, '分')) && !ALLOWED_TIMES.has(t));
  return {
    file: s.file,
    title: s.title,
    titleLen: countCJK(s.title || ''),
    kw: (s.keywords || []).length,
    chars,
    cjk,
    tokens: Math.round(chars / CHARS_PER_TOKEN),
    firstPerson: /我/.test(text),
    quoted: /[“"「]/.test(text),
    timeAnchor: /([0-9零一二三四五六七八九十]+点|一点四十七|凌晨|半夜)/.test(text),
    banned: BANNED.filter(w => text.includes(w)),
    summaryTone: SUMMARY_TONE.test(text),
    grandiose: GRANDIOSE.test(text),
    fear: FEAR.test(text),
    inventedTimes: [...new Set(times)],
    details,
    detailScore: Object.values(details).filter(Boolean).length,
  };
}

// ---------- 主 ----------

const rows = [];
for (const tier of TIERS) {
  const re = new RegExp(`^${tier}-(\\d+)\\.json$`);
  const files = fs.readdirSync(DIR)
    .filter(f => re.test(f))
    .sort((a, b) => Number(a.match(re)[1]) - Number(b.match(re)[1]));
  for (const f of files) rows.push({ tier, ...check(loadSample(f)) });
}

const byTier = {};
for (const r of rows) (byTier[r.tier] ||= []).push(r);

const avg = (a, k) => (a.length ? Math.round(a.reduce((s, x) => s + x[k], 0) / a.length) : 0);
const flags = r => [
  r.firstPerson ? '1P' : '--',
  r.quoted ? 'Q' : '-',
  r.timeAnchor ? 'T' : '-',
  r.banned.length ? 'BAN' : 'ok',
  r.summaryTone ? 'SUM' : 'ok',
  r.grandiose ? 'GRA' : 'ok',
  r.fear ? 'FEAR' : '--',
].join(' ');

console.log('\n=== 逐份 ===\n');
for (const r of rows) {
  console.log(`${r.file.padEnd(18)} ${r.chars}字 ${r.cjk}汉 ≈${r.tokens}tok  细节${r.detailScore}/6  [${flags(r)}]  ${r.title}`);
  const miss = Object.entries(r.details).filter(([, v]) => !v).map(([k]) => k);
  if (miss.length) console.log(`  丢了: ${miss.join(' / ')}`);
  if (r.banned.length) console.log(`  禁词: ${r.banned.join(' ')}`);
  if (r.inventedTimes.length) console.log(`  编造时刻: ${r.inventedTimes.join(' ')}`);
}

console.log('\n=== 按档平均 ===\n');
for (const tier of TIERS) {
  const a = byTier[tier] || [];
  if (!a.length) continue;
  console.log(`${tier.padEnd(10)} 平均 ${avg(a, 'chars')}字 ≈${avg(a, 'tokens')}tok  细节 ${avg(a, 'detailScore')}/6  ` +
    `执念标记 ${a.filter(x => x.fear).length}/${a.length}  摘要腔 ${a.filter(x => x.summaryTone).length}/${a.length}  ` +
    `升华 ${a.filter(x => x.grandiose).length}/${a.length}`);
}

// ---------- 关键判断 ----------

const n = byTier.normal || [];
const o = byTier.obsession || [];
const out = [];

out.push('# 真模型验证报告（回光 prompt）', '');
out.push(`生成时间：${new Date().toISOString()}　样本：普通 ${n.length} 份 / 执念 ${o.length} 份`, '');

out.push('## 1. 逐份明细', '');
out.push('| 样本 | 字数 | 汉字 | ≈token | 标题 | 细节 | 禁词 | 摘要腔 | 升华 | 执念标记 |');
out.push('|---|---|---|---|---|---|---|---|---|---|');
for (const r of rows) {
  out.push(`| ${r.file} | ${r.chars} | ${r.cjk} | ${r.tokens} | ${r.title} | ${r.detailScore}/6 | ${r.banned.length ? r.banned.join(' ') : '—'} | ${r.summaryTone ? '❌' : '✅'} | ${r.grandiose ? '❌' : '✅'} | ${r.fear ? '✅' : '—'} |`);
}
out.push('');

out.push('## 2. 最重要的一条：执念档有没有缩水', '');
if (n.length && o.length) {
  const nr = avg(n, 'chars');
  const or = avg(o, 'chars');
  const ratio = (or / nr).toFixed(2);
  out.push(`- 普通平均 **${nr} 字** ≈ ${avg(n, 'tokens')} token`);
  out.push(`- 执念平均 **${or} 字** ≈ ${avg(o, 'tokens')} token`);
  out.push(`- 执念 / 普通 = **${ratio} 倍**`);
  out.push('');
  if (ratio < 1.5) out.push('> ⚠️ **执念档缩水了。** 不到 1.5 倍，说明模型没有真正进入"慢下来"的状态，只是把普通档写长了一点。两档的设计需要重做。');
  else if (ratio < 2.2) out.push('> ⚠️ 差距存在但偏小。执念档要的不是"更长"，是"更慢"。看 fear 标记和结尾是否换成恐惧。');
  else out.push('> ✅ 差距成立。执念档确实是另一种写法，不是加形容词。');
}
out.push('');

out.push('## 3. 细节能不能稳定留住', '');
out.push('| 细节 | 普通档保住 | 执念档保住 |');
out.push('|---|---|---|');
for (const k of Object.keys(DETAILS)) {
  const inN = n.filter(r => r.details[k]).length;
  const inO = o.filter(r => r.details[k]).length;
  out.push(`| ${k} | ${inN}/${n.length} | ${inO}/${o.length} |`);
}
out.push('');
out.push('**这张表只回答"保住了多少"，不回答"为什么丢"。** 是随机丢还是选择性丢，看 §6。');
out.push('');

out.push('## 4. 长度与 token 折算', '');
const allChars = rows.reduce((s, r) => s + r.chars, 0);
out.push(`${rows.length} 份合计 ${allChars} 字，按 1 token ≈ ${CHARS_PER_TOKEN} 汉字折算。`);
out.push('');
out.push('**这个系数仍然是估的。** 本轮没有拿到 DeepSeek 真正的 tokenizer，所以：');
out.push('');
out.push('- 结论一：**不要在 prompt 里写 token 数**，写汉字数（460 / 1300）。模型不认 token。');
out.push('- 结论二：寿命公式里那条"每条结晶多少 token"，**运行时用实测均值替换**，不要写死 320/840。');
out.push('  每次结晶后记一次 `usage.input - 上一次`，滚动平均，寿命自然准。');
out.push('');

out.push('## 5. 生成时有没有编造事实', '');
out.push('对话里只出现过 **1点47** 一个时刻。多出来的时刻都是模型自己编的：');
out.push('');
out.push('| 样本 | 编造的时刻 |');
out.push('|---|---|');
for (const r of rows) {
  out.push(`| ${r.file} | ${r.inventedTimes.length ? r.inventedTimes.join('、') : '—'} |`);
}
out.push('');

out.push('## 6. 稳定性：丢细节是随机的，还是有选择的', '');
out.push('这一节才是本轮真正要回答的问题。丢一两个细节不可怕——**可怕的是一份丢这个、下一份丢那个**。');
out.push('前者是"她觉得不重要的就糊掉"，后者是"这次回忆刚好没想起来"。前者是人格，后者是故障。');
out.push('');
for (const tier of TIERS) {
  const list = byTier[tier] || [];
  if (!list.length) continue;
  const dropCount = {};
  let totalDrops = 0;
  for (const r of list) {
    for (const [k, v] of Object.entries(r.details)) {
      if (!v) { dropCount[k] = (dropCount[k] || 0) + 1; totalDrops++; }
    }
  }
  out.push(`### ${tier}（${list.length} 份，共丢 ${totalDrops} 次）`);
  out.push('');
  out.push(`每份丢掉几个：${list.map(r => 6 - r.detailScore).join(' / ')}`);
  out.push('');
  if (!totalDrops) { out.push('一个细节都没丢。'); out.push(''); continue; }
  out.push('| 细节 | 丢了几份 | 占全部丢弃 |');
  out.push('|---|---|---|');
  const sorted = Object.entries(dropCount).sort((a, b) => b[1] - a[1]);
  for (const [k, c] of sorted) {
    out.push(`| ${k} | ${c}/${list.length} | ${Math.round(c / totalDrops * 100)}% |`);
  }
  out.push('');
  const top = sorted[0][1] / totalDrops;
  const uniq = sorted.length;
  if (uniq === 1) out.push('> ✅ **完全选择性**：每次丢的都是同一项。这是"她认为不重要"，可以写进人设，不是 bug。');
  else if (top >= 0.5) out.push('> ✅ **选择性 > 随机**：最常丢的那一项占了多数。有规律，可以接受，甚至可以做成人设。');
  else if (top >= 0.3) out.push('> ⚠️ **半随机**：丢弃开始散开。需要盯，样本再多一点才能判断。');
  else out.push('> ❌ **接近随机**：丢哪一项没有规律。这才是真问题——同一条对话，每次回忆丢掉的东西都不一样。');
  out.push('');
}

out.push('## 7. 两批对比：旧输入（带分层表）vs 干净输入', '');
out.push('第一批（-1..3）读的 `batch-01.md` 末尾有一张"这段对话里有什么"的分层表，直接点明了哪句是重点。');
out.push('第二批（-4..6）读的 `input-clean.md` **把那张表删了**——生产环境里不会有人提前告诉鲸鱼娘该记什么。');
out.push('如果第二批明显变差，说明 prompt 撑不住，之前的成绩有一半是那张表给的。');
out.push('');
out.push('| 指标 | 第一批 | 第二批（干净） |');
out.push('|---|---|---|');
for (const tier of TIERS) {
  const a = (byTier[tier] || []).filter(r => Number(r.file.match(/-(\d+)\.json$/)[1]) <= 3);
  const b = (byTier[tier] || []).filter(r => Number(r.file.match(/-(\d+)\.json$/)[1]) > 3);
  if (!a.length || !b.length) continue;
  const m = x => avg(x, 'detailScore');
  out.push(`| ${tier} 平均保住的细节 | ${m(a)}/6 | ${m(b)}/6 |`);
  out.push(`| ${tier} 平均字数 | ${avg(a, 'chars')} | ${avg(b, 'chars')} |`);
}
out.push('');
const core = ['橘子', '汽水', '1:47'];
out.push(`核心细节（${core.join(' / ')}）在两批里的命中率：`);
out.push('');
for (const tier of TIERS) {
  for (const key of core) {
    const list = byTier[tier] || [];
    const a = list.filter(r => Number(r.file.match(/-(\d+)\.json$/)[1]) <= 3 && r.details[key]).length;
    const b = list.filter(r => Number(r.file.match(/-(\d+)\.json$/)[1]) > 3 && r.details[key]).length;
    out.push(`- ${tier} · ${key}：第一批 ${a}/3，第二批 ${b}/3`);
  }
}
out.push('');

out.push('## 8. 标题重复', '');
const titles = rows.map(r => r.title);
const dup = titles.filter((t, i) => titles.indexOf(t) !== i);
out.push(dup.length ? `重复标题：${[...new Set(dup)].join('、')}（${rows.filter(r => dup.includes(r.title)).length}/${rows.length} 份撞名）` : '无重复。');
out.push('');
out.push('撞名不是错误，但说明**"最后一罐橘子汽水"是个强吸引子**。生产环境必须去重，');
out.push('否则用户攒到第 200 条时，memory 列表里会躺着六条同名结晶。');
out.push('');

fs.writeFileSync(path.join(DIR, 'verify-report.md'), out.join('\n'), 'utf8');
console.log(`\n报告已写入 samples/verify-report.md`);
