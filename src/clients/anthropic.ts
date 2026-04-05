/**
 * Anthropic Claude API Client with Logging
 * Wraps the Anthropic SDK with comprehensive logging for reproducibility
 */

import Anthropic from '@anthropic-ai/sdk';
import type { ExperimentLogger } from '../services/logger.js';
import type { APICallMetadata } from '../core/types.js';
import type { LLMClient, LLMClientConfig, LLMOptions, LLMResponse } from './llmClient.js';
import { extractJSON } from './jsonExtract.js';

export interface ClaudeClientConfig {
  apiKey?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string;
}

export type ClaudeResponse = LLMResponse;

const DEFAULT_CONFIG: Required<Omit<ClaudeClientConfig, 'apiKey'>> = {
  model: 'claude-haiku-4-5-20251001',
  temperature: 0.0,
  maxTokens: 1024,
};

/**
 * Claude 4.6 models do not support assistant prefill (returns 400).
 * Detect these models so we can use prompt-based JSON forcing instead.
 */
function isPrefillSupported(model: string): boolean {
  // 4.6 models: claude-opus-4-6, claude-sonnet-4-6 (with or without date suffix)
  return !model.includes('4-6');
}

export class ClaudeClient implements LLMClient {
  private client: Anthropic;
  private config: Required<Omit<ClaudeClientConfig, 'apiKey'>>;
  private logger: ExperimentLogger | null = null;

  constructor(config: ClaudeClientConfig = {}) {
    const apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY is required. Set it in .env or pass to constructor.');
    }

