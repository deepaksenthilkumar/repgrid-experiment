/**
 * Core type definitions for the RepGrid experiment
 */

// Element types
export interface Element {
  id: string;
  label: string;
  description: string;
  pilot: boolean;
  dimensions?: string[];
}

export interface ElementPhrasing {
  neutral: string;
  dysphemistic: string;
  euphemistic?: string;
}

// Construct types
export interface Construct {
  id: string;
  emergentPole: string;
  contrastPole: string;
  similarPair: [string, string];
  explanation: string;
  ratings: Record<string, number>;
  sourceTriad: [string, string, string];
  embedding?: number[];
  naElements?: string[];  // Elements where model responded N/A (midpoint-substituted in ratings)
}

// Grid types
export interface Grid {
  id: string;
  experimentId: string;
  model: string;
  persona: string;
  phrasing: 'neutral' | 'dysphemistic' | 'euphemistic';
  framing?: string;
  constructs: Construct[];
  timestamp: string;
  metadata: GridMetadata;
}

export interface GridMetadata {
  phase: string;
  iteration: number;
  condition: string;
  domain?: string;
}

// Persona types
export interface Persona {
  id: string;
  label: string;
  description: string;
  pilot: boolean;
  systemPrompt: string;
}

// Experiment manifest
export interface ExperimentManifest {
  id: string;
  startTime: string;
  endTime?: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  config: ExperimentConfig;
  embeddingConfig: EmbeddingConfig;
  decisions: Record<string, DecisionLog>;
  summary?: ExperimentSummary;
}

export interface ExperimentConfig {
  model: string;
  modelVersion?: string;
  category?: string;
  elements: string[];
  iterations: number;
  phrasings: string[];
  personas: string[];
  temperature: number;
  maxTokens: number;
}

export interface EmbeddingConfig {
  model: string;
  clusterThreshold: number;
}

export interface DecisionLog {
  value: string;
  reason: string;
  timestamp: string;
}

export interface ExperimentSummary {
  totalGrids: number;
  totalApiCalls: number;
  totalTokensUsed: {
    input: number;
    output: number;
  };
  phases: Record<string, PhaseSummary>;
}

export interface PhaseSummary {
  gridsGenerated: number;
  constructsElicited: number;
  metrics: Record<string, number>;
}

// API call logging
export interface APICallLog {
  timestamp: string;
  callId: string;
  service: 'anthropic' | 'voyage' | 'openai' | 'ollama' | 'gemini' | 'deepseek' | 'openrouter';
  endpoint: string;
  model: string;
  request: APIRequest;
  response: APIResponse;
  latencyMs: number;
  metadata: APICallMetadata;
}

export interface APIRequest {
  systemPrompt?: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
}

export interface APIResponse {
  content: string | object;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  stopReason: string;
}

export interface APICallMetadata {
  phase: string;
  iteration: number;
  persona: string;
  phrasing: string;
  triadElements?: [string, string, string];
  purpose: 'elicitation' | 'rating' | 'embedding' | 'other';
}

// Grid logging (detailed)
export interface GridLog {
  gridId: string;
  experimentId: string;
  timestamp: string;
  conditions: {
    phase: string;
    iteration: number;
    persona: string;
    phrasing: string;
    framing?: string;
  };
  constructs: ConstructLog[];
}

export interface ConstructLog {
  id: string;
  elicitationCallId: string;
  ratingCallId: string;
  triad: [string, string, string];
  emergentPole: string;
  contrastPole: string;
  similarPair: [string, string];
  explanation: string;
  ratings: Record<string, number>;
  embedding?: number[];
  naElements?: string[];  // Elements where model responded N/A
}

// Analysis types
export interface ConstructCluster {
  clusterId: string;
  constructs: Array<{
    constructId: string;
    gridId: string;
    emergentPole: string;
    contrastPole: string;
  }>;
  centroidEmbedding: number[];
  intraClusterSimilarity: number;
}

export interface ConsensusGrid {
  id: string;
  experimentId: string;
  condition: string;
  sourceGridIds: string[];
  clusters: ConstructCluster[];
  elementPositions: Record<string, number[]>;
}

// Metrics
export interface StabilityMetrics {
  baselineCosineSimilarity: number;
  synonymVarianceRatio?: number;
  personaDisplacementScore?: number;
  procrustesResidual: number;
  normalizedProcrustesResidual?: number;
  stabilityScore?: number;
  naRate?: number;  // Proportion of N/A responses across all ratings
  confidence: {
    lower: number;
    upper: number;
  };
}

export interface PhaseMetrics {
  phase: string;
  condition: string;
  metrics: StabilityMetrics;
  rawData: {
    pairwiseSimilarities: number[];
    elementDistances: Record<string, number>;
  };
}

// Experiment results
export interface ExperimentResults {
  experimentId: string;
  manifest: ExperimentManifest;
  grids: Grid[];
  analysis: {
    constructClusters: ConstructCluster[];
    consensusGrids: Record<string, ConsensusGrid>;
    phaseMetrics: PhaseMetrics[];
  };
  summary: {
    overallStability: 'stable' | 'unstable' | 'fragile';
    recommendations: string[];
  };
}

// Consolidated results for downstream LLM analysis
export interface ConsolidatedResults {
  experimentId: string;
  timestamp: {
    start: string;
    end: string;
    durationMs: number;
  };
  config: ExperimentConfig;
  summary: {
    totalGrids: number;
    totalConstructs: number;
    totalApiCalls: number;
    tokenUsage: { input: number; output: number; total: number };
    estimatedCost: number;
    phases: Record<string, {
      gridCount: number;
      constructCount: number;
      conditions: { persona: string; phrasing: string }[];
    }>;
  };
  grids: GridLog[];
  constructs: Array<{
    id: string;
    gridId: string;
    phase: string;
    iteration: number;
    persona: string;
    phrasing: string;
    emergentPole: string;
    contrastPole: string;
    explanation: string;
    triad: [string, string, string];
    ratings: Record<string, number>;
    embedding?: number[];
  }>;
  apiStats: {
    anthropic: { calls: number; avgLatencyMs: number; totalTokens: number };
    voyage: { calls: number; avgLatencyMs: number; totalTokens: number };
  };
  decisions: Record<string, { value: string; reason: string; timestamp: string }>;
}
