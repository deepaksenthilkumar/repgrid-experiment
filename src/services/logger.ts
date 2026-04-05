/**
 * Experiment Logger Service
 * Handles all logging for reproducibility and external validation
 */

import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { StorageAdapter } from './storage.js';
import type {
  ExperimentManifest,
  APICallLog,
  GridLog,
  ExperimentConfig,
  EmbeddingConfig,
  DecisionLog,
  ConsolidatedResults,
} from '../core/types.js';

export class ExperimentLogger {
  private experimentId: string;
  private baseDir: string;
  private logDir: string;
  private gridsDir: string;
  private analysisDir: string;
  private apiLogPath: string;
  private manifest: ExperimentManifest;
  private initialized = false;
  private storage: StorageAdapter;

  constructor(storage: StorageAdapter, baseOutputDir: string = 'data/results') {
    this.storage = storage;
    this.experimentId = `repgrid-v2-${uuidv4()}`;
    this.baseDir = join(baseOutputDir, this.experimentId);
    this.logDir = join(this.baseDir, 'logs');
    this.gridsDir = join(this.baseDir, 'grids');
    this.analysisDir = join(this.baseDir, 'analysis');
    this.apiLogPath = join(this.logDir, 'api_calls.jsonl');

    // Initialize manifest with placeholder values
    this.manifest = {
      id: this.experimentId,
      startTime: new Date().toISOString(),
      status: 'running',
      config: {} as ExperimentConfig,
      embeddingConfig: {} as EmbeddingConfig,
      decisions: {},
    };
  }

  /**
   * Initialize the logger - must be called before logging
   */
  async initialize(config: ExperimentConfig, embeddingConfig: EmbeddingConfig): Promise<void> {
    // Create directory structure
    await this.storage.mkdir(this.baseDir);
    await this.storage.mkdir(this.logDir);
    await this.storage.mkdir(this.gridsDir);
    await this.storage.mkdir(this.analysisDir);

    // Update manifest with config
    this.manifest.config = config;
    this.manifest.embeddingConfig = embeddingConfig;

    // Write initial manifest
    await this.writeManifest();

    this.initialized = true;
    console.log(`[Logger] Initialized experiment: ${this.experimentId}`);
    console.log(`[Logger] Output directory: ${this.baseDir}`);
  }

  /**
   * Get the experiment ID
   */
  getExperimentId(): string {
    return this.experimentId;
  }

  /**
   * Get the base directory for this experiment
   */
  getBaseDir(): string {
    return this.baseDir;
  }

  /**
   * Log an API call
   */
  async logAPICall(call: Omit<APICallLog, 'timestamp' | 'callId'>): Promise<string> {
    if (!this.initialized) {
      throw new Error('Logger not initialized. Call initialize() first.');
    }

    const callId = uuidv4();
    const fullCall: APICallLog = {
      ...call,
      timestamp: new Date().toISOString(),
      callId,
    };

    // Append to JSONL file
    await this.storage.append(this.apiLogPath, JSON.stringify(fullCall) + '\n');

    // Log summary to console
    console.log(
      `[API] ${fullCall.service}/${fullCall.endpoint} | ` +
        `${fullCall.metadata.phase} iter=${fullCall.metadata.iteration} | ` +
        `${fullCall.latencyMs}ms | ` +
        `${fullCall.response.usage.inputTokens}/${fullCall.response.usage.outputTokens} tokens`
    );

    return callId;
  }

  /**
   * Log a grid
   */
  async logGrid(grid: GridLog): Promise<void> {
    if (!this.initialized) {
      throw new Error('Logger not initialized. Call initialize() first.');
    }

    const gridPath = join(this.gridsDir, `${grid.gridId}.json`);
    await this.storage.write(gridPath, JSON.stringify(grid, null, 2));

    console.log(
      `[Grid] Logged ${grid.gridId} | ` +
        `${grid.conditions.phase} iter=${grid.conditions.iteration} | ` +
        `${grid.constructs.length} constructs`
    );
  }

  /**
   * Log a decision made during the experiment
   */
  logDecision(key: string, value: string, reason: string): void {
    if (!this.initialized) {
      throw new Error('Logger not initialized. Call initialize() first.');
    }

    const decision: DecisionLog = {
      value,
      reason,
      timestamp: new Date().toISOString(),
    };

    this.manifest.decisions[key] = decision;

    console.log(`[Decision] ${key}: ${value} (${reason})`);
  }

  /**
   * Log analysis results
   */
  async logAnalysis(filename: string, data: unknown): Promise<void> {
    if (!this.initialized) {
      throw new Error('Logger not initialized. Call initialize() first.');
    }

    const analysisPath = join(this.analysisDir, filename);
    await this.storage.write(analysisPath, JSON.stringify(data, null, 2));

    console.log(`[Analysis] Logged ${filename}`);
  }

