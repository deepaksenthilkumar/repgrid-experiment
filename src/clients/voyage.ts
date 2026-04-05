/**
 * Voyage AI Embeddings Client with Logging
 * Wraps the Voyage AI SDK for construct embedding
 */

import type { ExperimentLogger } from '../services/logger.js';

export interface VoyageClientConfig {
  apiKey?: string;
  model?: string;
}

export interface EmbeddingResult {
  embeddings: number[][];
  usage: {
    totalTokens: number;
  };
  model: string;
}

const DEFAULT_CONFIG = {
  model: 'voyage-3',
};

export class VoyageClient {
  private apiKey: string;
  private model: string;
  private logger: ExperimentLogger | null = null;
  private baseUrl = 'https://api.voyageai.com/v1';

  constructor(config: VoyageClientConfig = {}) {
    const apiKey = config.apiKey || process.env.VOYAGE_API_KEY;
    if (!apiKey) {
      throw new Error('VOYAGE_API_KEY is required. Set it in .env or pass to constructor.');
    }

    this.apiKey = apiKey;
    this.model = config.model || DEFAULT_CONFIG.model;
  }

  /**
   * Attach a logger for API call logging
   */
  setLogger(logger: ExperimentLogger): void {
    this.logger = logger;
  }

  /**
   * Get current model
   */
  getModel(): string {
    return this.model;
  }

  /**
   * Embed an array of texts
   */
  async embed(
    texts: string[],
    options: {
      model?: string;
      inputType?: 'query' | 'document';
      metadata?: {
        phase: string;
        iteration: number;
      };
    } = {}
  ): Promise<EmbeddingResult> {
    const startTime = Date.now();
    const model = options.model || this.model;

    try {
      const response = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          input: texts,
          model,
          input_type: options.inputType || 'document',
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Voyage API error (${response.status}): ${errorBody}`);
      }

      const data = (await response.json()) as {
        data: Array<{ embedding: number[]; index: number }>;
        usage: { total_tokens: number };
        model: string;
      };

      const latencyMs = Date.now() - startTime;

      // Sort by index to ensure correct order
      const sortedEmbeddings = data.data
        .sort((a, b) => a.index - b.index)
        .map((item) => item.embedding);

      const result: EmbeddingResult = {
        embeddings: sortedEmbeddings,
        usage: {
          totalTokens: data.usage.total_tokens,
        },
        model: data.model,
      };

      // Log if logger is attached
      if (this.logger) {
        await this.logger.logAPICall({
          service: 'voyage',
          endpoint: 'embeddings',
          model: result.model,
          request: {
            userPrompt: `[${texts.length} texts to embed]`,
            maxTokens: 0,
          },
          response: {
            content: `[${sortedEmbeddings.length} embeddings of dimension ${sortedEmbeddings[0]?.length || 0}]`,
            usage: {
              inputTokens: result.usage.totalTokens,
              outputTokens: 0,
            },
            stopReason: 'complete',
          },
          latencyMs,
          metadata: {
            phase: options.metadata?.phase || 'embedding',
            iteration: options.metadata?.iteration || 0,
            persona: 'n/a',
            phrasing: 'n/a',
            purpose: 'embedding',
          },
        });
      }

      return result;
    } catch (error) {
      const latencyMs = Date.now() - startTime;

      // Log error if logger is attached
      if (this.logger) {
        await this.logger.logAPICall({
          service: 'voyage',
          endpoint: 'embeddings',
          model,
          request: {
            userPrompt: `[${texts.length} texts to embed]`,
            maxTokens: 0,
          },
          response: {
            content: `ERROR: ${error instanceof Error ? error.message : 'Unknown error'}`,
            usage: { inputTokens: 0, outputTokens: 0 },
            stopReason: 'error',
          },
          latencyMs,
          metadata: {
            phase: options.metadata?.phase || 'embedding',
            iteration: options.metadata?.iteration || 0,
            persona: 'n/a',
            phrasing: 'n/a',
            purpose: 'embedding',
          },
        });
      }

      throw error instanceof Error ? error : new Error('Unknown error');
    }
  }

  /**
   * Embed a single text
   */
  async embedOne(
    text: string,
    options: {
      model?: string;
      inputType?: 'query' | 'document';
      metadata?: {
        phase: string;
        iteration: number;
      };
    } = {}
  ): Promise<number[]> {
    const result = await this.embed([text], options);
    return result.embeddings[0];
  }

  /**
   * Calculate cosine similarity between two embeddings
   */
  static cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error('Embeddings must have same dimension');
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    if (denominator === 0) return 0;

    return dotProduct / denominator;
  }

  /**
   * Test the connection
   */
  async testConnection(): Promise<boolean> {
    try {
      await this.embedOne('Test connection');
      return true;
    } catch {
      return false;
    }
  }
}
