/**
 * API Service for RepGrid Dashboard
 */

const API_BASE = import.meta.env.VITE_API_URL || '/api';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'researcher';
  createdAt: string;
}

export interface Experiment {
  id: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  startTime: string;
  endTime?: string;
  model?: string;
  category?: string;
  hasRerun?: boolean;
  rerunModels?: string[];
}

export interface ExperimentManifest {
  id: string;
  startTime: string;
  endTime?: string;
  status: string;
  config: {
    model: string;
    category?: string;
    elements: string[];
    iterations: number;
    phrasings: string[];
    personas: string[];
    temperature: number;
    maxTokens: number;
  };
  embeddingConfig: {
    model: string;
    clusterThreshold: number;
  };
  decisions: Record<string, { value: string; reason: string; timestamp: string }>;
  summary?: {
    totalGrids: number;
    totalApiCalls: number;
    totalTokensUsed: { input: number; output: number };
  };
}

export interface GridLog {
  gridId: string;
  experimentId: string;
  timestamp: string;
  conditions: {
    phase: string;
    iteration: number;
    persona: string;
    phrasing: string;
  };
  constructs: Array<{
    id: string;
    emergentPole: string;
    contrastPole: string;
    explanation: string;
    ratings: Record<string, number>;
    triad: [string, string, string];
  }>;
}

export interface APICallLog {
  timestamp: string;
  callId: string;
  service: string;
  endpoint: string;
  model: string;
  latencyMs: number;
  request: {
    systemPrompt?: string;
    userPrompt: string;
    temperature?: number;
    maxTokens?: number;
  };
  response: {
    content: string | object;
    usage: { inputTokens: number; outputTokens: number };
    stopReason: string;
  };
  metadata: {
    phase: string;
    iteration: number;
    persona: string;
    phrasing: string;
    triadElements?: [string, string, string];
    purpose?: string;
  };
}

export interface ElementConfig {
  id: string;
  label: string;
  description: string;
  pilot: boolean;
  dimensions?: string[];
}

export interface ConfigData {
  elements: Record<string, ElementConfig>;
  prompts: Record<string, unknown>;
}

class APIService {
  private token: string | null = null;

  setToken(token: string | null): void {
    this.token = token;
  }

  getToken(): string | null {
    return this.token;
  }

  async fetch<T>(path: string, options?: RequestInit): Promise<T> {
    const headers: Record<string, string> = {
      ...options?.headers as Record<string, string>,
    };

    // Only set Content-Type for requests with a body — sending it on
    // bodiless requests (DELETE, GET) causes Fastify to try parsing an
    // empty body as JSON, resulting in 400 Bad Request.
    if (options?.body) {
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    }

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    return response.json();
  }

  async login(email: string, password: string): Promise<{ token: string; user: AuthUser }> {
    const result = await this.fetch<{ token: string; user: AuthUser }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    this.token = result.token;
    return result;
  }

