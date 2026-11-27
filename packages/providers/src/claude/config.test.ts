import { describe, expect, test } from 'bun:test';

import { parseClaudeConfig, parseClaudeConfigStrict, type ClaudeProviderDefaults } from './config';

// Exclude the opaque provider-config index signature, requiring every declared field.
type CompleteClaudeConfig = {
  [Key in keyof ClaudeProviderDefaults as string extends Key
    ? never
    : Key]-?: ClaudeProviderDefaults[Key];
};

describe('Claude config contract', () => {
  test('strict and runtime parsers preserve every canonical Claude setting', () => {
    const config = {
      model: 'sonnet',
      settingSources: ['project', 'user'],
      claudeBinaryPath: '/configured/claude',
      settingsFile: '.archon/agent-settings.json',
    } satisfies CompleteClaudeConfig;

    expect(parseClaudeConfigStrict(config)).toEqual(config);
    expect(parseClaudeConfig(config)).toEqual(config);
  });
});

describe('parseClaudeConfig settingsFile', () => {
  test('a value that is not a path fails instead of dropping the cage', () => {
    for (const settingsFile of [42, '', '   ', ['x']]) {
      expect(() => parseClaudeConfig({ settingsFile })).toThrow('settingsFile');
    }
  });

  test('the strict parsers accept the key', () => {
    expect(parseClaudeConfigStrict({ settingsFile: 'a.json' }, 'run')).toEqual({
      settingsFile: 'a.json',
    });
  });
});

describe('parseClaudeConfig settingSources', () => {
  test('narrows to the recognized subset', () => {
    expect(parseClaudeConfig({ settingSources: ['project', 'user'] }).settingSources).toEqual([
      'project',
      'user',
    ]);
  });

  test('preserves an explicitly empty list rather than widening to defaults', () => {
    expect(parseClaudeConfig({ settingSources: [] }).settingSources).toEqual([]);
  });

  test('a wholly invalid list resolves to no sources, never the permissive default', () => {
    // Regression: the previous guard left settingSources unset here, so a single
    // typo fell through to the ['project','user'] default at provider level —
    // silently granting the ambient access the author was trying to exclude.
    expect(parseClaudeConfig({ settingSources: ['projct'] }).settingSources).toEqual([]);
  });

  test('drops only the invalid entry when some are valid', () => {
    expect(parseClaudeConfig({ settingSources: ['project', 'usr'] }).settingSources).toEqual([
      'project',
    ]);
  });

  test('leaves settingSources unset when the key is absent or not an array', () => {
    expect(parseClaudeConfig({}).settingSources).toBeUndefined();
    expect(parseClaudeConfig({ settingSources: 'project' }).settingSources).toBeUndefined();
  });
});
