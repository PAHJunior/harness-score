import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { TOOL_PATHS } from '../../../plugins/shared/tool-paths.mjs';
import { TOOLS } from '../../../plugins/shared/tools.mjs';
import { PLUGIN_TOOL_PATHS } from '../src/harness/registry.js';

describe('plugins/shared path config sync', () => {
  test('the legacy GitHub Action entrypoint matches the canonical root action', () => {
    const repoRoot = path.resolve(import.meta.dirname, '../../..');
    const canonical = fs.readFileSync(path.join(repoRoot, 'action.yml'), 'utf8');
    const legacy = fs.readFileSync(path.join(repoRoot, 'action/action.yml'), 'utf8');

    expect(legacy).toBe(canonical);
  });

  test('the GitHub Action metadata stays Marketplace-ready and version-aligned', () => {
    const repoRoot = path.resolve(import.meta.dirname, '../../..');
    const metadata = fs.readFileSync(path.join(repoRoot, 'action.yml'), 'utf8');
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'packages/cli/package.json'), 'utf8'),
    ) as { version: string };

    const descriptionBlock = metadata.match(/^description: >-\r?\n(?<lines>(?: {2}.+\r?\n)+)author:/m);
    const description = descriptionBlock?.groups?.lines
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trim())
      .join(' ');
    const actionVersion = metadata.match(/^ {2}version:\r?\n(?: {4}.+\r?\n)+? {4}default: '([^']+)'/m)?.[1];

    expect(description).toBeDefined();
    expect(description!.length).toBeLessThan(125);
    expect(actionVersion).toBe(packageJson.version);
  });

  test('generated TOOL_PATHS matches PLUGIN_TOOL_PATHS from the CLI harness registry exactly', () => {
    for (const [toolId, paths] of Object.entries(PLUGIN_TOOL_PATHS)) {
      const tool = TOOL_PATHS[toolId as keyof typeof TOOL_PATHS];
      expect(tool, `missing TOOL_PATHS.${toolId}`).toBeDefined();
      expect(tool.skillsDir).toBe(paths.skillsDir);
      expect(tool.commandsDir).toBe(paths.commandsDir);
      expect(tool.mcpConfigPath).toBe(paths.mcpConfigPath);
    }
    expect(Object.keys(TOOL_PATHS).sort()).toEqual(Object.keys(PLUGIN_TOOL_PATHS).sort());
  });

  test('every shipped plugin in TOOLS derives its paths from TOOL_PATHS', () => {
    for (const [toolId, tool] of Object.entries(TOOLS)) {
      const paths = TOOL_PATHS[toolId as keyof typeof TOOL_PATHS];
      expect(paths, `TOOLS.${toolId} has no registry entry in TOOL_PATHS`).toBeDefined();
      expect(tool.skillsDir).toBe(paths.skillsDir);
      expect(tool.commandsDir).toBe(paths.commandsDir);
      expect(tool.mcpConfigPath).toBe(paths.mcpConfigPath);
      expect(tool.pluginDir).toBe(`plugins/${toolId}`);
    }
  });
});
