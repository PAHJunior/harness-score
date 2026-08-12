import * as path from 'node:path';
import type { ScanContext, ScanDiagnostic } from '../types.js';
import { safeJsonParse } from '../util.js';
import { collectHookConfigs, type HarnessArtifact } from './collectors.js';

/** Events documented at cursor.com/docs - kept permissive on purpose. */
const CURSOR_KNOWN_EVENTS = new Set([
  'sessionStart',
  'sessionEnd',
  'preToolUse',
  'postToolUse',
  'postToolUseFailure',
  'subagentStart',
  'subagentStop',
  'beforeShellExecution',
  'afterShellExecution',
  'beforeMCPExecution',
  'afterMCPExecution',
  'beforeReadFile',
  'afterFileEdit',
  'beforeSubmitPrompt',
  'preCompact',
  'stop',
  'afterAgentResponse',
  'afterAgentThought',
  'beforeTabFileRead',
  'afterTabFileEdit',
  'workspaceOpen',
]);

const CURSOR_GATE_EVENTS = new Set([
  'beforeShellExecution',
  'beforeMCPExecution',
  'preToolUse',
  'beforeReadFile',
]);

const CURSOR_FEEDBACK_EVENTS = new Set([
  'afterFileEdit',
  'postToolUse',
  'afterShellExecution',
  'stop',
  'afterAgentResponse',
]);

/** Claude Code hook events documented at code.claude.com/docs/en/hooks on 2026-08-12. */
const CLAUDE_KNOWN_EVENTS = new Set([
  'SessionStart',
  'Setup',
  'InstructionsLoaded',
  'UserPromptSubmit',
  'UserPromptExpansion',
  'MessageDisplay',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'PermissionDenied',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'TaskCreated',
  'TaskCompleted',
  'Stop',
  'StopFailure',
  'TeammateIdle',
  'ConfigChange',
  'CwdChanged',
  'DirectoryAdded',
  'FileChanged',
  'WorktreeCreate',
  'WorktreeRemove',
  'PreCompact',
  'PostCompact',
  'SessionEnd',
  'Elicitation',
  'ElicitationResult',
]);

const CLAUDE_GATE_EVENTS = new Set(['PreToolUse', 'PermissionRequest']);
const CLAUDE_FEEDBACK_EVENTS = new Set([
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'Stop',
  'StopFailure',
]);
const CLAUDE_HANDLER_TYPES = new Set(['command', 'http', 'mcp_tool', 'prompt', 'agent']);

export interface HookCommandInvocation {
  command: string;
  args: string[];
}

export interface NormalizedHooks {
  source: string;
  canonicalSource: string;
  nativeDepth: number;
  toolId: 'cursor' | 'claude-code';
  hasHooksObject: boolean;
  hasVersion: boolean;
  events: string[];
  gateEvents: string[];
  feedbackEvents: string[];
  commands: HookCommandInvocation[];
  handlerCount: number;
  structuralErrors: string[];
  selectionWarnings: ScanDiagnostic[];
  eventWarnings: ScanDiagnostic[];
}

function stringArray(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return null;
  return value as string[];
}

function unknownEventWarnings(source: string, events: string[], knownEvents: Set<string>): ScanDiagnostic[] {
  return events
    .filter((event) => event.length > 0 && !knownEvents.has(event))
    .map((event) => ({
      code: 'unknown-hook-event',
      source,
      message: `${event} is structurally valid but is not in this harness-score version's event catalog.`,
    }));
}

function baseNormalized(
  artifact: HarnessArtifact,
  toolId: 'cursor' | 'claude-code',
): Omit<NormalizedHooks, 'hasHooksObject' | 'hasVersion' | 'events' | 'gateEvents' | 'feedbackEvents'> {
  return {
    source: artifact.path,
    canonicalSource: artifact.canonicalPath,
    nativeDepth: artifact.nativeDepth,
    toolId,
    commands: [],
    handlerCount: 0,
    structuralErrors: [],
    selectionWarnings: [],
    eventWarnings: [],
  };
}

