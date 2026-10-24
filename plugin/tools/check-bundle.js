// ============================================================================
// bundle 结构自检：装之前先证明"这份包是能被读懂的"
// ============================================================================
//
// 真机安装（plugin_manager.install_bundle）由用户在应用内点，我这边能证明的
// 只有"静态上没毛病"。这个脚本查五件事：
//
//   1. package.json 能解析、且 dsh.bundle.patch 指向的文件真实存在
//   2. cordis.patch.yml 是合法 YAML，且结构是 [{ insert: [{ id, name, config }] }]
//   3. exports 里的每个路径都真实存在（locale / icon 尤其容易漏）
//   4. files 里点到的东西都在（本地目录安装虽不按 files 过滤，发布时会）
//   5. 补丁里每条的 name 与本包或宿主包对得上（本包写错名字 = 装上后找不到模块）
//
// 用法：node tools/check-bundle.js
// ============================================================================

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(here, '..');

const problems = [];
const notes = [];
const fail = (msg) => problems.push(msg);

// js-yaml 由宿主的 profile 提供，不在本包依赖里。这里按可能的安装位置找一圈，
// 找不到就跳过 YAML 解析（不阻断自检——结构检查其余部分仍然有效）。
const yaml = loadJsYaml();
if (!yaml) notes.push('跳过 YAML 解析：找不到 js-yaml（只在宿主 profile 里）');

function loadJsYaml() {
  const bases = [];
  if (process.env.DSH_HOME) bases.push(path.join(process.env.DSH_HOME, 'profiles', 'desktop') + path.sep);
  if (process.env.USERPROFILE) bases.push(path.join(process.env.USERPROFILE, '.dsh', 'profiles', 'desktop') + path.sep);
  bases.push(path.join(pkgDir, 'node_modules') + path.sep);
  for (const base of bases) {
    try {
      return createRequire(base)('js-yaml');
    } catch {
      // 换下一个候选位置
    }
  }
  return null;
}

// --- 1. manifest -------------------------------------------------------------
const pkgText = readFileSync(path.join(pkgDir, 'package.json'), 'utf8');
if (pkgText.charCodeAt(0) === 0xfeff) fail('package.json 带 BOM（JSON.parse 会炸）');
const pkg = JSON.parse(pkgText);

if (pkg.type !== 'module') fail('package.json 的 type 必须是 module');
const patchRel = pkg.dsh?.bundle?.patch;
if (!patchRel) fail('package.json 缺 dsh.bundle.patch');
const patchPath = path.join(pkgDir, patchRel ?? 'cordis.patch.yml');
if (!existsSync(patchPath)) fail(`补丁文件不存在：${patchRel}`);

// --- 2. patch 结构 -----------------------------------------------------------
let patchText = '';
let parsed = null;
if (existsSync(patchPath)) {
  patchText = readFileSync(patchPath, 'utf8');
  if (patchText.charCodeAt(0) === 0xfeff) fail('cordis.patch.yml 带 BOM');
  if (yaml) {
    try {
      parsed = yaml.load(patchText);
    } catch (err) {
      fail(`cordis.patch.yml 不是合法 YAML：${err.message.split('\n')[0]}`);
    }
  }
}

if (Array.isArray(parsed)) {
  if (parsed.length === 0) fail('补丁是空数组');
  for (const [i, op] of parsed.entries()) {
    const inserts = op?.insert;
    if (!Array.isArray(inserts)) {
      fail(`补丁第 ${i + 1} 条不是 { insert: [...] } 形状`);
      continue;
    }
    for (const row of inserts) {
      if (!row?.id) fail(`insert 里有一行没有 id`);
      if (!row?.name) fail(`insert 行 ${row?.id ?? '?'} 没有 name`);
      if (row?.name && !isKnownPackage(row.name)) {
        fail(`insert 行 ${row.id} 的 name「${row.name}」既不是本包，也不是已知宿主包`);
      }
      if (row?.id && /#/.test(String(row.id))) fail(`id 不能带注释：${row.id}`);
    }
  }
} else if (yaml && parsed !== null) {
  fail('补丁顶层必须是数组');
}

function isKnownPackage(name) {
  if (name === pkg.name) return true;
  const known = [
    '@deepseek-ai/dsh-persona',
    '@deepseek-ai/dsh-agent-preset',
    '@deepseek-ai/dsh-tool-ask-user',
    '@deepseek-ai/dsh-system-prompt',
    '@deepseek-ai/dsh-tools',
  ];
  return known.includes(name);
}

// --- 3. exports 与 files 指向的东西都得真在 -----------------------------------
for (const [key, target] of Object.entries(pkg.exports ?? {})) {
  if (typeof target !== 'string') continue;
  if (target.includes('*')) {
    // 通配导出：至少要求目录存在
    const dir = path.join(pkgDir, path.dirname(target).replace('*', ''));
    if (!existsSync(dir)) fail(`exports["${key}"] 指向的目录不存在：${target}`);
    continue;
  }
  if (!existsSync(path.join(pkgDir, target))) fail(`exports["${key}"] 指向的文件不存在：${target}`);
}

for (const entry of pkg.files ?? []) {
  if (entry.includes('*')) {
    const dir = path.join(pkgDir, path.dirname(entry));
    if (!existsSync(dir)) fail(`files 里的目录不存在：${entry}`);
  } else if (!existsSync(path.join(pkgDir, entry))) {
    fail(`files 里的文件不存在：${entry}`);
  }
}

// --- 4. 入口能 import（语法 + 导出形状）---------------------------------------
const entry = pkg.main ?? './lib/index.js';
try {
  const mod = await import(pathToFileURL(path.join(pkgDir, entry)).href);
  if (typeof mod.apply !== 'function') fail(`${entry} 没有导出 apply()`);
  if (typeof mod.name !== 'string' || !mod.name) fail(`${entry} 没有导出 name`);
  if (!Array.isArray(mod.inject)) fail(`${entry} 的 inject 必须是数组`);
  notes.push(`入口导出：name=${mod.name} inject=[${mod.inject.join(', ')}]`);
} catch (err) {
  fail(`入口 import 失败：${String(err.message).split('\n')[0]}`);
}

// --- 5. 元数据（插件管理里显示的名字）----------------------------------------
for (const loc of ['locale/zh.json', 'locale/en.json']) {
  const p = path.join(pkgDir, loc);
  if (!existsSync(p)) {
    fail(`缺 ${loc}（插件管理里会退化成包名和空描述）`);
    continue;
  }
  try {
    const meta = JSON.parse(readFileSync(p, 'utf8'));
    if (!meta?.meta?.title) fail(`${loc} 缺 meta.title`);
    if (!meta?.meta?.description) fail(`${loc} 缺 meta.description`);
  } catch (err) {
    fail(`${loc} 不是合法 JSON：${err.message}`);
  }
}
if (!existsSync(path.join(pkgDir, 'icon.svg'))) fail('缺 icon.svg（会用默认图形）');

// --- 输出 --------------------------------------------------------------------
for (const n of notes) console.log(`· ${n}`);
if (problems.length) {
  console.error(`\n✗ ${problems.length} 个问题：`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('\n✓ bundle 结构自检通过');
