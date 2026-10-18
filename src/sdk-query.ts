/**
 * Small Pi Agent Runtime wrapper for host-side structured helper queries.
 *
 * These calls are deliberately isolated from the long-lived container runner:
 * they use an in-memory Pi session, no tools, and the same provider settings
 * that the settings UI already manages. Claude remains an Anthropic provider,
 * not a Claude Agent SDK runtime.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
} from '@earendil-works/pi-coding-agent';
import {
  getClaudeProviderConfig,
  writePiOpenAIOAuthFile,
} from './runtime-config.js';
import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

function splitModelRef(value: string): { providerId: string; modelId: string } {
  const slash = value.indexOf('/');
  return slash > 0
    ? { providerId: value.slice(0, slash), modelId: value.slice(slash + 1) }
    : { providerId: 'anthropic', modelId: value };
}

function registerDynamicOpenAIModel(runtime: ModelRuntime, modelId: string): void {
  runtime.registerProvider('openai', {
    name: 'OpenAI Responses',
    baseUrl: 'https://api.openai.com/v1',
    api: 'openai-responses',
    models: [
      {
        id: modelId,
        name: modelId,
        api: 'openai-responses',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 400_000,
        maxTokens: 128_000,
        thinkingLevelMap: {
          off: 'none',
          minimal: null,
          low: 'low',
          medium: 'medium',
          high: 'high',
          xhigh: 'xhigh',
          max: 'max',
        },
        compat: {
          supportsStrictMode: true,
          supportsOpenAIGrammarTools: true,
        },
      },
    ],
  });
}

async function resolveModel(
  runtime: ModelRuntime,
  config: ReturnType<typeof getClaudeProviderConfig>,
  override?: string,
) {
  const modelRef = override?.trim() || config.anthropicModel.trim();
  if (config.modelProvider === 'openai-codex') {
    const modelId = modelRef.includes('/')
      ? modelRef.slice(modelRef.indexOf('/') + 1)
      : modelRef || 'gpt-6.1-sol';
    const model = runtime.getModel('openai', modelId);
    if (model) return model;
    registerDynamicOpenAIModel(runtime, modelId);
    return runtime.getModel('openai', modelId);
  }
  const custom = !!config.anthropicBaseUrl.trim();
  if (custom) {
    if (!modelRef) throw new Error('Custom provider requires a model');
    const split = splitModelRef(modelRef);
    const providerId = `miniclaw-${split.providerId}`;
    runtime.registerProvider(providerId, {
      name: `FrClaw ${split.providerId} compatible provider`,
      baseUrl: config.anthropicBaseUrl.trim(),
      api: 'anthropic-messages',
      ...(config.anthropicApiKey || config.anthropicAuthToken
        ? { apiKey: config.anthropicApiKey || config.anthropicAuthToken }
        : {}),
      models: [
        {
          id: split.modelId,
          name: split.modelId,
          api: 'anthropic-messages',
          reasoning: true,
          input: ['text', 'image'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200_000,
          maxTokens: 32_000,
        },
      ],
    });
    return runtime.getModel(providerId, split.modelId);
  }

  if (config.anthropicApiKey || config.anthropicAuthToken) {
    await runtime.setRuntimeApiKey(
      'anthropic',
      config.anthropicApiKey || config.anthropicAuthToken,
    );
  }
  if (!modelRef) return runtime.getModels('anthropic')[0];
  const split = splitModelRef(modelRef);
  return runtime.getModel(split.providerId, split.modelId);
}

function textFromMessage(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (item): item is { type: 'text'; text: string } =>
        !!item &&
        typeof item === 'object' &&
        (item as { type?: unknown }).type === 'text' &&
        typeof (item as { text?: unknown }).text === 'string',
    )
    .map((item) => item.text)
    .join('');
}

/** Send a no-tools prompt through Pi and return its plain-text answer. */
export async function sdkQuery(
  prompt: string,
  opts?: { model?: string; timeout?: number },
): Promise<string | null> {
  const timeout = opts?.timeout ?? 60_000;
  const config = getClaudeProviderConfig();
  const agentDir = path.join(DATA_DIR, 'config', 'pi-agent');
  fs.mkdirSync(agentDir, { recursive: true });
  const abortController = new AbortController();
  let activeSession: { abort: () => Promise<void> } | undefined;
  const timer = setTimeout(() => {
    abortController.abort();
    void activeSession?.abort();
  }, timeout);

  try {
    if (config.modelProvider === 'openai-codex') {
      writePiOpenAIOAuthFile(agentDir, config);
    }
    const modelRuntime = await ModelRuntime.create({
      authPath: path.join(agentDir, 'auth.json'),
      modelsPath: path.join(agentDir, 'models.json'),
      refreshOnCreate: false,
    });
    if (config.modelProvider === 'openai-codex') {
      const accessToken = config.openaiOAuthCredentials?.accessToken;
      if (!accessToken) {
        throw new Error('ChatGPT OAuth 凭据不可用，请重新登录');
      }
      await modelRuntime.setRuntimeApiKey('openai', accessToken);
    }
    const model = await resolveModel(modelRuntime, config, opts?.model);
    if (!model) throw new Error('Pi could not resolve the configured model');

    const settingsManager = SettingsManager.create(process.cwd(), agentDir, {
      projectTrusted: true,
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir,
      settingsManager,
      systemPrompt: '',
    });
    await resourceLoader.reload({ resolveProjectTrust: async () => true });
    const { session } = await createAgentSession({
      cwd: process.cwd(),
      agentDir,
      modelRuntime,
      model,
      noTools: 'all',
      resourceLoader,
      sessionManager: SessionManager.inMemory(process.cwd()),
      settingsManager,
    });
    activeSession = session;

    let text = '';
    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      if (event.type === 'message_update') {
        const update = event.assistantMessageEvent;
        if (update.type === 'text_delta') text += update.delta;
      }
      if (event.type === 'agent_end') {
        const assistant = [...event.messages]
          .reverse()
          .find((message) => message.role === 'assistant');
        const finalText = textFromMessage(assistant);
        if (finalText) text = finalText;
      }
    });
    try {
      await session.prompt(prompt);
    } finally {
      unsubscribe();
      session.dispose();
      activeSession = undefined;
    }
    return text.trim() || null;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message?.slice(0, 200) },
      'Pi helper query failed',
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}
