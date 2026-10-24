#!/usr/bin/env node
// ============================================================================
// 参数一致性检查：PARAMS.md  ⇄  plugin/core/params.js
// ============================================================================
//
// PARAMS.md 是人读的、也是仿真的输入；params.js 是运行时唯一来源。
// 两边手抄一遍就一定会漂，所以这里做逐字段比对，漂了就 exit 1。
//
// 用法：
//   node tools/check-params.js          # 比对，漂了就红
//   node tools/check-params.js --show   # 顺便把 PARAMS.md 里的值打出来
//
// ============================================================================

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { P } from '../core/params.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const docPath = path.resolve(here, '../../PARAMS.md');
const show = process.argv.includes('--show');

const doc = readFileSync(docPath, 'utf8');
const m = doc.match(/<!--\s*PARAMS:JSON\s*-->\s*```json\s*([\s\S]*?)```/);
if (!m) {
  console.error(`✖ ${docPath} 里找不到 <!-- PARAMS:JSON --> 代码块`);
  process.exit(1);
}
const fromDoc = JSON.parse(m[1]);

const diffs = [];
for (const [k, v] of Object.entries(P)) {
  if (!(k in fromDoc)) {
    diffs.push(`  · ${k}: params.js 有（${JSON.stringify(v)}），PARAMS.md 没有`);
    continue;
  }
  const a = fromDoc[k];
  const same =
    typeof v === 'object' && v !== null
      ? JSON.stringify(v) === JSON.stringify(a)
      : Math.abs(Number(v) - Number(a)) < 1e-9;
  if (!same) {
    diffs.push(`  · ${k}: PARAMS.md = ${JSON.stringify(a)} ≠ params.js = ${JSON.stringify(v)}`);
  }
}
for (const k of Object.keys(fromDoc)) {
  if (!(k in P)) diffs.push(`  · ${k}: PARAMS.md 有，params.js 没读`);
}

if (show) {
  console.log('PARAMS.md 当前值：');
  for (const [k, v] of Object.entries(fromDoc)) console.log(`  ${k} = ${JSON.stringify(v)}`);
}

if (diffs.length) {
  console.error(`✖ 参数漂移（${diffs.length} 处）：`);
  console.error(diffs.join('\n'));
  console.error('\n改参数只改 PARAMS.md，再照着改 params.js，然后重跑 sim.js。');
  process.exit(1);
}

console.log(`✔ 参数一致：${Object.keys(P).length} 个字段，PARAMS.md ⇄ params.js`);
