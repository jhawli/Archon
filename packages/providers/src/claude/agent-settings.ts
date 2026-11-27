/**
 * The agents' own settings file (`assistants.claude.settingsFile`).
 *
 * A repository can keep the cage for its workflow agents (sandbox, deny rules,
 * hooks) in a file that only Archon passes on, so the people working in that
 * repository do not load it. The file is relative to the node's cwd, stays
 * inside it, and goes to the SDK's `settings` option, the `--settings` layer:
 * above project settings, and a project file cannot remove its deny rules or
 * hooks. A configured file that is missing or unreadable stops the node: an
 * agent never runs without the cage it was configured with.
 *
 * Claude Code reads a file rule such as `Edit(/gate/**)` relative to the file
 * that holds it. The SDK option is an object (the node lays its plugin scope
 * over it), which has no place on disk, so such a rule would bind nothing:
 * the Edit on gate/ci.sh went through (CONC-170 spike). Every file-tool rule
 * that starts with a single `/` is therefore anchored to the node's cwd
 * (`//<cwd>/gate/**`). The sandbox also takes Edit deny rules as write denies,
 * so the anchored rules keep sandboxed Bash out of those paths as well.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { ClassifiedProviderError } from '../shared/failure';

type SdkSettings = Exclude<Options['settings'], string | undefined>;

/** Rules naming a path; `Bash(/x)` and the like name a command and stay as written. */
const FILE_TOOLS = new Set([
  'Read',
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'NotebookRead',
  'Glob',
  'Grep',
  'LS',
]);
const RULE = /^([A-Za-z]+)\((.*)\)$/s;

/**
 * `Tool(/x)` → `Tool(//<root>/x)` for each root. A cwd reached through a
 * symlink gets the rule under both names, the given and the resolved one.
 */
export function anchorRule(rule: string, roots: readonly string[]): string[] {
  const match = RULE.exec(rule);
  if (!match) return [rule];
  const [, tool, spec] = match as unknown as [string, string, string];
  if (!FILE_TOOLS.has(tool) || !spec.startsWith('/') || spec.startsWith('//')) return [rule];
  return roots.map(root => `${tool}(/${root.replace(/\/+$/, '')}${spec})`);
}

function anchorPermissions(settings: SdkSettings, roots: readonly string[]): SdkSettings {
  const permissions = (settings as { permissions?: Record<string, unknown> }).permissions;
  if (permissions === undefined) return settings;
  if (typeof permissions !== 'object' || permissions === null || Array.isArray(permissions)) {
    throw new ClassifiedProviderError(
      'misconfigured',
      'Claude agent settings: permissions is not an object'
    );
  }
  const anchored: Record<string, unknown> = { ...permissions };
  for (const key of ['allow', 'deny', 'ask'] as const) {
    const rules = permissions[key];
    if (rules === undefined) continue;
    if (!Array.isArray(rules) || rules.some(rule => typeof rule !== 'string')) {
      throw new ClassifiedProviderError(
        'misconfigured',
        `Claude agent settings: permissions.${key} is not a list of rules`
      );
    }
    // An allow rule opens one place; under two names it would open the resolved one too.
    const names = key === 'allow' ? roots.slice(0, 1) : roots;
    anchored[key] = [...new Set((rules as string[]).flatMap(rule => anchorRule(rule, names)))];
  }
  return { ...settings, permissions: anchored } as SdkSettings;
}

export function loadAgentSettings(cwd: string, settingsFile: string): SdkSettings {
  const fail = (why: string): never => {
    throw new ClassifiedProviderError(
      'misconfigured',
      `Claude agent settings ${settingsFile}: ${why}. The agents run only with this file.`
    );
  };
  if (isAbsolute(settingsFile)) fail('must be relative to the working directory');
  let root: string;
  let path: string;
  try {
    root = realpathSync(cwd);
    path = realpathSync(resolve(cwd, settingsFile));
  } catch {
    return fail('not found');
  }
  const rel = relative(root, path);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel))
    fail('lies outside the working directory');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return fail(`cannot be read (${(error as Error).message})`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fail('is not a JSON object');
  }
  const given = resolve(cwd);
  const roots = given === root ? [root] : [given, root];
  // The file guards itself: an agent cannot rewrite its cage for the next node, by a file tool or,
  // through the sandbox's write denies, by Bash.
  const own = relative(root, path);
  const self = ['Edit', 'Write', 'MultiEdit'].flatMap(tool =>
    roots.map(name => `${tool}(/${join(name, own)})`)
  );
  const settings = anchorPermissions(parsed as SdkSettings, roots) as {
    permissions?: { deny?: string[] };
  };
  const deny = settings.permissions?.deny ?? [];
  return {
    ...settings,
    permissions: { ...settings.permissions, deny: [...new Set([...deny, ...self])] },
  } as SdkSettings;
}

/**
 * Lay the per-node settings (plugin scope) over the agent file. Only keys the
 * file does not set itself may come from the node; a node cannot loosen the cage.
 */
export function withAgentSettings(
  options: Options,
  cwd: string,
  settingsFile: string | undefined
): void {
  if (settingsFile === undefined) return;
  if (typeof options.settings === 'string') {
    throw new ClassifiedProviderError(
      'misconfigured',
      'Claude agent settings cannot be combined with a settings file path'
    );
  }
  const file = loadAgentSettings(cwd, settingsFile);
  // The SDK lays the top-level sandbox option over the settings; a node's sandbox must not
  // replace the cage's.
  if ('sandbox' in file && options.sandbox !== undefined) {
    throw new ClassifiedProviderError(
      'misconfigured',
      `Claude agent settings ${settingsFile} set the sandbox; the node may not set its own`
    );
  }
  const node = options.settings ?? {};
  const clash = Object.keys(node).filter(key => key in file);
  if (clash.length > 0) {
    throw new ClassifiedProviderError(
      'misconfigured',
      `Claude agent settings ${settingsFile} and the node both set ${clash.join(', ')}`
    );
  }
  options.settings = { ...file, ...node };
}
