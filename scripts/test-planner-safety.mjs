// Dependency-free regression checks against the real TypeScript planner.
// Run with Node >=22.13: node --test scripts/test-planner-safety.mjs
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`;
const contracts = moduleUrl(await readFile(new URL('../packages/contracts/src/index.ts', import.meta.url), 'utf8'));
const source = await readFile(new URL('../apps/cloud/src/tasks/planner.ts', import.meta.url), 'utf8');
const { draftPlan } = await import(moduleUrl(source.replaceAll('"@mcai/contracts"', JSON.stringify(contracts))));
const create = (intent, preferredTool) => draftPlan('mcs:daemon:instance', 'rev-1', intent, { preferredTool });

for (const intent of ['Read logs, do not stop the server', "Read logs, don't shut down the server", '读取日志，不要重启服务器']) {
  test(`negated lifecycle: ${intent}`, () => assert.ok(create(intent).steps.every(step => step.risk === 'read')));
}
for (const intent of ['查看配置', '查看视距当前是多少', '读取 server.properties，不要修改配置']) {
  test(`configuration inspection: ${intent}`, () => assert.equal(create(intent).steps[0].tool, 'config.inspect'));
}
test('explicit view-distance write', () => assert.deepEqual(create('把视距改为 8').steps[0].args.patch, [{ op: 'replace', key: 'view-distance', value: 8 }]));
test('plugin installation does not reinstall server', () => assert.deepEqual(create('在 Paper 1.21.1 上安装 ProtocolLib 插件，不要重启', 'plugin.install').steps.map(step => step.tool), ['plugin.resolve', 'plugin.install']));
test('read-only preference does not install server', () => assert.equal(create('检查安装 Paper 1.21.1 失败的日志', 'logs.query').steps[0].tool, 'logs.query'));
for (const intent of ['I do not accept Minecraft EULA; install Paper 1.21.1', '我不同意 Minecraft EULA，安装 Paper 1.21.1']) {
  test(`negative EULA consent: ${intent}`, () => assert.equal(create(intent).steps[0].args.accept_eula, false));
}
test('negated server installation', () => assert.equal(create('不要安装 Paper 1.21.1，读取日志').steps[0].tool, 'logs.query'));
test('negated plugin installation overrides model preference', () => assert.deepEqual(create('不要安装 ProtocolLib 插件', 'plugin.install').steps.map(step => step.tool), ['plugin.resolve']));
test('explicit EULA consent remains supported', () => assert.equal(create('我同意 Minecraft EULA，请安装 Paper 1.21.1').steps[0].args.accept_eula, true));
test('explicit stop requires confirmation', () => assert.equal(create('Stop the server').steps[0].requires_confirmation, true));
test('health inspection remains multi-step and read-only', () => assert.deepEqual(create('检查服务器健康').steps.map(step => step.tool), ['console.command', 'console.command', 'logs.query']));