function normalizeCursor(artifact: HarnessArtifact, content: string): NormalizedHooks | null {
  const parsed = safeJsonParse(content);
  if (parsed === null || typeof parsed !== 'object') return null;
  const config = parsed as Record<string, unknown>;
  const hooks = config.hooks;
  const hasHooksObject = hooks !== null && typeof hooks === 'object' && !Array.isArray(hooks);
  const events = hasHooksObject ? Object.keys(hooks as Record<string, unknown>) : [];
  const normalized: NormalizedHooks = {
    ...baseNormalized(artifact, 'cursor'),
    hasHooksObject,
    hasVersion: config.version !== undefined,
    events,
    gateEvents: events.filter((event) => CURSOR_GATE_EVENTS.has(event)),
    feedbackEvents: events.filter((event) => CURSOR_FEEDBACK_EVENTS.has(event)),
    eventWarnings: unknownEventWarnings(artifact.path, events, CURSOR_KNOWN_EVENTS),
  };

  if (!hasHooksObject) {
    normalized.structuralErrors.push('hooks must be an object.');
    return normalized;
  }

  for (const [event, handlers] of Object.entries(hooks as Record<string, unknown>)) {
    if (event.length === 0) normalized.structuralErrors.push('Hook event names must not be empty.');
    if (!Array.isArray(handlers) || handlers.length === 0) {
      normalized.structuralErrors.push(`${event || '<empty>'} handlers must be a non-empty array.`);
      continue;
    }
    for (const handler of handlers) {
      if (!handler || typeof handler !== 'object' || Array.isArray(handler)) {
        normalized.structuralErrors.push(`${event || '<empty>'} contains a non-object handler.`);
        continue;
      }
      const value = handler as Record<string, unknown>;
      const args = stringArray(value.args);
      if (typeof value.command !== 'string' || value.command.trim().length === 0 || args === null) {
        normalized.structuralErrors.push(`${event || '<empty>'} contains an invalid command handler.`);
        continue;
      }
      normalized.handlerCount += 1;
      normalized.commands.push({ command: value.command, args });
    }
  }
  return normalized;
}

function validateClaudeHandler(
  event: string,
  value: Record<string, unknown>,
  normalized: NormalizedHooks,
): void {
  if (typeof value.type !== 'string' || !CLAUDE_HANDLER_TYPES.has(value.type)) {
    normalized.structuralErrors.push(`${event} contains a handler with an unknown or missing type.`);
    return;
  }

  if (value.type === 'command') {
    const args = stringArray(value.args);
    if (typeof value.command !== 'string' || value.command.trim().length === 0 || args === null) {
      normalized.structuralErrors.push(`${event} contains an invalid command handler.`);
      return;
    }
    normalized.commands.push({ command: value.command, args });
  } else if (value.type === 'http') {
    if (typeof value.url !== 'string' || value.url.trim().length === 0) {
      normalized.structuralErrors.push(`${event} contains an HTTP handler without a URL.`);
      return;
    }
  } else if (value.type === 'mcp_tool') {
    if (
      typeof value.server !== 'string' ||
      value.server.trim().length === 0 ||
      typeof value.tool !== 'string' ||
      value.tool.trim().length === 0
    ) {
      normalized.structuralErrors.push(`${event} contains an MCP handler without server/tool.`);
      return;
    }
  } else if (typeof value.prompt !== 'string' || value.prompt.trim().length === 0) {
    normalized.structuralErrors.push(`${event} contains a ${value.type} handler without a prompt.`);
    return;
  }

  normalized.handlerCount += 1;
}

