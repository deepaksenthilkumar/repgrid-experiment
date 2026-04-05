/**
 * Native Google Gemini API Client with Logging
 * Uses @google/genai SDK for proper JSON mode and thinking budget control
 */

import { GoogleGenAI } from '@google/genai';
import type { ExperimentLogger } from '../services/logger.js';
import type { LLMClient, LLMClientConfig, LLMOptions, LLMResponse } from './llmClient.js';
import type { APICallLog } from '../core/types.js';
import { extractJSON } from './jsonExtract.js';

export interface GeminiClientConfig {
  apiKey?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

const DEFAULT_CONFIG = {
  model: 'gemini-2.5-flash',
  temperature: 0.0,
  maxTokens: 8192,
};

export class GeminiClient implements LLMClient {
  private client: GoogleGenAI;
  private config: LLMClientConfig;
  private logger: ExperimentLogger | null = null;

  constructor(config: GeminiClientConfig = {}) {
    const apiKey = config.apiKey || process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      throw new Error('GOOGLE_API_KEY is required. Set it in .env or pass to constructor.');
    }

    this.client = new GoogleGenAI({ apiKey });
    this.config = {
      model: config.model || DEFAULT_CONFIG.model,
      temperature: config.temperature ?? DEFAULT_CONFIG.temperature,
      maxTokens: config.maxTokens || DEFAULT_CONFIG.maxTokens,
    };

    console.log(`[gemini] Client initialized: model=${this.config.model}`);
  }

  setLogger(logger: ExperimentLogger): void {
    this.logger = logger;
  }

  getConfig(): LLMClientConfig {
    return { ...this.config };
  }

  getProvider(): string {
    return 'gemini';
  }

  async sendMessage(
    userPrompt: string,
    options: LLMOptions = {}
  ): Promise<LLMResponse> {
    const startTime = Date.now();

    const model = options.model || this.config.model;
    const temperature = options.temperature ?? this.config.temperature;
    const maxTokens = options.maxTokens || this.config.maxTokens;

    try {
      const response = await this.client.models.generateContent({
        model,
        contents: userPrompt,
        config: {
          systemInstruction: options.systemPrompt,
          maxOutputTokens: maxTokens,
          temperature,
        },
      });

      const latencyMs = Date.now() - startTime;
      const content = response.text ?? '';

      const result: LLMResponse = {
        content,
        usage: {
          inputTokens: response.usageMetadata?.promptTokenCount || 0,
          outputTokens: response.usageMetadata?.candidatesTokenCount || 0,
        },
        stopReason: response.candidates?.[0]?.finishReason || 'unknown',
        model,
      };

      if (this.logger) {
        const callId = await this.logger.logAPICall({
          service: 'gemini' as APICallLog['service'],
          endpoint: 'models.generateContent',
          model,
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
      const errorDetail = formatGeminiError(error, model);
      console.error(errorDetail);

      if (this.logger) {
        await this.logger.logAPICall({
          service: 'gemini' as APICallLog['service'],
          endpoint: 'models.generateContent',
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
      throw new Error(`Unknown Gemini error: ${String(error)}`);
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

      const response = await this.sendMessageWithJsonMode(finalPrompt, options);

      try {
        const data = extractJSON<T>(response.content);
        return { data, response };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        console.error(
          `[gemini] JSON extraction failed (attempt ${attempt + 1}/${maxRetries}):\n` +
          `  Error: ${lastError.message.slice(0, 200)}\n` +
          `  Response content (first 500 chars): ${response.content.slice(0, 500)}`
        );
      }
    }

    throw lastError || new Error('Failed to get valid JSON from Gemini');
  }

  /**
   * Send a message with responseMimeType: application/json and thinking disabled.
   * Disabling thinking prevents the model from consuming output tokens on internal
   * reasoning, ensuring the full budget is available for the JSON response.
   */
  private async sendMessageWithJsonMode(
    userPrompt: string,
    options: LLMOptions = {}
  ): Promise<LLMResponse> {
    const startTime = Date.now();

    const model = options.model || this.config.model;
    const temperature = options.temperature ?? this.config.temperature;
    const maxTokens = options.maxTokens || this.config.maxTokens;

    try {
      const response = await this.client.models.generateContent({
        model,
        contents: userPrompt,
        config: {
          systemInstruction: options.systemPrompt,
          maxOutputTokens: maxTokens,
          temperature,
          responseMimeType: 'application/json',
          thinkingConfig: { thinkingBudget: 0 },
        },
      });

      const latencyMs = Date.now() - startTime;
      const content = response.text ?? '';

      const result: LLMResponse = {
        content,
        usage: {
          inputTokens: response.usageMetadata?.promptTokenCount || 0,
          outputTokens: response.usageMetadata?.candidatesTokenCount || 0,
        },
        stopReason: response.candidates?.[0]?.finishReason || 'unknown',
        model,
      };

      if (this.logger) {
        const callId = await this.logger.logAPICall({
          service: 'gemini' as APICallLog['service'],
          endpoint: 'models.generateContent',
          model,
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
      const errorDetail = formatGeminiError(error, model);
      console.error(errorDetail);

      if (this.logger) {
        await this.logger.logAPICall({
          service: 'gemini' as APICallLog['service'],
          endpoint: 'models.generateContent',
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
      throw new Error(`Unknown Gemini error: ${String(error)}`);
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      console.log(`[gemini] Testing connection to ${this.config.model}...`);
      await this.sendMessage('Say "OK" and nothing else.', {
        maxTokens: 50,
        metadata: { phase: 'test', iteration: 0, persona: 'none', phrasing: 'none', purpose: 'other' },
      });
      // Also verify JSON mode works
      try {
        await this.sendMessageForJSON('Respond with: {"status":"ok"}', {
          maxTokens: 50,
          metadata: { phase: 'test', iteration: 0, persona: 'none', phrasing: 'none', purpose: 'other' },
        });
      } catch (jsonError) {
        console.warn(`[gemini] WARNING: JSON mode test failed — experiment may have issues: ${formatGeminiError(jsonError, this.config.model)}`);
      }
      console.log(`[gemini] Connection test passed`);
      return true;
    } catch (error) {
      console.error(`[gemini] Connection test FAILED: ${formatGeminiError(error, this.config.model)}`);
      return false;
    }
  }
}

function formatGeminiError(error: unknown, model: string): string {
  if (error instanceof Error) {
    return `[gemini] ${error.name}: ${error.message} (model=${model})`;
  }
  return `[gemini] Unknown error: ${String(error)} (model=${model})`;
}
