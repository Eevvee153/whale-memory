/**
 * lint.js — 结晶质量闸门
 *
 * 读完 huiguang/ 下所有 crystal-*.md，按 PROMPT.md §3 的九条禁令做自动检查。
 * 自动查得动的只有 6 条；剩下 3 条（感官是否唯一且写透 / 有没有没说出口的 /
 * 结尾是否停在物件上）必须人眼过，这里只把它们列出来提醒。
 *
 * 用法：node lint.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DIR = __dirname;
const CHARS_PER_TOKEN = 1.45; // 估值，需在真 tokenizer 上校准（见 PROMPT.md §9）
const BAND = 0.25;            // 长度带 ±25%

// 禁令 1 / 6 / 9
const BANNED = [
  ['用户', '禁令1：不能用旁观词称呼他'],
  ['人类', '禁令1：不能用旁观词称呼他'],
  ['这段对话', '禁令6：不能提"这段对话"'],
  ['这次对话', '禁令6：不能提"这次对话"'],
  ['我明白了', '禁令6：不许总结'],
  ['总的来说', '禁令6：不许总结'],
  ['意义', '禁令6/7：不许升华'],
  ['上下文', '禁令9：不许出现 meta 词'],
  ['模型', '禁令9：不许出现 meta 词'],
  ['珊瑚', '禁令9：不许出现 meta 词'],
  ['沉底', '禁令9：不许出现 meta 词'],
];

function parse(md) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) throw new Error('缺 front matter');
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: m[2].trim() };
}

const files = fs.readdirSync(DIR).filter((f) => /^crystal-.*\.md$/.test(f)).sort();
if (files.length === 0) {
  console.error('huiguang/ 下没有 crystal-*.md');
  process.exit(1);
}

const out = [];
let failed = 0;
const say = (s = '') => out.push(s);

for (const f of files) {
  const { meta, body } = parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  const chars = body.replace(/\s/g, '').length;
  const hanzi = (body.match(/[\u4e00-\u9fa5]/g) || []).length;
  const est = chars / CHARS_PER_TOKEN;
  const target = Number(meta.target_tokens || 0);
  const lo = target * (1 - BAND);
  const hi = target * (1 + BAND);

  const checks = [];
  const add = (label, ok, detail) => {
    checks.push({ label, ok, detail });
    if (!ok) failed++;
  };

  add(
    `长度带 ${Math.round(lo)}~${Math.round(hi)} token`,
    est >= lo && est <= hi,
    `${chars} 字符 / ${hanzi} 汉字 ≈ ${Math.round(est)} token`
  );
  add('第一人称"我"', body.includes('我'), '');
  add(
    '至少一句带引号的原话',
    /["“「]/.test(body),
    ''
  );
  add(
    '时间落到钟点上',
    /[0-9零一二三四五六七八九十]+点|凌晨|半夜|[一二三四五六七八九十]+月[\u4e00-\u9fa5]+日/.test(body),
    ''
  );

  const hits = BANNED.filter(([w]) => body.includes(w));
  add(
    '无禁词',
    hits.length === 0,
    hits.length ? hits.map(([w, why]) => `「${w}」→ ${why}`).join('；') : ''
  );

  const titleLen = (meta.title || '').replace(/\s/g, '').length;
  add('title 4~16 字且不是事件概括', titleLen >= 4 && titleLen <= 16, `「${meta.title}」${titleLen} 字`);

  say(`## ${f}`);
  say('');
  say(`**${meta.tier}** · 目标 ${target} token · 标题「${meta.title}」`);
  say('');
  for (const c of checks) {
    say(`- ${c.ok ? '✅' : '❌'} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
  }
  say('');
}

say('## 必须人眼过的三条');
say('');
say('- 感官细节是否**只有一个**且写透（堆三个等于没写）');
say('- 有没有一件**没说出口**的事');
say('- 结尾是否停在**物件或动作**上，而不是一句道理');
say('');
say(failed === 0 ? '**自动闸门全过。**' : `**${failed} 项未过。**`);

const text = out.join('\n');
fs.writeFileSync(path.join(DIR, 'lint-report.md'), text, 'utf8');
process.stdout.write(text + '\n');
process.exitCode = failed === 0 ? 0 : 1;