  /**
   * Update and write the manifest
   */
  private async writeManifest(): Promise<void> {
    const manifestPath = join(this.baseDir, 'manifest.json');
    await this.storage.write(manifestPath, JSON.stringify(this.manifest, null, 2));
  }

  /**
   * Finalize the experiment and write summary
   */
  async finalize(summary?: ExperimentManifest['summary']): Promise<void> {
    if (!this.initialized) {
      throw new Error('Logger not initialized. Call initialize() first.');
    }

    // Flush any buffered storage writes before finalizing
    await this.storage.flush();

    // Update manifest
    this.manifest.endTime = new Date().toISOString();
    this.manifest.status = 'completed';
    if (summary) {
      this.manifest.summary = summary;
    }

    // Write final manifest
    await this.writeManifest();

    // Write human-readable summary
    const summaryPath = join(this.baseDir, 'summary.json');
    await this.storage.write(
      summaryPath,
      JSON.stringify(
        {
          experimentId: this.experimentId,
          duration: this.calculateDuration(),
          config: this.manifest.config,
          summary: this.manifest.summary,
          decisions: this.manifest.decisions,
        },
        null,
        2
      )
    );

    // Generate consolidated results for downstream LLM analysis
    await this.generateConsolidatedResults();

    console.log(`[Logger] Experiment finalized: ${this.experimentId}`);
    console.log(`[Logger] Results saved to: ${this.baseDir}`);
  }

  /**
   * Mark the experiment as failed
   */
  async fail(error: Error): Promise<void> {
    await this.storage.flush();
    this.manifest.endTime = new Date().toISOString();
    this.manifest.status = 'failed';
    this.manifest.decisions['error'] = {
      value: error.message,
      reason: error.stack || 'Unknown error',
      timestamp: new Date().toISOString(),
    };

    await this.writeManifest();

    console.error(`[Logger] Experiment failed: ${error.message}`);
  }

