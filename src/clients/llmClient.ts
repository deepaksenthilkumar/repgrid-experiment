/**
 * Abstract LLM Client Interface
 * All LLM providers (Anthropic, OpenAI, Ollama) implement this interface
 */

import type { ExperimentLogger } from '../services/logger.js';
import type { APICallMetadata } from '../core/types.js';

export interface LLMClientConfig {
  model: string;
  temperature: number;
  maxTokens: number;
}

export interface LLMOptions {
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  model?: string;
  metadata?: Partial<APICallMetadata>;
}

export interface LLMResponse {
  content: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  stopReason: string;
  model: string;
  callId?: string;
}

export interface LLMClient {
  sendMessage(userPrompt: string, options?: LLMOptions): Promise<LLMResponse>;
  sendMessageForJSON<T>(userPrompt: string, options?: LLMOptions): Promise<{ data: T; response: LLMResponse }>;
  getConfig(): LLMClientConfig;
  setLogger(logger: ExperimentLogger): void;
  testConnection(): Promise<boolean>;
  getProvider(): string;
}
