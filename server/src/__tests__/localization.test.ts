import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { chinese, createI18n, initialLanguage, translate } from '../../../web/src/localization';
import { relativeActivity, taskTitle } from '../../../web/src/presentation';

describe('Chinese and English interface', () => {
  it('preserves every message parameter in both languages', () => {
    const params = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
    for (const [english, translated] of Object.entries(chinese)) {
      expect(translated.trim(), english).not.toBe('');
      expect(params(translated), english).toEqual(params(english));
    }
    expect(translate('zh', 'Tool: {name}', { name: '$1 {literal}' })).toBe('工具：$1 {literal}');
  });

  it('covers literal interface messages without translating authored content or unknown diagnostics', () => {
    const root = path.resolve('web/src');
    const files = ['App.tsx', ...readdirSync(path.join(root, 'components')).filter(file => file.endsWith('.tsx')).map(file => `components/${file}`)];
    const missing = new Set<string>();
    for (const file of files) {
      const source = ts.createSourceFile(file, readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 't') {
          const message = node.arguments[0];
          if (message && ts.isStringLiteral(message) && !Object.hasOwn(chinese, message.text)) missing.add(message.text);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect([...missing]).toEqual([]);
    expect(translate('zh', 'vendor failure 123')).toBe('vendor failure 123');
    expect(translate('zh', 'constructor')).toBe('constructor');
    expect(createI18n('zh').label('__proto__')).toBe('__proto__');
    for (const language of ['zh', 'en'] as const) {
      expect(taskTitle({ id: '123456789', name: '用户任务 Original name', preview: null }, language)).toBe('用户任务 Original name');
    }
  });

  it('localizes statuses, durations, errors and dates while retaining exact identifiers', () => {
    const zh = createI18n('zh');
    const en = createI18n('en');
    expect(zh.label('waiting_on_human')).toBe('等待处理');
    expect(en.label('waiting_on_human')).toBe('Waiting for you');
    expect(zh.windowLabel('15-minute')).toBe('15 分钟');
    expect(zh.windowLabel('3-day')).toBe('3 天');
    expect(en.windowLabel('3-day')).toBe('3-day');
    expect(zh.error('Request failed with 403')).toBe('请求失败，状态码 403');
    expect(zh.error('Monitor snapshot request timed out.')).toBe('Monitor 数据请求超时。');
    expect(zh.error('Monitor WebSocket connection timed out.')).toBe('Monitor 实时连接超时。');
    expect(zh.error('Codex app-server restart is delayed; retry in 60 seconds.')).toBe('Codex 后台连接正在等待重试，60 秒后可重试。');
    expect(en.error('Codex app-server restart is delayed; retry in 60 seconds.')).toBe('Codex app-server restart is delayed; retry in 60 seconds.');
    expect(zh.dateTime('invalid')).toBe('不可用');
    const time = '2026-09-22T02:00:00Z';
    expect(zh.dateTime(time)).toBe(new Date(time).toLocaleString('zh-CN'));
    expect(en.dateTime(time)).toBe(new Date(time).toLocaleString('en-US'));
    expect(relativeActivity(time, Date.parse(time) + 180000, 'zh')).toBe('3 分钟前');
    expect(relativeActivity(time, Date.parse(time) + 180000, 'en')).toBe('3 min ago');
  });

  it('defaults to English for new visitors and restores either saved language', () => {
    expect(initialLanguage()).toBe('en');
    expect(initialLanguage({ getItem: () => null })).toBe('en');
    expect(initialLanguage({ getItem: () => 'zh' })).toBe('zh');
    expect(initialLanguage({ getItem: () => 'en' })).toBe('en');
    expect(initialLanguage({ getItem: () => 'invalid' })).toBe('en');
    expect(initialLanguage({ getItem: () => { throw new Error('Storage blocked'); } })).toBe('en');
  });
});
