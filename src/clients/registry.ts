/**
 * Model Registry
 * Factory for creating LLM clients from configuration
 */

import type { LLMClient } from './llmClient.js';
import { ClaudeClient } from './anthropic.js';
import { OpenAIClient } from './openai.js';
import { OllamaClient } from './ollama.js';
import { GeminiClient } from './gemini.js';

export interface ModelRegistryEntry {
  provider: 'anthropic' | 'openai' | 'ollama' | 'gemini' | 'deepseek' | 'openrouter';
  model: string;
  temperature?: number;
  maxTokens?: number;
  baseUrl?: string;
}

export class ModelRegistry {
  private entries: Record<string, ModelRegistryEntry>;

  constructor(entries: Record<string, ModelRegistryEntry> = {}) {
    this.entries = { ...DEFAULT_REGISTRY, ...entries };
  }

  /**
   * Create an LLM client for the given model key
   */
  createClient(modelKey: string): LLMClient {
    const entry = this.entries[modelKey];
    if (!entry) {
      throw new Error(
        `Unknown model key: '${modelKey}'. Available: ${this.getAvailableKeys().join(', ')}`
      );
    }

    switch (entry.provider) {
      case 'anthropic':
        return new ClaudeClient({
          model: entry.model,
          temperature: entry.temperature,
          maxTokens: entry.maxTokens,
        });

      case 'openai':
        return new OpenAIClient({
          model: entry.model,
          temperature: entry.temperature,
          maxTokens: entry.maxTokens,
        });

      case 'gemini':
        return new GeminiClient({
          model: entry.model,
          temperature: entry.temperature,
          maxTokens: entry.maxTokens,
        });

      case 'deepseek':
        return new OpenAIClient({
          model: entry.model,
          temperature: entry.temperature,
          maxTokens: entry.maxTokens,
          baseUrl: 'https://api.deepseek.com/v1',
          apiKeyEnvVar: 'DEEPSEEK_API_KEY',
          providerName: 'deepseek',
        });

      case 'openrouter': {
        const headers: Record<string, string> = {};
        if (process.env.OPENROUTER_REFERER) {
          headers['HTTP-Referer'] = process.env.OPENROUTER_REFERER;
        }
        if (process.env.OPENROUTER_TITLE) {
          headers['X-Title'] = process.env.OPENROUTER_TITLE;
        }
        return new OpenAIClient({
          model: entry.model,
          temperature: entry.temperature,
          maxTokens: entry.maxTokens,
          baseUrl: 'https://openrouter.ai/api/v1',
          apiKeyEnvVar: 'OPENROUTER_API_KEY',
          providerName: 'openrouter',
          defaultHeaders: Object.keys(headers).length > 0 ? headers : undefined,
        });
      }

      case 'ollama':
        return new OllamaClient({
          model: entry.model,
          temperature: entry.temperature,
          maxTokens: entry.maxTokens,
          baseUrl: entry.baseUrl,
        });

      default:
        throw new Error(`Unknown provider: '${entry.provider}' for model '${modelKey}'`);
    }
  }

  /**
   * Get all available model keys
   */
  getAvailableKeys(): string[] {
    return Object.keys(this.entries);
  }

  /**
   * Get registry entry for a model key
   */
  getEntry(modelKey: string): ModelRegistryEntry | undefined {
    return this.entries[modelKey];
  }

  /**
   * Check if a model key requires a specific API key
   */
  validateApiKey(modelKey: string): boolean {
    const entry = this.entries[modelKey];
    if (!entry) return false;

    switch (entry.provider) {
      case 'anthropic':
        return !!process.env.ANTHROPIC_API_KEY;
      case 'openai':
        return !!process.env.OPENAI_API_KEY;
      case 'gemini':
        return !!process.env.GOOGLE_API_KEY;
      case 'deepseek':
        return !!process.env.DEEPSEEK_API_KEY;
      case 'openrouter':
        return !!process.env.OPENROUTER_API_KEY;
      case 'ollama':
        return true; // No API key needed
      default:
        return false;
    }
  }

  /**
   * Map legacy model choices to registry keys
   */
  static resolveLegacyKey(key: string): string {
    const legacyMap: Record<string, string> = {
      'haiku': 'claude-haiku',
      'sonnet': 'claude-sonnet',
      'gpt-4o': 'gpt-5',
      'gpt-4o-mini': 'gpt-4.1',
      'llama-3': 'llama-4',
      'gemini-2.0-flash': 'gemini-2.5-flash',
    };
    return legacyMap[key] || key;
  }
}

const DEFAULT_REGISTRY: Record<string, ModelRegistryEntry> = {
  'claude-haiku': {
    provider: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    temperature: 0.0,
    maxTokens: 1024,
  },
  'claude-sonnet': {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
    temperature: 0.0,
    maxTokens: 1024,
  },
  'claude-opus': {
    provider: 'anthropic',
    model: 'claude-opus-4-6',
    temperature: 0.0,
    maxTokens: 1024,
  },
  'gpt-5': {
    provider: 'openai',
    model: 'gpt-5.2',
    temperature: 0.0,
    maxTokens: 1024,
  },
  'gpt-4.1': {
    provider: 'openai',
    model: 'gpt-4.1',
    temperature: 0.0,
    maxTokens: 1024,
  },
  'o3': {
    provider: 'openai',
    model: 'o3',
    temperature: 0.0,
    maxTokens: 1024,
  },
  'gemini-2.5-pro': {
    provider: 'gemini',
    model: 'gemini-2.5-pro',
    temperature: 0.0,
    maxTokens: 8192,
  },
  'gemini-2.5-flash': {
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    temperature: 0.0,
    maxTokens: 8192,
  },
  'deepseek-v3': {
    provider: 'deepseek',
    model: 'deepseek-chat',
    temperature: 0.0,
    maxTokens: 1024,
  },
  'deepseek-r1': {
    provider: 'deepseek',
    model: 'deepseek-reasoner',
    temperature: 0.0,
    maxTokens: 1024,
  },
  'deepseek-v3-openrouter': {
    provider: 'openrouter',
    model: 'deepseek/deepseek-chat',
    temperature: 0.0,
    maxTokens: 1024,
  },
  'deepseek-r1-openrouter': {
    provider: 'openrouter',
    model: 'deepseek/deepseek-reasoner',
    temperature: 0.0,
    maxTokens: 1024,
  },
  'llama-4': {
    provider: 'ollama',
    model: 'llama4:scout',
    temperature: 0.0,
    maxTokens: 1024,
    baseUrl: 'http://localhost:11434',
  },
  'deepseek': {
    provider: 'ollama',
    model: 'deepseek-v3.2',
    temperature: 0.0,
    maxTokens: 1024,
    baseUrl: 'http://localhost:11434',
  },
  'gpt-oss': {
    provider: 'ollama',
    model: 'gpt-oss-120b',
    temperature: 0.0,
    maxTokens: 1024,
    baseUrl: 'http://localhost:11434',
  },
};