    this.client = new Anthropic({ apiKey });
    this.config = {
      model: config.model || DEFAULT_CONFIG.model,
      temperature: config.temperature ?? DEFAULT_CONFIG.temperature,
      maxTokens: config.maxTokens || DEFAULT_CONFIG.maxTokens,
    };
  }

  /**
   * Attach a logger for API call logging
   */
  setLogger(logger: ExperimentLogger): void {
    this.logger = logger;
  }

  /**
   * Get current model configuration
   */
  getConfig(): LLMClientConfig {
    return { ...this.config };
  }

  /**
   * Get provider name
   */
  getProvider(): string {
    return 'anthropic';
  }

  /**
   * Send a message to Claude with optional system prompt
   */
  async sendMessage(
    userPrompt: string,
    options: LLMOptions = {}
  ): Promise<LLMResponse> {
    const startTime = Date.now();

    const model = options.model || this.config.model;
    const temperature = options.temperature ?? this.config.temperature;
    const maxTokens = options.maxTokens || this.config.maxTokens;

    try {
      const response = await this.client.messages.create({
        model,
        max_tokens: maxTokens,
        temperature,
        system: options.systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      });

      const latencyMs = Date.now() - startTime;

      // Extract text content
      const content =
        response.content[0].type === 'text' ? response.content[0].text : '';

      const result: LLMResponse = {
        content,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
        stopReason: response.stop_reason || 'unknown',
        model: response.model,
      };

      // Log if logger is attached
      if (this.logger) {
        const callId = await this.logger.logAPICall({
          service: 'anthropic',
          endpoint: 'messages.create',
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

      // Log error if logger is attached
      if (this.logger) {
        await this.logger.logAPICall({
          service: 'anthropic',
          endpoint: 'messages.create',
          model,
          request: {
            systemPrompt: options.systemPrompt,
            userPrompt,
            temperature,
            maxTokens,
          },
          response: {
            content: `ERROR: ${error instanceof Error ? error.message : 'Unknown error'}`,
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

      throw this.handleError(error);
    }
  }

  /**
   * Send a message expecting JSON response, using assistant prefill to force JSON output.
   * Retries up to 3 times on JSON extraction failure (e.g. safety refusals).
   */
  async sendMessageForJSON<T>(
    userPrompt: string,
    options: LLMOptions = {}
  ): Promise<{ data: T; response: LLMResponse }> {
    const maxRetries = 3;
    let lastError: Error | null = null;
    const model = options.model || this.config.model;
    const usePrefill = isPrefillSupported(model);

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      let response: LLMResponse;
      let fullContent: string;

      if (usePrefill) {
        response = await this.sendMessageWithPrefill(userPrompt, options, attempt > 0);
        // Prepend the prefilled '{' since the model continues from there
        fullContent = '{' + response.content;
      } else {
        // 4.6 models: no prefill, use prompt-based JSON instruction
        const jsonInstruction = '\n\nIMPORTANT: You MUST respond with ONLY a valid JSON object. No commentary, no explanation, no preamble. Start your response with { and end with }.';
        response = await this.sendMessage(
          userPrompt + jsonInstruction,
          options,
        );
        fullContent = response.content;
      }

      try {
        const data = extractJSON<T>(fullContent);
        return { data, response };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        console.warn(
          `[Anthropic] JSON extraction failed (attempt ${attempt + 1}/${maxRetries}): ${lastError.message.slice(0, 150)}`
        );
      }
    }

    throw lastError || new Error('Failed to get valid JSON from Anthropic');
  }

  /**
   * Send a message with assistant prefill to force JSON output.
   * On retry, appends an explicit JSON-only instruction to the user prompt.
   */
  private async sendMessageWithPrefill(
    userPrompt: string,
    options: LLMOptions = {},
    isRetry: boolean
  ): Promise<LLMResponse> {
    const startTime = Date.now();

    const model = options.model || this.config.model;
    const temperature = options.temperature ?? this.config.temperature;
    const maxTokens = options.maxTokens || this.config.maxTokens;

    const finalUserPrompt = isRetry
      ? userPrompt + '\n\nIMPORTANT: You MUST respond with ONLY a valid JSON object. No commentary, no explanation, no preamble. Start your response with { and end with }.'
      : userPrompt;

    try {
      const response = await this.client.messages.create({
        model,
        max_tokens: maxTokens,
        temperature,
        system: options.systemPrompt,
        messages: [
          { role: 'user', content: finalUserPrompt },
          { role: 'assistant', content: '{' },
        ],
      });

      const latencyMs = Date.now() - startTime;

      const content =
        response.content[0].type === 'text' ? response.content[0].text : '';

      const result: LLMResponse = {
        content,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
        stopReason: response.stop_reason || 'unknown',
        model: response.model,
      };

      if (this.logger) {
        const callId = await this.logger.logAPICall({
          service: 'anthropic',
          endpoint: 'messages.create',
          model: response.model,
          request: {
            systemPrompt: options.systemPrompt,
            userPrompt: finalUserPrompt,
            temperature,
            maxTokens,
          },
          response: {
            content: '{' + result.content,
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

      if (this.logger) {
        await this.logger.logAPICall({
          service: 'anthropic',
          endpoint: 'messages.create',
          model,
          request: {
            systemPrompt: options.systemPrompt,
            userPrompt: finalUserPrompt,
            temperature,
            maxTokens,
          },
          response: {
            content: `ERROR: ${error instanceof Error ? error.message : 'Unknown error'}`,
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

      throw this.handleError(error);
    }
  }

  /**
   * Handle API errors
   */
  private handleError(error: unknown): Error {
    if (error instanceof Anthropic.APIError) {
      const status = error.status;
      const message = error.message;

      if (status === 401) {
        return new Error(`Authentication failed. Check your ANTHROPIC_API_KEY. (${message})`);
      }
      if (status === 429) {
        return new Error(`Rate limit exceeded. Please wait and try again. (${message})`);
      }
      if (status === 500 || status === 529) {
        return new Error(`Anthropic service error. Try again later. (${message})`);
      }

      return new Error(`Anthropic API error (${status}): ${message}`);
    }

    if (error instanceof Error) {
      return error;
    }

    return new Error('Unknown error occurred');
  }

  /**
   * Test the connection
   */
  async testConnection(): Promise<boolean> {
    try {
      await this.sendMessage('Say "OK" and nothing else.', {
        maxTokens: 10,
        metadata: { phase: 'test', iteration: 0, persona: 'none', phrasing: 'none', purpose: 'other' },
      });
      return true;
    } catch {
      return false;
    }
  }
}
