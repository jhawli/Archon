import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';

import { anchorRule, loadAgentSettings, withAgentSettings } from './agent-settings';
import { ClassifiedProviderError } from '../shared/failure';
import { trackTempRoots } from '@archon/paths/test-utils';

const trackTempRoot = trackTempRoots();
const tempRoot = (prefix: string): string =>
  trackTempRoot(realpathSync(mkdtempSync(join(tmpdir(), prefix))));

let dir: string;
const FILE = '.archon/agent-settings.json';

function write(content: unknown): void {
  mkdirSync(join(dir, '.archon'), { recursive: true });
  writeFileSync(join(dir, FILE), typeof content === 'string' ? content : JSON.stringify(content));
}

function misconfigured(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ClassifiedProviderError);
    expect((error as ClassifiedProviderError).failureClass).toBe('misconfigured');
    return (error as Error).message;
  }
  throw new Error('expected a misconfigured error');
}

beforeEach(() => {
  dir = tempRoot('agent-settings-');
});

describe('anchorRule', () => {
  test('a root-anchored file rule binds to the node folder', () => {
    expect(anchorRule('Edit(/gate/**)', ['/w/repo'])).toEqual(['Edit(//w/repo/gate/**)']);
    expect(anchorRule('Read(/.env)', ['/w/repo/'])).toEqual(['Read(//w/repo/.env)']);
  });

  test('home, absolute, relative and command rules stay as written', () => {
    for (const rule of [
      'Read(~/.ssh/**)',
      'Read(//Volumes/**)',
      'Edit(src/**)',
      'Bash(/usr/bin/x)',
      'Edit',
    ]) {
      expect(anchorRule(rule, ['/w/repo'])).toEqual([rule]);
    }
  });

  test('a second name of the folder gets the rule too', () => {
    expect(anchorRule('Edit(/gate/**)', ['/a', '/b'])).toEqual([
      'Edit(//a/gate/**)',
      'Edit(//b/gate/**)',
    ]);
  });
});

describe('loadAgentSettings', () => {
  test('passes the file on with deny and ask rules anchored to the node folder', () => {
    write({
      sandbox: { enabled: true },
      permissions: {
        deny: ['Edit(/gate/**)', 'Read(~/.ssh/**)'],
        ask: ['Write(/x)'],
        allow: ['Read(/docs/**)'],
      },
    });
    expect(loadAgentSettings(dir, FILE)).toEqual({
      sandbox: { enabled: true },
      permissions: {
        deny: [`Edit(/${dir}/gate/**)`, 'Read(~/.ssh/**)'],
        ask: [`Write(/${dir}/x)`],
        allow: [`Read(/${dir}/docs/**)`],
      },
    });
  });

  test('a cwd behind a symlink denies under both names, allows under the given one', () => {
    write({ permissions: { deny: ['Edit(/gate/**)'], allow: ['Read(/docs/**)'] } });
    const link = `${dir}-link`;
    symlinkSync(dir, link);
    try {
      const settings = loadAgentSettings(link, FILE) as { permissions: Record<string, string[]> };
      expect(settings.permissions.deny).toEqual([
        `Edit(/${link}/gate/**)`,
        `Edit(/${dir}/gate/**)`,
      ]);
      expect(settings.permissions.allow).toEqual([`Read(/${link}/docs/**)`]);
    } finally {
      rmSync(link);
    }
  });

  test('fails closed: missing, unreadable, not an object, outside the folder, absolute', () => {
    expect(misconfigured(() => loadAgentSettings(dir, FILE))).toContain('not found');
    write('{ nope');
    expect(misconfigured(() => loadAgentSettings(dir, FILE))).toContain('cannot be read');
    write('[]');
    expect(misconfigured(() => loadAgentSettings(dir, FILE))).toContain('not a JSON object');
    write({ permissions: { deny: 'Edit(/gate/**)' } });
    expect(misconfigured(() => loadAgentSettings(dir, FILE))).toContain('permissions.deny');
    const outside = tempRoot('agent-settings-out-');
    writeFileSync(join(outside, 's.json'), '{}');
    expect(
      misconfigured(() => loadAgentSettings(dir, `../${outside.split('/').pop()}/s.json`))
    ).toContain('outside the working directory');
    symlinkSync(join(outside, 's.json'), join(dir, 'linked.json'));
    expect(misconfigured(() => loadAgentSettings(dir, 'linked.json'))).toContain(
      'outside the working directory'
    );
    expect(misconfigured(() => loadAgentSettings(dir, join(dir, FILE)))).toContain('relative');
  });
});

describe('withAgentSettings', () => {
  test('without a configured file the options stay as they are', () => {
    const options = { settings: { syncClaudeAiPlugins: false } } as Options;
    withAgentSettings(options, dir, undefined);
    expect(options.settings).toEqual({ syncClaudeAiPlugins: false });
  });

  test('lays the node plugin scope over the cage', () => {
    write({ sandbox: { enabled: true } });
    const options = {
      settings: { enabledPlugins: { a: false }, syncClaudeAiPlugins: false },
    } as Options;
    withAgentSettings(options, dir, FILE);
    expect(options.settings).toEqual({
      sandbox: { enabled: true },
      enabledPlugins: { a: false },
      syncClaudeAiPlugins: false,
    });
  });

  test('a node cannot replace a key of the cage', () => {
    write({ enabledPlugins: { a: true } });
    const options = { settings: { enabledPlugins: { a: false } } } as Options;
    expect(misconfigured(() => withAgentSettings(options, dir, FILE))).toContain('enabledPlugins');
  });
});