  /**
   * Calculate experiment duration
   */
  private calculateDuration(): string {
    const start = new Date(this.manifest.startTime).getTime();
    const end = this.manifest.endTime
      ? new Date(this.manifest.endTime).getTime()
      : Date.now();
    const durationMs = end - start;
    const seconds = Math.floor(durationMs / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }

  /**
   * Estimate cost based on model pricing (per million tokens)
   */
  private estimateCost(inputTokens: number, outputTokens: number): number {
    // Pricing per million tokens: { input, output }
    const PRICING: Record<string, { input: number; output: number }> = {
      'claude-haiku-4-5': { input: 0.8, output: 4 },
      'claude-sonnet-4-5': { input: 3, output: 15 },
      'claude-opus-4': { input: 15, output: 75 },
      'gpt-5': { input: 2, output: 8 },
      'gpt-4.1': { input: 2, output: 8 },
      'o3': { input: 2, output: 8 },
      'gemini-2.5-pro': { input: 1.25, output: 10 },
      'gemini-2.5-flash': { input: 0.15, output: 0.6 },
      'deepseek-chat': { input: 0.27, output: 1.1 },
      'deepseek-reasoner': { input: 0.55, output: 2.19 },
    };

    const model = this.manifest.config.model || '';
    // Find first matching key in the pricing table
    const match = Object.entries(PRICING).find(([key]) => model.includes(key));
    if (!match) {
      console.warn(`[Logger] No pricing data for model "${model}", falling back to Haiku rates`);
    }
    const rates = match ? match[1] : { input: 0.8, output: 4 };
    return (inputTokens * rates.input + outputTokens * rates.output) / 1_000_000;
  }

  /**
   * Generate consolidated results file for downstream LLM analysis
   */
  private async generateConsolidatedResults(): Promise<void> {
    // 1. Read all grid files
    const gridFiles = await this.storage.list(this.gridsDir);
    const grids: GridLog[] = [];

    for (const file of gridFiles) {
      if (file.endsWith('.json')) {
        const content = await this.storage.read(join(this.gridsDir, file));
        grids.push(JSON.parse(content));
      }
    }

    // 2. Read API call logs
    let apiLogs: APICallLog[] = [];
    try {
      const logsContent = await this.storage.read(this.apiLogPath);
      apiLogs = logsContent
        .trim()
        .split('\n')
        .filter((line) => line)
        .map((line) => JSON.parse(line));
    } catch {
      // No logs file or empty
    }

    // 3. Calculate statistics by service
    const anthropicCalls = apiLogs.filter((l) => l.service === 'anthropic');
    const voyageCalls = apiLogs.filter((l) => l.service === 'voyage');

    // 4. Flatten constructs with full context
    const constructs = grids.flatMap((grid) =>
      grid.constructs.map((c) => ({
        id: c.id,
        gridId: grid.gridId,
        phase: grid.conditions.phase,
        iteration: grid.conditions.iteration,
        persona: grid.conditions.persona,
        phrasing: grid.conditions.phrasing,
        emergentPole: c.emergentPole,
        contrastPole: c.contrastPole,
        explanation: c.explanation,
        triad: c.triad,
        ratings: c.ratings,
        embedding: c.embedding,
      }))
    );

    // 5. Build phase summaries
    const phaseStats: Record<string, { gridCount: number; constructCount: number; conditions: { persona: string; phrasing: string }[] }> = {};
    for (const grid of grids) {
      const phase = grid.conditions.phase;
      if (!phaseStats[phase]) {
        phaseStats[phase] = { gridCount: 0, constructCount: 0, conditions: [] };
      }
      phaseStats[phase].gridCount++;
      phaseStats[phase].constructCount += grid.constructs.length;
      // Track unique conditions
      const condition = { persona: grid.conditions.persona, phrasing: grid.conditions.phrasing };
      if (!phaseStats[phase].conditions.some((c) => c.persona === condition.persona && c.phrasing === condition.phrasing)) {
        phaseStats[phase].conditions.push(condition);
      }
    }

    // 6. Calculate token totals
    const inputTokens = apiLogs.reduce((sum, l) => sum + (l.response?.usage?.inputTokens || 0), 0);
    const outputTokens = apiLogs.reduce((sum, l) => sum + (l.response?.usage?.outputTokens || 0), 0);

    // 7. Calculate duration
    const startTime = new Date(this.manifest.startTime).getTime();
    const endTime = this.manifest.endTime ? new Date(this.manifest.endTime).getTime() : Date.now();

    // 8. Build consolidated result
    const consolidated: ConsolidatedResults = {
      experimentId: this.experimentId,
      timestamp: {
        start: this.manifest.startTime,
        end: this.manifest.endTime || new Date().toISOString(),
        durationMs: endTime - startTime,
      },
      config: this.manifest.config,
      summary: {
        totalGrids: grids.length,
        totalConstructs: constructs.length,
        totalApiCalls: apiLogs.length,
        tokenUsage: { input: inputTokens, output: outputTokens, total: inputTokens + outputTokens },
        estimatedCost: this.estimateCost(inputTokens, outputTokens),
        phases: phaseStats,
      },
      grids,
      constructs,
      apiStats: {
        anthropic: {
          calls: anthropicCalls.length,
          avgLatencyMs: anthropicCalls.length > 0
            ? anthropicCalls.reduce((s, l) => s + l.latencyMs, 0) / anthropicCalls.length
            : 0,
          totalTokens: anthropicCalls.reduce(
            (s, l) => s + (l.response?.usage?.inputTokens || 0) + (l.response?.usage?.outputTokens || 0),
            0
          ),
        },
        voyage: {
          calls: voyageCalls.length,
          avgLatencyMs: voyageCalls.length > 0
            ? voyageCalls.reduce((s, l) => s + l.latencyMs, 0) / voyageCalls.length
            : 0,
          totalTokens: voyageCalls.reduce((s, l) => s + ((l.response?.usage as any)?.totalTokens || 0), 0),
        },
      },
      decisions: this.manifest.decisions,
    };

    // 9. Write consolidated file
    const consolidatedPath = join(this.baseDir, 'consolidated_results.json');
    await this.storage.write(consolidatedPath, JSON.stringify(consolidated, null, 2));

    console.log(`[Logger] Consolidated results written to: ${consolidatedPath}`);
  }

  /**
   * Load a previous experiment's manifest
   */
  static async loadManifest(storage: StorageAdapter, experimentDir: string): Promise<ExperimentManifest> {
    const manifestPath = join(experimentDir, 'manifest.json');
    const content = await storage.read(manifestPath);
    return JSON.parse(content);
  }

  /**
   * Load API call logs from an experiment
   */
  static async loadAPILogs(storage: StorageAdapter, experimentDir: string): Promise<APICallLog[]> {
    const logPath = join(experimentDir, 'logs', 'api_calls.jsonl');
    const content = await storage.read(logPath);
    return content
      .trim()
      .split('\n')
      .filter((line) => line)
      .map((line) => JSON.parse(line));
  }

  /**
   * Load a grid from an experiment
   */
  static async loadGrid(storage: StorageAdapter, experimentDir: string, gridId: string): Promise<GridLog> {
    const gridPath = join(experimentDir, 'grids', `${gridId}.json`);
    const content = await storage.read(gridPath);
    return JSON.parse(content);
  }
}