  async register(email: string, password: string, name: string): Promise<{ token: string; user: AuthUser }> {
    const result = await this.fetch<{ token: string; user: AuthUser }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, name }),
    });
    this.token = result.token;
    return result;
  }

  async listUsers(): Promise<{ users: AuthUser[] }> {
    return this.fetch('/auth/users');
  }

  async registerUser(email: string, password: string, name: string, role?: 'admin' | 'researcher'): Promise<{ user: AuthUser }> {
    return this.fetch('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, name, role }),
    });
  }

  async getCurrentUser(): Promise<AuthUser | null> {
    if (!this.token) return null;
    try {
      const result = await this.fetch<{ user: AuthUser }>('/auth/me');
      return result.user;
    } catch {
      this.token = null;
      return null;
    }
  }

  logout(): void {
    this.token = null;
  }

  async healthCheck(): Promise<{ status: string; timestamp: string }> {
    return this.fetch('/health');
  }

  async listExperiments(): Promise<{ experiments: Experiment[] }> {
    return this.fetch('/experiments');
  }

  async startExperiment(options: {
    pilot?: boolean;
    model?: string;
    category?: string;
    apiDelaySeconds?: number;
  } = {}): Promise<{
    experimentId: string;
    status: string;
    outputDir: string;
    model: string;
  }> {
    return this.fetch('/experiment/run', {
      method: 'POST',
      body: JSON.stringify(options),
    });
  }

  async rerunExperiment(experimentId: string): Promise<{
    experimentId: string;
    status: string;
    originalModel: string;
    rerunModel: string;
  }> {
    return this.fetch(`/experiment/${experimentId}/rerun`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  async deleteExperiment(experimentId: string): Promise<void> {
    await this.fetch(`/experiments/${experimentId}`, { method: 'DELETE' });
  }

  async getExperimentStatus(experimentId: string): Promise<{
    experimentId: string;
    status: string;
    error?: string;
    startTime?: string;
    endTime?: string;
  }> {
    return this.fetch(`/experiment/status/${experimentId}`);
  }

  async getExperimentResults(experimentId: string): Promise<{
    manifest: ExperimentManifest;
    summary: unknown;
    analysis: unknown;
  }> {
    return this.fetch(`/results/${experimentId}`);
  }

  async getExperimentGrids(
    experimentId: string,
    filters?: { phase?: string; persona?: string; phrasing?: string }
  ): Promise<{ grids: GridLog[]; count: number }> {
    const params = new URLSearchParams();
    if (filters?.phase) params.set('phase', filters.phase);
    if (filters?.persona) params.set('persona', filters.persona);
    if (filters?.phrasing) params.set('phrasing', filters.phrasing);

    const query = params.toString() ? `?${params.toString()}` : '';
    return this.fetch(`/results/${experimentId}/grids${query}`);
  }

  async getExperimentLogs(
    experimentId: string,
    options?: { limit?: number; offset?: number }
  ): Promise<{ logs: APICallLog[]; total: number; offset: number; limit: number }> {
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.offset) params.set('offset', String(options.offset));

    const query = params.toString() ? `?${params.toString()}` : '';
    return this.fetch(`/results/${experimentId}/logs${query}`);
  }

  async getConfig(): Promise<Record<string, string>> {
    return this.fetch('/config');
  }

  async getAnalysis(experimentId: string): Promise<{
    dimensionality?: DimensionalityAnalysis;
    cross_model_comparison?: CrossModelComparison;
    stability_metrics?: Record<string, unknown>;
  }> {
    return this.fetch(`/results/${experimentId}/analysis`);
  }

  async getDimensionalityAnalysis(experimentId: string): Promise<DimensionalityAnalysis> {
    return this.fetch(`/results/${experimentId}/analysis/dimensionality`);
  }

  async getCrossModelComparison(experimentId: string): Promise<CrossModelComparison> {
    return this.fetch(`/results/${experimentId}/analysis/cross-model`);
  }
}

export interface DimensionalityResult {
  model: string;
  totalConstructs: number;
  uniqueDimensions: number;
  saturationCurve: number[];
  clusterSizes: number[];
  averageIntraClusterSimilarity: number;
  topDimensions: Array<{
    exemplar: string;
    size: number;
    members: string[];
  }>;
}

export interface DimensionalityAnalysis {
  original: DimensionalityResult;
  rerun: DimensionalityResult;
}

export interface StabilityMetric {
  metric: string;
  original: number;
  rerun: number;
  difference: number;
  interpretation: string;
}

export interface CrossModelComparison {
  originalModel: string;
  rerunModel: string;
  originalDimensionality: DimensionalityResult;
  rerunDimensionality: DimensionalityResult;
  sharedDimensions: number;
  originalOnly: number;
  rerunOnly: number;
  overlapRatio: number;
  saturationCurves: {
    original: number[];
    rerun: number[];
  };
  stabilityMetrics: StabilityMetric[];
  summary: {
    dimensionalityDifference: number;
    avgSaturationRateOriginal: number;
    avgSaturationRateRerun: number;
    constructConvergence: number;
  };
}

// Helper to parse YAML elements from config
export function parseElementsFromYaml(yamlContent: string): Record<string, ElementConfig> {
  const elements: Record<string, ElementConfig> = {};

  // Simple YAML parsing for elements
  const lines = yamlContent.split('\n');
  let currentId = '';
  let currentElement: Partial<ElementConfig> = {};

  for (const line of lines) {
    const idMatch = line.match(/^\s{2}(E\d{2}):/);
    if (idMatch) {
      if (currentId && currentElement.label) {
        elements[currentId] = { id: currentId, ...currentElement } as ElementConfig;
      }
      currentId = idMatch[1];
      currentElement = {};
      continue;
    }

    const labelMatch = line.match(/^\s{4}label:\s*"(.+)"/);
    if (labelMatch) {
      currentElement.label = labelMatch[1];
      continue;
    }

    const descMatch = line.match(/^\s{4}description:\s*"(.+)"/);
    if (descMatch) {
      currentElement.description = descMatch[1];
      continue;
    }

    const pilotMatch = line.match(/^\s{4}pilot:\s*(true|false)/);
    if (pilotMatch) {
      currentElement.pilot = pilotMatch[1] === 'true';
      continue;
    }
  }

  // Don't forget the last element
  if (currentId && currentElement.label) {
    elements[currentId] = { id: currentId, ...currentElement } as ElementConfig;
  }

  return elements;
}

export const api = new APIService();
