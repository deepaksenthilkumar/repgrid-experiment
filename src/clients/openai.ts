/**
 * OpenAI API Client with Logging
 * Implements LLMClient interface for OpenAI models (GPT-4o, etc.)
 */

import OpenAI from 'openai';
import type { ExperimentLogger } from '../services/logger.js';
import type { LLMClient, LLMClientConfig, LLMOptions, LLMResponse } from './llmClient.js';
import type { APICallLog } from '../core/types.js';
import { extractJSON } from './jsonExtract.js';

export interface OpenAIClientConfig {
  apiKey?: string;
  apiKeyEnvVar?: string;
  baseUrl?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  providerName?: string;
  defaultHeaders?: Record<string, string>;
}

const DEFAULT_CONFIG = {
  model: 'gpt-5.2',
  temperature: 0.0,
  maxTokens: 1024,
};

/**
 * Extract a detailed error message from an OpenAI SDK error, including
 * HTTP status, error code, and the upstream response body when available.
 */
function formatAPIError(error: unknown, provider: string, model: string): string {
  if (error instanceof OpenAI.APIError) {
    const parts = [
      `[${provider}] API error for model ${model}:`,
      `status=${error.status}`,
      error.code ? `code=${error.code}` : null,
      error.type ? `type=${error.type}` : null,
      `message=${error.message}`,
    ].filter(Boolean);
    return parts.join(' ');
  }
  if (error instanceof Error) {
    return `[${provider}] ${error.name}: ${error.message}`;
  }
  return `[${provider}] Unknown error: ${String(error)}`;
}

export class OpenAIClient implements LLMClient {
  private client: OpenAI;
  private config: LLMClientConfig;
  private logger: ExperimentLogger | null = null;
  private providerName: string;
  private baseUrl?: string;

  constructor(config: OpenAIClientConfig = {}) {
    const envVar = config.apiKeyEnvVar || 'OPENAI_API_KEY';
    const apiKey = config.apiKey || process.env[envVar];
    if (!apiKey) {
      throw new Error(`${envVar} is required. Set it in .env or pass to constructor.`);
    }

    const clientOptions: ConstructorParameters<typeof OpenAI>[0] = { apiKey };
    if (config.baseUrl) {
      clientOptions.baseURL = config.baseUrl;
    }
    if (config.defaultHeaders) {
      clientOptions.defaultHeaders = config.defaultHeaders;
    }

    this.client = new OpenAI(clientOptions);
    this.providerName = config.providerName || 'openai';
    this.baseUrl = config.baseUrl;
    this.config = {
      model: config.model || DEFAULT_CONFIG.model,
      temperature: config.temperature ?? DEFAULT_CONFIG.temperature,
      maxTokens: config.maxTokens || DEFAULT_CONFIG.maxTokens,
    };

    console.log(`[${this.providerName}] Client initialized: model=${this.config.model}${this.baseUrl ? ` baseUrl=${clientOptions.baseURL}` : ''}`);
  }

  setLogger(logger: ExperimentLogger): void {
    this.logger = logger;
  }

  getConfig(): LLMClientConfig {
    return { ...this.config };
  }

  getProvider(): string {
    return this.providerName;
  }