function normalizeClaude(artifact: HarnessArtifact, content: string): NormalizedHooks | null {
  const parsed = safeJsonParse(content);
  if (parsed === null || typeof parsed !== 'object') return null;
  const settings = parsed as Record<string, unknown>;
  const hooks = settings.hooks;
  const hasHooksObject = hooks !== null && typeof hooks === 'object' && !Array.isArray(hooks);
  const events = hasHooksObject ? Object.keys(hooks as Record<string, unknown>) : [];
  const normalized: NormalizedHooks = {
    ...baseNormalized(artifact, 'claude-code'),
    hasHooksObject,
    hasVersion: true,
    events,
    gateEvents: events.filter((event) => CLAUDE_GATE_EVENTS.has(event)),
    feedbackEvents: events.filter((event) => CLAUDE_FEEDBACK_EVENTS.has(event)),
    eventWarnings: unknownEventWarnings(artifact.path, events, CLAUDE_KNOWN_EVENTS),
  };

  if (!hasHooksObject) {
    normalized.structuralErrors.push('hooks must be an object.');
    return normalized;
  }

  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (event.length === 0) normalized.structuralErrors.push('Hook event names must not be empty.');
    if (!Array.isArray(groups) || groups.length === 0) {
      normalized.structuralErrors.push(`${event || '<empty>'} matcher groups must be a non-empty array.`);
      continue;
    }
    for (const group of groups) {
      if (!group || typeof group !== 'object' || Array.isArray(group)) {
        normalized.structuralErrors.push(`${event || '<empty>'} contains a non-object matcher group.`);
        continue;
      }
      const handlers = (group as Record<string, unknown>).hooks;
      if (!Array.isArray(handlers) || handlers.length === 0) {
        normalized.structuralErrors.push(
          `${event || '<empty>'} matcher group must contain a non-empty hooks array.`,
        );
        continue;
      }
      for (const handler of handlers) {
        if (!handler || typeof handler !== 'object' || Array.isArray(handler)) {
          normalized.structuralErrors.push(`${event || '<empty>'} contains a non-object handler.`);
          continue;
        }
        validateClaudeHandler(event || '<empty>', handler as Record<string, unknown>, normalized);
      }
    }
  }
  return normalized;
}

function normalizeArtifact(artifact: HarnessArtifact, content: string): NormalizedHooks | null {
  if (artifact.toolId === 'cursor') return normalizeCursor(artifact, content);
  if (artifact.toolId === 'claude-code') return normalizeClaude(artifact, content);
  return null;
}

function unusableArtifact(artifact: HarnessArtifact, problem: string): NormalizedHooks {
  const toolId = artifact.toolId === 'cursor' ? 'cursor' : 'claude-code';
  return {
    ...baseNormalized(artifact, toolId),
    hasHooksObject: false,
    hasVersion: false,
    events: [],
    gateEvents: [],
    feedbackEvents: [],
    structuralErrors: [problem],
  };
}

function isValidCandidate(candidate: NormalizedHooks): boolean {
  return (
    candidate.hasHooksObject &&
    candidate.hasVersion &&
    candidate.events.length > 0 &&
    candidate.structuralErrors.length === 0
  );
}

