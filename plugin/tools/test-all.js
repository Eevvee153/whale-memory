// ============================================================================
// 测试跑批器
// ============================================================================
//
// 为什么不用 `node --test test/`：--test 会给每个测试文件起一个子进程，
// 在某些受限环境（比如沙箱里禁止管道）会直接 spawn EPERM。
// 这里改成在主进程里逐个 import —— 行为一样（node:test 仍在主进程跑），
// 但一个子进程都不起。
//
// ============================================================================

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'test');

const files = (await fs.readdir(dir))
  .filter((f) => f.endsWith('.test.js'))
  .sort();

if (!files.length) {
  console.error('没有找到任何 *.test.js');
  process.exit(1);
}

for (const f of files) {
  await import(pathToFileURL(path.join(dir, f)).href);
}