  async sendMessage(
    userPrompt: string,
    options: LLMOptions = {}
  ): Promise<LLMResponse> {
    const startTime = Date.now();

    const model = options.model || this.config.model;
    const temperature = options.temperature ?? this.config.temperature;
    const maxTokens = options.maxTokens || this.config.maxTokens;

    const messages: OpenAI.ChatCompletionMessageParam[] = [];
    if (options.systemPrompt) {
      messages.push({ role: 'system', content: options.systemPrompt });
    }
    messages.push({ role: 'user', content: userPrompt });

    try {
      const response = await this.client.chat.completions.create({
        model,
        max_tokens: maxTokens,
        temperature,
        messages,
      });

      const latencyMs = Date.now() - startTime;
      const choice = response.choices[0];
      const content = choice?.message?.content || '';

      const result: LLMResponse = {
        content,
        usage: {
          inputTokens: response.usage?.prompt_tokens || 0,
          outputTokens: response.usage?.completion_tokens || 0,
        },
        stopReason: choice?.finish_reason || 'unknown',
        model: response.model,
      };

      if (this.logger) {
        const callId = await this.logger.logAPICall({
          service: this.providerName as APICallLog['service'],
          endpoint: 'chat.completions.create',
          model: response.model,
          request: {
            systemPrompt: options.systemPrompt,
            userPrompt,
            temperature,
            maxTokens,
          },
          response: {
            content: result.content,
            usage: result.usage,
            stopReason: result.stopReason,
          },
          latencyMs,
          metadata: {
            phase: options.metadata?.phase || 'unknown',
            iteration: options.metadata?.iteration || 0,
            persona: options.metadata?.persona || 'unknown',
            phrasing: options.metadata?.phrasing || 'unknown',
            triadElements: options.metadata?.triadElements,
            purpose: options.metadata?.purpose || 'other',
          },
        });
        result.callId = callId;
      }

      return result;
    } catch (error) {
      const latencyMs = Date.now() - startTime;
      const errorDetail = formatAPIError(error, this.providerName, model);
      console.error(errorDetail);

      if (this.logger) {
        await this.logger.logAPICall({
          service: this.providerName as APICallLog['service'],
          endpoint: 'chat.completions.create',
          model,
          request: {
            systemPrompt: options.systemPrompt,
            userPrompt,
            temperature,
            maxTokens,
          },
          response: {
            content: `ERROR: ${errorDetail}`,
            usage: { inputTokens: 0, outputTokens: 0 },
            stopReason: 'error',
          },
          latencyMs,
          metadata: {
            phase: options.metadata?.phase || 'unknown',
            iteration: options.metadata?.iteration || 0,
            persona: options.metadata?.persona || 'unknown',
            phrasing: options.metadata?.phrasing || 'unknown',
            triadElements: options.metadata?.triadElements,
            purpose: options.metadata?.purpose || 'other',
          },
        });
      }

      if (error instanceof Error) {
        throw error;
      }
      throw new Error(`Unknown ${this.providerName} error`);
    }
  }

  async sendMessageForJSON<T>(
    userPrompt: string,
    options: LLMOptions = {}
  ): Promise<{ data: T; response: LLMResponse }> {
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const finalPrompt = attempt > 0
        ? userPrompt + '\n\nIMPORTANT: You MUST respond with ONLY a valid JSON object. No commentary, no explanation, no preamble.'
        : userPrompt;

      const response = await this.sendMessageWithJsonFormat(finalPrompt, options);

      try {
        const data = extractJSON<T>(response.content);
        return { data, response };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        console.error(
          `[${this.providerName}] JSON extraction failed (attempt ${attempt + 1}/${maxRetries}):\n` +
          `  Error: ${lastError.message.slice(0, 200)}\n` +
          `  Response content (first 500 chars): ${response.content.slice(0, 500)}`
        );
      }
    }