/** Select the closest non-empty valid hook configuration with deterministic tie-breakers. */
export function readNormalizedHooks(ctx: ScanContext): NormalizedHooks | null {
  const candidates: NormalizedHooks[] = [];
  const selectionWarnings: ScanDiagnostic[] = [];
  for (const artifact of collectHookConfigs(ctx)) {
    const content = ctx.read(artifact.path);
    if (content === null) {
      candidates.push(unusableArtifact(artifact, 'Hook configuration could not be read.'));
      continue;
    }
    const normalized = normalizeArtifact(artifact, content);
    if (!normalized) {
      candidates.push(unusableArtifact(artifact, 'Hook configuration is not valid JSON.'));
      continue;
    }
    candidates.push(normalized);
  }
  if (candidates.length === 0) return null;

  const validWithEvents = candidates.filter(isValidCandidate);
  const withEvents = candidates.filter((candidate) => candidate.events.length > 0);
  const pool = validWithEvents.length > 0 ? validWithEvents : withEvents.length > 0 ? withEvents : candidates;
  pool.sort(
    (a, b) =>
      a.nativeDepth - b.nativeDepth ||
      b.events.length - a.events.length ||
      a.canonicalSource.localeCompare(b.canonicalSource),
  );
  const best = pool[0]!;
  for (const candidate of candidates) {
    if (candidate === best) continue;
    selectionWarnings.push({
      code: 'ignored-hook-config',
      source: candidate.source,
      message: !isValidCandidate(candidate)
        ? `Invalid or empty hook configuration was ignored in favor of ${best.source}.`
        : `Hook configuration was not selected; ${best.source} has higher precedence.`,
    });
  }
  if (!isValidCandidate(best)) {
    selectionWarnings.push({
      code: 'invalid-hook-config',
      source: best.source,
      message: `No valid hook configuration was available: ${best.structuralErrors.join(' ') || 'the configuration is empty or missing required metadata.'}`,
    });
  }
  selectionWarnings.sort(
    (a, b) => (a.source ?? '').localeCompare(b.source ?? '') || a.code.localeCompare(b.code),
  );
  return { ...best, selectionWarnings };
}

function shellTokens(value: string): string[] {
  return value.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
}

function invocationTokens(invocation: HookCommandInvocation): string[] {
  if (invocation.args.length === 0) return shellTokens(invocation.command);
  return [invocation.command, ...invocation.args.flatMap(shellTokens)];
}

function pathValue(token: string): string {
  const unquoted = token.replace(/^["']|["']$/g, '');
  const assignment = unquoted.match(/^--?[^=]+=([\s\S]+)$/);
  return (assignment?.[1] ?? unquoted).replace(/^["']|["']$/g, '').replace(/[,;]$/, '');
}

function isRepositoryPath(token: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) return false;
  if (/^[A-Za-z]:\//.test(token) || token.startsWith('/')) return false;
  if (/^\$\{(?!CLAUDE_PROJECT_DIR\})[^}]+\}\//.test(token)) return false;
  if (/^\$(?!CLAUDE_PROJECT_DIR\/)[A-Za-z_][A-Za-z0-9_]*\//.test(token)) return false;
  return (
    token.startsWith('./') ||
    token.startsWith('../') ||
    token.startsWith('${CLAUDE_PROJECT_DIR}/') ||
    token.startsWith('$CLAUDE_PROJECT_DIR/') ||
    token.includes('/')
  );
}

function resolvesPathToken(token: string, ctx: ScanContext): boolean | null {
  const value = pathValue(token).replace(/\\/g, '/');
  if (!isRepositoryPath(value)) return null;
  const normalized = value.replace(/^\.\//, '');
  const stripped = normalized
    .replace(/^\$\{CLAUDE_PROJECT_DIR\}\//, '')
    .replace(/^\$CLAUDE_PROJECT_DIR\//, '')
    .replace(/^\.\//, '');
  if (/(^|\/)node_modules\/\.bin\//.test(stripped)) return true;

  const candidates = new Set([normalized, stripped]);
  const rootName = path.basename(ctx.root);
  for (const candidate of [...candidates]) {
    if (candidate.startsWith(`${rootName}/`)) candidates.add(candidate.slice(rootName.length + 1));
  }
  return [...candidates].some((candidate) => ctx.has(candidate));
}

export function hookCommandPathsResolve(
  invocations: HookCommandInvocation[],
  ctx: ScanContext,
): { validated: number; missing: string[] } {
  const missing: string[] = [];
  let validated = 0;
  for (const invocation of invocations) {
    for (const token of invocationTokens(invocation)) {
      const resolved = resolvesPathToken(token, ctx);
      if (resolved === null) continue;
      validated += 1;
      if (!resolved) missing.push(pathValue(token));
    }
  }
  return { validated, missing };
}
