/**
 * Ollama API Client with Logging
 * Implements LLMClient interface for local Ollama models (Llama, Mistral, etc.)
 * Uses fetch-based HTTP client - no extra dependencies required.
 */

import type { ExperimentLogger } from '../services/logger.js';
import type { LLMClient, LLMClientConfig, LLMOptions, LLMResponse } from './llmClient.js';
import { extractJSON } from './jsonExtract.js';

export interface OllamaClientConfig {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  baseUrl?: string;
}

const DEFAULT_CONFIG = {
  model: 'llama4:scout',
  temperature: 0.0,
  maxTokens: 1024,
  baseUrl: 'http://localhost:11434',
};

interface OllamaChatResponse {
  model: string;
  message: { role: string; content: string };
  done: boolean;
  total_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
}

export class OllamaClient implements LLMClient {
  private config: LLMClientConfig;
  private baseUrl: string;
  private logger: ExperimentLogger | null = null;

  constructor(config: OllamaClientConfig = {}) {
    this.baseUrl = config.baseUrl || DEFAULT_CONFIG.baseUrl;
    this.config = {
      model: config.model || DEFAULT_CONFIG.model,
      temperature: config.temperature ?? DEFAULT_CONFIG.temperature,
      maxTokens: config.maxTokens || DEFAULT_CONFIG.maxTokens,
    };
  }

  setLogger(logger: ExperimentLogger): void {
    this.logger = logger;
  }

  getConfig(): LLMClientConfig {
    return { ...this.config };
  }

  getProvider(): string {
    return 'ollama';
  }

  async sendMessage(
    userPrompt: string,
    options: LLMOptions = {}
  ): Promise<LLMResponse> {
    const startTime = Date.now();

    const model = options.model || this.config.model;
    const temperature = options.temperature ?? this.config.temperature;

    const messages: Array<{ role: string; content: string }> = [];
    if (options.systemPrompt) {
      messages.push({ role: 'system', content: options.systemPrompt });
    }
    messages.push({ role: 'user', content: userPrompt });

    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const response = await fetch(`${this.baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages,
            stream: false,
            options: {
              temperature,
              num_predict: options.maxTokens || this.config.maxTokens,
            },
          }),
        });

        if (!response.ok) {
          throw new Error(`Ollama HTTP ${response.status}: ${await response.text()}`);
        }

        const data = await response.json() as OllamaChatResponse;
        const latencyMs = Date.now() - startTime;

        const result: LLMResponse = {
          content: data.message.content,
          usage: {
            inputTokens: data.prompt_eval_count || 0,
            outputTokens: data.eval_count || 0,
          },
          stopReason: data.done ? 'end_turn' : 'unknown',
          model: data.model,
        };

        if (this.logger) {
          const callId = await this.logger.logAPICall({
            service: 'ollama',
            endpoint: 'api/chat',
            model: data.model,
            request: {
              systemPrompt: options.systemPrompt,
              userPrompt,
              temperature,
              maxTokens: options.maxTokens || this.config.maxTokens,
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
        lastError = error instanceof Error ? error : new Error('Unknown Ollama error');
        if (attempt < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        }
      }
    }

    const latencyMs = Date.now() - startTime;
    if (this.logger) {
      await this.logger.logAPICall({
        service: 'ollama',
        endpoint: 'api/chat',
        model,
        request: {
          systemPrompt: options.systemPrompt,
          userPrompt,
          temperature,
          maxTokens: options.maxTokens || this.config.maxTokens,
        },
        response: {
          content: `ERROR: ${lastError?.message || 'Unknown error'}`,
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

    throw lastError || new Error('Ollama request failed after retries');
  }

  async sendMessageForJSON<T>(
    userPrompt: string,
    options: LLMOptions = {}
  ): Promise<{ data: T; response: LLMResponse }> {
    // Ollama models may need extra retries for valid JSON
    const maxJSONRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxJSONRetries; attempt++) {
      const response = await this.sendMessage(userPrompt, options);

      try {
        const data = extractJSON<T>(response.content);
        return { data, response };
      } catch (error) {
        lastError = new Error(
          `Failed to extract/parse JSON (attempt ${attempt + 1}): ${error instanceof Error ? error.message : 'Unknown'}`
        );
      }
    }

    throw lastError || new Error('Failed to get valid JSON from Ollama');
  }

  async testConnection(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      return response.ok;
    } catch {
      return false;
    }
  }
}