    throw lastError || new Error(`Failed to get valid JSON from ${this.providerName}`);
  }

  /**
   * Send a message with response_format set to json_object when supported.
   */
  private async sendMessageWithJsonFormat(
    userPrompt: string,
    options: LLMOptions = {}
  ): Promise<LLMResponse> {
    const startTime = Date.now();

    const model = options.model || this.config.model;
    const temperature = options.temperature ?? this.config.temperature;
    const maxTokens = options.maxTokens || this.config.maxTokens;

    const messages: OpenAI.ChatCompletionMessageParam[] = [];
    if (options.systemPrompt) {
      messages.push({ role: 'system', content: options.systemPrompt });
    }
    messages.push({ role: 'user', content: userPrompt });

    try {
      // Try with json_object response_format first, fall back for providers
      // that don't support it (DeepSeek R1, etc.)
      let response;

      try {
        response = await this.client.chat.completions.create({
          model,
          max_tokens: maxTokens,
          temperature,
          messages,
          response_format: { type: 'json_object' },
        });
      } catch (formatError) {
        const isUnsupportedParam =
          formatError instanceof OpenAI.APIError &&
          (formatError.status === 400 || formatError.status === 422);
        if (!isUnsupportedParam) {
          throw formatError;
        }
        console.log(`[${this.providerName}] response_format: json_object not supported (${formatError.status}), falling back to plain completion`);
        response = await this.client.chat.completions.create({
          model,
          max_tokens: maxTokens,
          temperature,
          messages,
        });
      }

      const latencyMs = Date.now() - startTime;
      const choice = response.choices[0];
      const content = choice?.message?.content || '';

      const result: LLMResponse = {
        content,
        usage: {
          inputTokens: response.usage?.prompt_tokens || 0,
          outputTokens: response.usage?.completion_tokens || 0,
        },
        stopReason: choice?.finish_reason || 'unknown',
        model: response.model,
      };

      if (this.logger) {
        const callId = await this.logger.logAPICall({
          service: this.providerName as APICallLog['service'],
          endpoint: 'chat.completions.create',
          model: response.model,
          request: {
            systemPrompt: options.systemPrompt,
            userPrompt,
            temperature,
            maxTokens,
          },
          response: {
            content: result.content,
            usage: result.usage,
            stopReason: result.stopReason,
          },
          latencyMs,
          metadata: {
            phase: options.metadata?.phase || 'unknown',
            iteration: options.metadata?.iteration || 0,
            persona: options.metadata?.persona || 'unknown',
            phrasing: options.metadata?.phrasing || 'unknown',
            triadElements: options.metadata?.triadElements,
            purpose: options.metadata?.purpose || 'other',
          },
        });
        result.callId = callId;
      }

      return result;
    } catch (error) {
      const latencyMs = Date.now() - startTime;
      const errorDetail = formatAPIError(error, this.providerName, model);
      console.error(errorDetail);

      if (this.logger) {
        await this.logger.logAPICall({
          service: this.providerName as APICallLog['service'],
          endpoint: 'chat.completions.create',
          model,
          request: {
            systemPrompt: options.systemPrompt,
            userPrompt,
            temperature,
            maxTokens,
          },
          response: {
            content: `ERROR: ${errorDetail}`,
            usage: { inputTokens: 0, outputTokens: 0 },
            stopReason: 'error',
          },
          latencyMs,
          metadata: {
            phase: options.metadata?.phase || 'unknown',
            iteration: options.metadata?.iteration || 0,
            persona: options.metadata?.persona || 'unknown',
            phrasing: options.metadata?.phrasing || 'unknown',
            triadElements: options.metadata?.triadElements,
            purpose: options.metadata?.purpose || 'other',
          },
        });
      }

      if (error instanceof Error) {
        throw error;
      }
      throw new Error(`Unknown ${this.providerName} error`);
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      console.log(`[${this.providerName}] Testing connection to ${this.config.model}...`);
      await this.sendMessage('Say "OK" and nothing else.', {
        maxTokens: 10,
        metadata: { phase: 'test', iteration: 0, persona: 'none', phrasing: 'none', purpose: 'other' },
      });
      // Also verify JSON format works (non-fatal warning if not)
      try {
        await this.sendMessageForJSON('Respond with: {"status":"ok"}', {
          maxTokens: 50,
          metadata: { phase: 'test', iteration: 0, persona: 'none', phrasing: 'none', purpose: 'other' },
        });
      } catch (jsonError) {
        console.warn(`[${this.providerName}] WARNING: JSON format test failed — experiment may have issues: ${formatAPIError(jsonError, this.providerName, this.config.model)}`);
      }
      console.log(`[${this.providerName}] Connection test passed`);
      return true;
    } catch (error) {
      console.error(`[${this.providerName}] Connection test FAILED: ${formatAPIError(error, this.providerName, this.config.model)}`);
      return false;
    }
  }
}
