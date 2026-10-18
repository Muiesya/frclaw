import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type {
  AgentRuntime,
  RuntimeSession,
  RuntimeSessionOptions,
} from '../types.js';
import { resolvePiProvider } from './pi-provider.js';
import { PiRuntimeSession } from './pi-session.js';

const require = createRequire(import.meta.url);

function existingPiSessionPath(
  sessionDir: string,
  sessionId: string,
): string | undefined {
  if (!sessionId || !fs.existsSync(sessionDir)) return undefined;
  const suffix = `_${sessionId}.jsonl`;
  const candidate = fs
    .readdirSync(sessionDir)
    .filter((name) => name.endsWith(suffix))
    .sort()
    .at(-1);
  return candidate ? path.join(sessionDir, candidate) : undefined;
}

function resolveSubagentsExtension(): string | undefined {
  try {
    const entry = require.resolve('@tintinweb/pi-subagents');
    return fs.existsSync(entry) ? entry : undefined;
  } catch {
    return undefined;
  }
}

async function refreshOpenAIOAuthIfNeeded(authPath: string): Promise<void> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fs.readFileSync(authPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return;
  }
  const raw = parsed.openai ?? parsed['openai-codex'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const credential = raw as Record<string, unknown>;
  if (
    credential.type !== 'oauth' ||
    typeof credential.access !== 'string' ||
    typeof credential.refresh !== 'string' ||
    typeof credential.expires !== 'number'
  ) {
    return;
  }
  if (credential.expires > Date.now() + 5 * 60 * 1000) return;
  const clientId =
    typeof credential.clientId === 'string' && credential.clientId
      ? credential.clientId
      : 'dynamic_agent_client';
  const response = await fetch(
    'https://auth.openai.com/api/accounts/oauth/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: credential.refresh,
        client_id: clientId,
        resource: 'https://api.openai.com/v1',
      }),
    },
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `ChatGPT OAuth token refresh failed (${response.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`,
    );
  }
  const data = (await response.json()) as Record<string, unknown>;
  if (
    typeof data.access_token !== 'string' ||
    typeof data.refresh_token !== 'string' ||
    typeof data.expires_in !== 'number'
  ) {
    throw new Error('ChatGPT OAuth refresh response is missing token fields');
  }
  const refreshed = {
    ...credential,
    access: data.access_token,
    refresh: data.refresh_token,
    expires: Date.now() + data.expires_in * 1000,
  };
  parsed.openai = refreshed;
  parsed['openai-codex'] = refreshed;
  const tmp = `${authPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(parsed, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
  fs.renameSync(tmp, authPath);
  try {
    fs.chmodSync(authPath, 0o600);
  } catch {
    /* best effort */
  }
}

function readOpenAIAccessToken(authPath: string): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(authPath, 'utf8')) as Record<
      string,
      Record<string, unknown>
    >;
    const credential = parsed.openai ?? parsed['openai-codex'];
    return credential?.type === 'oauth' && typeof credential.access === 'string'
      ? credential.access
      : undefined;
  } catch {
    return undefined;
  }
}

export class PiRuntimeAdapter implements AgentRuntime {
  readonly kind = 'pi' as const;

  async createSession(options: RuntimeSessionOptions): Promise<RuntimeSession> {
    const agentDir = path.join(options.sessionDir, '..', 'agent');
    fs.mkdirSync(options.sessionDir, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });

    const settingsManager = SettingsManager.create(options.cwd, agentDir, {
      projectTrusted: true,
    });
    // Product auto-compact toggle: OFF disables the runtime-native compaction;
    // ON (or unset) keeps Pi's native threshold-based compaction behavior.
    settingsManager.setCompactionEnabled(options.autoCompactEnabled !== false);
    await refreshOpenAIOAuthIfNeeded(path.join(agentDir, 'auth.json'));
    const openAIAccessToken =
      options.provider?.endpointKind === 'openai-codex'
        ? readOpenAIAccessToken(path.join(agentDir, 'auth.json'))
        : undefined;
    const modelRuntime = await ModelRuntime.create({
      authPath: path.join(agentDir, 'auth.json'),
      modelsPath: path.join(agentDir, 'models.json'),
      refreshOnCreate: false,
    });
    const modelResolution = await resolvePiProvider(modelRuntime, {
      model: options.model,
      endpointKind: options.provider?.endpointKind,
      baseUrl: options.provider?.baseUrl,
      ...(openAIAccessToken
        ? { apiKey: openAIAccessToken }
        : options.provider?.apiKey
          ? { apiKey: options.provider.apiKey }
          : {}),
    });

    const eventBus = createEventBus();
    const extensionPaths = [...(options.extensionPaths ?? [])];
    const subagentsExtension = resolveSubagentsExtension();
    if (subagentsExtension && !extensionPaths.includes(subagentsExtension)) {
      extensionPaths.push(subagentsExtension);
    }
    let resourceLoader = new DefaultResourceLoader({
      cwd: options.cwd,
      agentDir,
      settingsManager,
      eventBus,
      systemPrompt: options.systemPrompt,
      additionalSkillPaths: options.skillPaths,
      additionalExtensionPaths: extensionPaths,
    });
    try {
      await resourceLoader.reload({ resolveProjectTrust: async () => true });
    } catch (error) {
      // Pi remains usable when an optional extension is missing, malformed, or
      // incompatible. Do not silently downgrade to Claude; retrying without
      // only the optional subagent extension keeps the selected runtime
      // explicit and lets the regular tools fail visibly if requested.
      if (!subagentsExtension || !extensionPaths.includes(subagentsExtension)) {
        throw error;
      }
      const withoutSubagents = extensionPaths.filter(
        (entry) => entry !== subagentsExtension,
      );
      resourceLoader = new DefaultResourceLoader({
        cwd: options.cwd,
        agentDir,
        settingsManager,
        eventBus,
        systemPrompt: options.systemPrompt,
        additionalSkillPaths: options.skillPaths,
        additionalExtensionPaths: withoutSubagents,
      });
      await resourceLoader.reload({ resolveProjectTrust: async () => true });
    }

    const sessionFile = existingPiSessionPath(
      options.sessionDir,
      options.sessionId || '',
    );
    const sessionManager = sessionFile
      ? SessionManager.open(sessionFile, options.sessionDir, options.cwd)
      : SessionManager.create(options.cwd, options.sessionDir, {
          ...(options.sessionId ? { id: options.sessionId } : {}),
        });
    const customTools = (options.customTools ?? []) as ToolDefinition[];
    const toolAliases: Record<string, string> = {
      Bash: 'bash',
      Read: 'read',
      Write: 'write',
      Edit: 'edit',
      Glob: 'find',
      Grep: 'grep',
      Task: 'Agent',
      TaskOutput: 'get_subagent_result',
      TaskStop: 'steer_subagent',
    };
    const allowedNames = options.allowedTools ?? [];
    const selectedTools = options.allowedTools
      ? [
          ...new Set(
            allowedNames.flatMap((name) => {
              if (name === 'mcp__miniclaw__*') {
                return customTools.map((tool) => tool.name);
              }
              return [toolAliases[name] || name];
            }),
          ),
        ].filter(
          (name) =>
            ['read', 'bash', 'edit', 'write', 'find', 'grep', 'ls'].includes(
              name,
            ) ||
            customTools.some((tool) => tool.name === name) ||
            ['Agent', 'get_subagent_result', 'steer_subagent'].includes(name),
        )
      : undefined;
    const excludedTools = options.excludedTools?.map(
      (name) => toolAliases[name] || name,
    );

    const { session } = await createAgentSession({
      cwd: options.cwd,
      agentDir,
      modelRuntime,
      model: modelResolution.model,
      thinkingLevel:
        options.thinkingLevel === 'off' ? 'minimal' : options.thinkingLevel,
      ...(selectedTools ? { tools: selectedTools } : {}),
      ...(excludedTools ? { excludeTools: excludedTools } : {}),
      customTools,
      resourceLoader,
      sessionManager,
      settingsManager,
    });
    return new PiRuntimeSession(session, eventBus);
  }
}
