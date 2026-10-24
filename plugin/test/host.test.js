// ============================================================================
// 宿主半侧的纯函数测试
// ============================================================================
//
// 这里测的是"把 DSH 的消息列表翻译成她的一轮对话"这段逻辑。
// 它是整条链上最容易静默出错的地方：错一个字段，记忆里就会多出一堆
// 工具返回值，消化出来的东西读起来像服务器日志，而且**不会报错**。
//
// ============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { takeTurn, parseLooseJson, sessionIdOf } from '../lib/index.js';

const textMsg = (role, text) => ({ role, content: [{ type: 'text', text }] });

test('takeTurn: 一轮里取出主人的话和她的回应', () => {
  const turn = takeTurn([
    textMsg('user', '今天开会被人当着十几个人说了一顿'),
    textMsg('assistant', '……他说什么了。'),
  ]);
  assert.equal(turn.owner, '今天开会被人当着十几个人说了一顿');
  assert.equal(turn.whale, '……他说什么了。');
});

test('takeTurn: 带工具块的消息整条跳过，绝不进记忆', () => {
  const turn = takeTurn([
    textMsg('user', '帮我看下这个文件'),
    { role: 'assistant', content: [{ type: 'tool-call', name: 'read', input: {} }] },
    { role: 'user', content: [{ type: 'tool-result', content: 'x'.repeat(5000) }] },
    textMsg('assistant', '看了。'),
  ]);
  assert.equal(turn.owner, '帮我看下这个文件');
  assert.equal(turn.whale, '看了。');
  assert.ok(!JSON.stringify(turn).includes('xxxxxxxxxx'));
});

test('takeTurn: 只有一条消息时，另一个字段是 null 而不是空串', () => {
  const turn = takeTurn([textMsg('user', '在吗')]);
  assert.equal(turn.owner, '在吗');
  assert.equal(turn.whale, null);
});

test('takeTurn: 空数组 / undefined 不炸', () => {
  assert.deepEqual(takeTurn([]), { owner: null, whale: null });
  assert.deepEqual(takeTurn(undefined), { owner: null, whale: null });
});

test('takeTurn: content 是裸字符串也认', () => {
  const turn = takeTurn([{ role: 'user', content: '  嗯  ' }]);
  assert.equal(turn.owner, '嗯');
});

test('parseLooseJson: 去掉 ```json 围栏', () => {
  const obj = parseLooseJson('```json\n{"memories":[{"title":"橘子汽水"}]}\n```');
  assert.equal(obj.memories[0].title, '橘子汽水');
});

test('parseLooseJson: 前面有寒暄也能抠出 JSON', () => {
  const obj = parseLooseJson('好的，我写完了：\n{"title":"六个点"}\n希望你喜欢。');
  assert.equal(obj.title, '六个点');
});

test('parseLooseJson: 没 JSON 时返回 null，不抛错', () => {
  assert.equal(parseLooseJson('我想了想，还是写不出来。'), null);
  assert.equal(parseLooseJson(''), null);
  assert.equal(parseLooseJson(null), null);
});

test('parseLooseJson: 坏 JSON 返回 null（交给上层记一笔，不静默吞）', () => {
  assert.equal(parseLooseJson('{"title": "缺个引号}'), null);
});

test('sessionIdOf: 三种会话形状都认', () => {
  assert.equal(
    sessionIdOf({ agent: { session: { header: { id: 's1' } } } }),
    's1',
  );
  assert.equal(sessionIdOf({ agent: { session: { id: 's2' } } }), 's2');
  assert.equal(sessionIdOf({ agent: { id: 'a3' } }), 'a3');
  assert.equal(sessionIdOf({}), 'default');
  assert.equal(sessionIdOf(undefined), 'default');
});
