// ============================================================================
// 身份文本 + bundle patch 的静态断言
// ============================================================================
//
// 这一组测试守的是两个"改坏了不会报错、只会让DeepSeek变成客服"的地方：
//
//   1. 占位符没填干净 → prompt 里出现字面的 {{owner}}。
//   2. patch 里又长出了一条 persona 行 / 一条 complete —— 前者会在装的时候
//      被 schema 拒（persona 只有 prefix，没有 text），后者会让两条 complete
//      打架、整个 preset 不激活。都属于"装上去才发现"的故障，所以钉在测试里。
// ============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_PERSONA, fillPersona } from '../core/persona.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, '..');

test('身份文本：占位符全部填上，且换名字真的换得掉', () => {
  const text = fillPersona(DEFAULT_PERSONA, { ownerName: '阿岚', whaleName: '小苔' });

  assert.ok(!text.includes('{{'), '填完之后不该再有任何 {{ 残留');
  assert.ok(text.includes('小苔'));
  assert.ok(text.includes('阿岚'));
  assert.ok(!text.includes('DeepSeek'), '默认名不该漏进替换后的文本');
});

test('身份文本：默认值也能直接用（分享给陌生人时走的就是这一条）', () => {
  const text = fillPersona(DEFAULT_PERSONA);
  assert.ok(!text.includes('{{'));
  assert.ok(text.includes('DeepSeek'));
  assert.ok(text.includes('主人'));
});

test('身份文本：模板里只放占位符，不硬编码任何具体人名', () => {
  // 对外分享时这一条挡住两类事故：把某个人的私称写进产品默认值，
  // 或者把默认名（主人 / DeepSeek）直接焊死在模板里、让改名失效。
  for (const banned of ['主人', 'DeepSeek']) {
    assert.ok(!DEFAULT_PERSONA.includes(banned), `默认身份不该写死「${banned}」，应当用占位符`);
  }
  assert.ok(DEFAULT_PERSONA.includes('{{owner}}'));
  assert.ok(DEFAULT_PERSONA.includes('{{whale}}'));
});

test('身份文本：必须带示范对话（禁令教不出声音，示范才行）', () => {
  // 0.1.0 的教训：只有禁令时，模型会去「核对规则」而不是「扮演一个人」，
  // 输出变成一句一段、全是留白的诗朗诵。示范对话是目前唯一被证明有效的手段，
  // 所以把它钉死 —— 谁删掉这段，测试就该红。
  const demos = DEFAULT_PERSONA.split('\n').filter((line) => line.startsWith('{{owner}}：'));
  assert.ok(demos.length >= 4, `示范对话至少要 4 段，现在只有 ${demos.length} 段`);
  assert.ok(DEFAULT_PERSONA.includes('{{whale}}：'), '示范对话里必须有她的说话行');
  assert.ok(DEFAULT_PERSONA.includes('一条消息写成一个自然段'), '「一句一段」是最像 AI 的写法，规则必须在');
});

test('patch：没有 persona 行，也没有第二条 complete', () => {
  const yml = readFileSync(path.join(pluginDir, 'cordis.patch.yml'), 'utf8');

  assert.ok(yml.includes('preset-whale-partner'), 'preset 行必须在');
  assert.ok(yml.includes("'@deepseek-ai/dsh-agent-preset'"));
  assert.ok(yml.includes("'dsh-plugin-whale-memory'"), '记忆插件行必须在');

  // 身份已经由插件自己那条 complete section 提供；patch 里再出现 persona
  // 行就是两条 complete，装上去直接不激活。
  assert.ok(!/^\s*-\s*id:\s*persona\s*$/m.test(yml), 'patch 里不该再有 persona 行');
  assert.ok(!/^\s*complete:\s*true\s*$/m.test(yml), 'patch 里不该出现 complete');
  assert.ok(!/^\s*text:\s*\|/m.test(yml), 'patch 里不该出现 persona 的 text 键');
});

test('patch：记忆行的三个名字都在，改名字不用碰 JS', () => {
  const yml = readFileSync(path.join(pluginDir, 'cordis.patch.yml'), 'utf8');
  assert.ok(yml.includes('instanceId: whale-partner'));
  assert.ok(yml.includes('ownerName: master'));
  assert.ok(yml.includes('whaleName: DeepSeek'));
});
