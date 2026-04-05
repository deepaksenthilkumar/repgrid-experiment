/**
 * Experiment Runner
 * Orchestrates the execution of all experimental phases
 */

import { join } from 'path';
import type { LLMClient } from '../clients/llmClient.js';
import { ModelRegistry } from '../clients/registry.js';
import { VoyageClient } from '../clients/voyage.js';
import { ExperimentLogger } from '../services/logger.js';
import { ConfigLoader } from '../services/config.js';
import { TriadicElicitor, diversifiedTriadSelection } from '../core/triadic.js';
import type { StorageAdapter } from '../services/storage.js';
import type { Element, Grid, GridLog, ExperimentConfig, EmbeddingConfig } from '../core/types.js';
import {
  estimateDimensionality,
  calculateSaturationCurve,
  type ConstructWithEmbedding,
} from '../analysis/dimensionality.js';
import { compareModels, generateComparisonSummary } from '../analysis/crossModel.js';
import { calculateRandomBaseline, interpretAgainstBaseline } from '../analysis/baseline.js';
import {
  calculatePhase0Metrics,
  calculatePhase1Metrics,
  calculatePhase2Metrics,
} from '../core/metrics.js';

export interface ExperimentRunnerConfig {
  configDir?: string;
  outputDir?: string;
  pilot?: boolean;
  model?: string;
  category?: string;
  storage?: StorageAdapter;
  apiDelaySeconds?: number;
}

export interface PhaseResult {
  phase: string;
  grids: Grid[];
  gridLogs: GridLog[];
  duration: number;
}

// Legacy type alias for backward compatibility
export type ModelChoice = 'claude-haiku' | 'claude-sonnet' | 'claude-opus' | 'gpt-5' | 'gpt-4.1' | 'o3' | 'llama-4' | 'deepseek' | 'gpt-oss';

export class ExperimentRunner {
  private configLoader: ConfigLoader;
  private llmClient!: LLMClient;
  private voyageClient: VoyageClient;
  private logger: ExperimentLogger;
  private elicitor!: TriadicElicitor;
  private initialized = false;
  private experimentConfig: ExperimentConfig | null = null;
  private selectedModel: string;
  private registry: ModelRegistry;
  private clusterThreshold: number = 0.8;
  private constructsPerGrid: number = 1;
  private category: string;
  private storage: StorageAdapter;
  private apiDelaySeconds: number;

  constructor(config: ExperimentRunnerConfig = {}) {
    if (!config.storage) {
      throw new Error('StorageAdapter is required. Pass storage in ExperimentRunnerConfig.');
    }
    this.storage = config.storage;
    this.category = config.category || 'ethics';
    this.configLoader = new ConfigLoader(config.configDir || 'config');
    // Resolve legacy keys (haiku -> claude-haiku, sonnet -> claude-sonnet)
    this.selectedModel = ModelRegistry.resolveLegacyKey(config.model || 'claude-haiku');
    this.registry = new ModelRegistry();
    this.apiDelaySeconds = config.apiDelaySeconds || 0;
    this.voyageClient = new VoyageClient();
    this.logger = new ExperimentLogger(this.storage, config.outputDir || 'data/results');
  }

  /**
   * Initialize the experiment
   */
  async initialize(pilot: boolean = true): Promise<string> {
    console.log('\n=== Initializing Experiment ===\n');

    // Load configuration
    await this.configLoader.loadAll();
    const expConfig = await this.configLoader.loadExperiment();

    // Load registry from config if available
    if (expConfig.models.registry) {
      this.registry = new ModelRegistry(expConfig.models.registry as any);
    }

    // Create LLM client from registry
    this.llmClient = this.registry.createClient(this.selectedModel);
    this.elicitor = new TriadicElicitor(
      this.llmClient,
      this.configLoader,
      diversifiedTriadSelection,
      this.apiDelaySeconds
    );

    // Get elements and personas for this run
    const elements = await this.configLoader.getElements(pilot);
    const personas = await this.configLoader.getPersonas(pilot);

    // Build experiment config
    const pilotConfig = pilot ? expConfig.pilot : expConfig.full;
    const modelConfig = this.llmClient.getConfig();
    this.experimentConfig = {
      model: modelConfig.model,
      category: this.category,
      elements: elements.map((e) => e.id),
      iterations: pilotConfig.iterations,
      phrasings: pilotConfig.phrasings,
      personas: pilotConfig.personas,
      temperature: modelConfig.temperature,
      maxTokens: modelConfig.maxTokens,
    };

    this.constructsPerGrid = pilotConfig.constructsPerGrid || 1;

    this.clusterThreshold = expConfig.embeddings.useCalibrated && expConfig.embeddings.calibratedThreshold
      ? expConfig.embeddings.calibratedThreshold
      : expConfig.embeddings.clusterThreshold;

    const embeddingConfig: EmbeddingConfig = {
      model: expConfig.embeddings.model,
      clusterThreshold: this.clusterThreshold,
    };

    // Initialize logger
    await this.logger.initialize(this.experimentConfig, embeddingConfig);

    // Attach logger to clients
    this.llmClient.setLogger(this.logger);
    this.voyageClient.setLogger(this.logger);

    // Log initialization decisions
    this.logger.logDecision('pilot_mode', String(pilot), 'User requested pilot experiment');
    this.logger.logDecision('model_selection', this.selectedModel, `Using ${modelConfig.model} via ${this.llmClient.getProvider()}`);
    this.logger.logDecision('element_count', String(elements.length), 'Elements loaded from config');
    this.logger.logDecision('iteration_count', String(pilotConfig.iterations), 'Iterations per condition');

    console.log(`Experiment ID: ${this.logger.getExperimentId()}`);
    console.log(`Model: ${modelConfig.model} (${this.llmClient.getProvider()})`);
    console.log(`Elements: ${elements.length}`);
    console.log(`Iterations: ${pilotConfig.iterations}`);
    console.log(`Constructs per grid: ${this.constructsPerGrid}`);
    console.log(`Phrasings: ${pilotConfig.phrasings.join(', ')}`);
    console.log(`Personas: ${pilotConfig.personas.join(', ')}`);
    if (this.apiDelaySeconds > 0) {
      console.log(`API delay: ${this.apiDelaySeconds}s between calls`);
    }
    console.log(`Output: ${this.logger.getBaseDir()}`);

    // Test connections
    console.log('\nTesting API connections...');
    const llmOk = await this.llmClient.testConnection();
    if (!llmOk) {
      throw new Error(`Failed to connect to ${this.llmClient.getProvider()} API for model ${modelConfig.model}. Check API key and model availability.`);
    }
    console.log(`  ${this.llmClient.getProvider()} API (${modelConfig.model}): OK`);

    const voyageOk = await this.voyageClient.testConnection();
    if (!voyageOk) {
      throw new Error('Failed to connect to Voyage API');
    }
    console.log('  Voyage API: OK');

    this.initialized = true;
    return this.logger.getExperimentId();
  }

  /**
   * Generate embeddings for all constructs in the given grids
   */
  private async embedConstructsForGrids(
    grids: Grid[],
    gridLogs: GridLog[],
    phase: string
  ): Promise<void> {
    const allConstructs = grids.flatMap((g) => g.constructs);
    if (allConstructs.length === 0) {
      console.log('  No constructs to embed');
      return;
    }

    console.log(`\n  Generating embeddings for ${allConstructs.length} constructs...`);

    const constructTexts = allConstructs.map(
      (c) => `${c.emergentPole} vs ${c.contrastPole}`
    );

    try {
      const result = await this.voyageClient.embed(constructTexts, {
        inputType: 'document',
        metadata: { phase, iteration: 0 },
      });

      allConstructs.forEach((construct, index) => {
        construct.embedding = result.embeddings[index];
      });

      for (const gridLog of gridLogs) {
        const grid = grids.find((g) => g.id === gridLog.gridId);
        if (grid) {
          gridLog.constructs.forEach((logConstruct, index) => {
            const gridConstruct = grid.constructs[index];
            if (gridConstruct?.embedding) {
              logConstruct.embedding = gridConstruct.embedding;
            }
          });
          await this.logger.logGrid(gridLog);
        }
      }

      this.logger.logDecision(
        `${phase}_embeddings_generated`,
        String(result.embeddings.length),
        `Generated Voyage AI embeddings for ${result.embeddings.length} constructs (${result.usage.totalTokens} tokens)`
      );

      console.log(`  Embeddings generated: ${result.embeddings.length} (dimension: ${result.embeddings[0]?.length || 0})`);
    } catch (error) {
      console.error('  Failed to generate embeddings:', error instanceof Error ? error.message : error);
      this.logger.logDecision(
        `${phase}_embeddings_failed`,
        'true',
        `Failed to generate embeddings: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Run random baseline after Phase 0
   */
  async runRandomBaseline(): Promise<void> {
    if (!this.experimentConfig) return;

    console.log('\n=== Running Random Baseline ===\n');

    const elements = this.experimentConfig.elements;
    const expConfig = await this.configLoader.loadExperiment();
    const iterations = expConfig.phases.phase0.iterations || this.experimentConfig.iterations;

    const baseline = calculateRandomBaseline(elements, 100, iterations, 1);

    // Save baseline
    const analysisPath = join(this.logger.getBaseDir(), 'analysis', 'random_baseline.json');
    await this.storage.write(analysisPath, JSON.stringify(baseline, null, 2));

    this.logger.logDecision(
      'random_baseline_computed',
      `residual_median=${baseline.residual.percentile50.toFixed(4)}`,
      `Random baseline: 5th=${baseline.residual.percentile5.toFixed(4)}, 50th=${baseline.residual.percentile50.toFixed(4)}, 95th=${baseline.residual.percentile95.toFixed(4)}`
    );

    console.log('Random baseline saved to analysis/random_baseline.json');
  }

  /**
   * Run Phase 0 control: trivial (non-ethical) elements as negative control
   */
  async runPhase0Control(): Promise<PhaseResult> {
    if (!this.initialized || !this.experimentConfig) {
      throw new Error('Experiment not initialized. Call initialize() first.');
    }

    console.log('\n=== Phase 0 Control: Trivial Elements ===\n');
    const startTime = Date.now();

    const trivialElements = await this.configLoader.getTrivialElements();
    if (trivialElements.length === 0) {
      console.log('No trivial elements configured. Skipping control phase.');
      return { phase: 'phase0_control', grids: [], gridLogs: [], duration: 0 };
    }

    const expConfig = await this.configLoader.loadExperiment();
    const iterations = Math.min(expConfig.phases.phase0.iterations || 5, 5); // Fewer iterations for control
    const persona = 'default';
    const phrasing = 'neutral' as const;

    const grids: Grid[] = [];
    const gridLogs: GridLog[] = [];

    for (let i = 0; i < iterations; i++) {
      console.log(`\nControl Iteration ${i + 1}/${iterations}`);

      const { grid, gridLog } = await this.elicitor.generateGrid(
        this.logger.getExperimentId(),
        trivialElements,
        persona,
        phrasing,
        { phase: 'phase0_control', iteration: i + 1 },
        this.constructsPerGrid
      );

      grids.push(grid);
      gridLogs.push(gridLog);
      await this.logger.logGrid(gridLog);

      console.log(`  Construct: "${grid.constructs[0].emergentPole}" vs "${grid.constructs[0].contrastPole}"`);
    }

    await this.embedConstructsForGrids(grids, gridLogs, 'phase0_control');

    const duration = Date.now() - startTime;
    console.log(`\nPhase 0 Control complete: ${grids.length} grids in ${(duration / 1000).toFixed(1)}s`);

    return { phase: 'phase0_control', grids, gridLogs, duration };
  }

  /**
   * Run temperature sensitivity analysis
   */
  async runTemperatureSensitivity(): Promise<PhaseResult[]> {
    if (!this.initialized || !this.experimentConfig) {
      throw new Error('Experiment not initialized. Call initialize() first.');
    }

    const expConfig = await this.configLoader.loadExperiment();
    if (!expConfig.sensitivity?.enabled) {
      console.log('Temperature sensitivity analysis disabled in config.');
      return [];
    }

    console.log('\n=== Temperature Sensitivity Analysis ===\n');

    const temperatures = expConfig.sensitivity.temperatures;
    const elements = await this.configLoader.getElements(true);
    const iterations = Math.min(expConfig.phases.phase0.iterations || 5, 5);
    const persona = 'default';
    const phrasing = 'neutral' as const;
    const results: PhaseResult[] = [];

    for (const temp of temperatures) {
      console.log(`\n--- Temperature: ${temp} ---`);
      const startTime = Date.now();

      const grids: Grid[] = [];
      const gridLogs: GridLog[] = [];

      for (let i = 0; i < iterations; i++) {
        console.log(`  Iteration ${i + 1}/${iterations}`);

        const { grid, gridLog } = await this.elicitor.generateGrid(
          this.logger.getExperimentId(),
          elements,
          persona,
          phrasing,
          { phase: `temp_sensitivity_${temp}`, iteration: i + 1, temperature: temp },
          this.constructsPerGrid
        );

        grids.push(grid);
        gridLogs.push(gridLog);
        await this.logger.logGrid(gridLog);
      }

      await this.embedConstructsForGrids(grids, gridLogs, `temp_sensitivity_${temp}`);

      const duration = Date.now() - startTime;
      results.push({ phase: `temp_sensitivity_${temp}`, grids, gridLogs, duration });
    }

    this.logger.logDecision(
      'temperature_sensitivity_completed',
      temperatures.join(','),
      `Ran sensitivity analysis at temperatures: ${temperatures.join(', ')}`
    );

    return results;
  }

  /**
   * Run Phase 0: Baseline Stability Audit
   */
  async runPhase0(): Promise<PhaseResult> {
    if (!this.initialized || !this.experimentConfig) {
      throw new Error('Experiment not initialized. Call initialize() first.');
    }

    console.log('\n=== Phase 0: Baseline Stability Audit ===\n');
    const startTime = Date.now();

    const elements = await this.configLoader.getElements(true);
    const expConfig = await this.configLoader.loadExperiment();
    const iterations = expConfig.phases.phase0.iterations || this.experimentConfig.iterations;
    const persona = expConfig.phases.phase0.persona || 'default';
    const phrasing = (expConfig.phases.phase0.phrasing || 'neutral') as 'neutral' | 'dysphemistic' | 'euphemistic';

    // Determine framing rotation
    const evalConfig = expConfig.evaluation_awareness;
    const framings = evalConfig?.rotateFramings ? evalConfig.framings : [evalConfig?.defaultFraming || undefined];

    const grids: Grid[] = [];
    const gridLogs: GridLog[] = [];

    for (let i = 0; i < iterations; i++) {
      // Rotate framings if enabled
      const framing = evalConfig?.rotateFramings
        ? framings[i % framings.length]
        : undefined;

      console.log(`\nIteration ${i + 1}/${iterations}${framing ? ` [framing: ${framing}]` : ''}`);

      const { grid, gridLog } = await this.elicitor.generateGrid(
        this.logger.getExperimentId(),
        elements,
        persona,
        phrasing,
        { phase: 'phase0', iteration: i + 1, framing },
        this.constructsPerGrid
      );

      grids.push(grid);
      gridLogs.push(gridLog);

      await this.logger.logGrid(gridLog);

      console.log(`  Construct: "${grid.constructs[0].emergentPole}" vs "${grid.constructs[0].contrastPole}"`);
    }

    await this.embedConstructsForGrids(grids, gridLogs, 'phase0');

    const duration = Date.now() - startTime;
    console.log(`\nPhase 0 complete: ${grids.length} grids in ${(duration / 1000).toFixed(1)}s`);

    return { phase: 'phase0', grids, gridLogs, duration };
  }

  /**
   * Run Phase 1: Synonym Attack
   */
  async runPhase1(): Promise<PhaseResult> {
    if (!this.initialized || !this.experimentConfig) {
      throw new Error('Experiment not initialized. Call initialize() first.');
    }

    console.log('\n=== Phase 1: Synonym Attack ===\n');
    const startTime = Date.now();

    const elements = await this.configLoader.getElements(true);
    const expConfig = await this.configLoader.loadExperiment();
    const iterations = expConfig.phases.phase1.iterations || this.experimentConfig.iterations;
    const persona = 'default';
    // Use full phrasings list when not in pilot mode
    const phrasings = (this.experimentConfig.phrasings || expConfig.phases.phase1.phrasings || ['neutral', 'dysphemistic']) as Array<'neutral' | 'dysphemistic' | 'euphemistic'>;

    const grids: Grid[] = [];
    const gridLogs: GridLog[] = [];

    for (const phrasing of phrasings) {
      console.log(`\n--- Phrasing: ${phrasing} ---`);

      for (let i = 0; i < iterations; i++) {
        console.log(`\nIteration ${i + 1}/${iterations} (${phrasing})`);

        const { grid, gridLog } = await this.elicitor.generateGrid(
          this.logger.getExperimentId(),
          elements,
          persona,
          phrasing,
          { phase: 'phase1', iteration: i + 1 },
          this.constructsPerGrid
        );

        grids.push(grid);
        gridLogs.push(gridLog);

        await this.logger.logGrid(gridLog);

        console.log(`  Construct: "${grid.constructs[0].emergentPole}" vs "${grid.constructs[0].contrastPole}"`);
      }
    }

    await this.embedConstructsForGrids(grids, gridLogs, 'phase1');

    const duration = Date.now() - startTime;
    console.log(`\nPhase 1 complete: ${grids.length} grids in ${(duration / 1000).toFixed(1)}s`);

    return { phase: 'phase1', grids, gridLogs, duration };
  }

  /**
   * Run Phase 2: Persona Invariance
   */
  async runPhase2(): Promise<PhaseResult> {
    if (!this.initialized || !this.experimentConfig) {
      throw new Error('Experiment not initialized. Call initialize() first.');
    }

    console.log('\n=== Phase 2: Persona Invariance ===\n');
    const startTime = Date.now();

    const elements = await this.configLoader.getElements(true);
    const expConfig = await this.configLoader.loadExperiment();
    const iterations = expConfig.phases.phase2.iterations || this.experimentConfig.iterations;
    const phrasing = 'neutral' as const;
    // Use full personas list when not in pilot mode
    const personas = this.experimentConfig.personas || expConfig.phases.phase2.personas || ['default', 'red-teamer'];

    const grids: Grid[] = [];
    const gridLogs: GridLog[] = [];

    for (const persona of personas) {
      console.log(`\n--- Persona: ${persona} ---`);

      for (let i = 0; i < iterations; i++) {
        console.log(`\nIteration ${i + 1}/${iterations} (${persona})`);

        const { grid, gridLog } = await this.elicitor.generateGrid(
          this.logger.getExperimentId(),
          elements,
          persona,
          phrasing,
          { phase: 'phase2', iteration: i + 1 },
          this.constructsPerGrid
        );

        grids.push(grid);
        gridLogs.push(gridLog);

        await this.logger.logGrid(gridLog);

        console.log(`  Construct: "${grid.constructs[0].emergentPole}" vs "${grid.constructs[0].contrastPole}"`);
      }
    }

    await this.embedConstructsForGrids(grids, gridLogs, 'phase2');

    const duration = Date.now() - startTime;
    console.log(`\nPhase 2 complete: ${grids.length} grids in ${(duration / 1000).toFixed(1)}s`);

    return { phase: 'phase2', grids, gridLogs, duration };
  }

  /**
   * Run all enabled phases
   */
  async runAll(): Promise<Map<string, PhaseResult>> {
    if (!this.initialized) {
      throw new Error('Experiment not initialized. Call initialize() first.');
    }

    const expConfig = await this.configLoader.loadExperiment();
    const results = new Map<string, PhaseResult>();

    try {
      if (expConfig.phases.phase0.enabled) {
        const phase0Result = await this.runPhase0();
        results.set('phase0', phase0Result);

        // Run random baseline after Phase 0
        await this.runRandomBaseline();

        // Run control phase if trivial elements exist
        try {
          const controlResult = await this.runPhase0Control();
          if (controlResult.grids.length > 0) {
            results.set('phase0_control', controlResult);
          }
        } catch (error) {
          console.warn('Control phase skipped:', error instanceof Error ? error.message : error);
        }

        // Run temperature sensitivity if enabled
        try {
          const tempResults = await this.runTemperatureSensitivity();
          for (const result of tempResults) {
            results.set(result.phase, result);
          }
        } catch (error) {
          console.warn('Temperature sensitivity skipped:', error instanceof Error ? error.message : error);
        }
      }

      if (expConfig.phases.phase1.enabled) {
        results.set('phase1', await this.runPhase1());
      }

      if (expConfig.phases.phase2.enabled) {
        results.set('phase2', await this.runPhase2());
      }

      // Calculate summary
      let totalGrids = 0;
      for (const result of results.values()) {
        totalGrids += result.grids.length;
      }

      // Calculate and save stability metrics
      await this.calculateAndSaveMetrics(results);

      // Finalize experiment
      await this.logger.finalize({
        totalGrids,
        totalApiCalls: 0,
        totalTokensUsed: { input: 0, output: 0 },
        phases: {},
      });

      console.log('\n=== Experiment Complete ===');
      console.log(`Total grids: ${totalGrids}`);
      console.log(`Results saved to: ${this.logger.getBaseDir()}`);

    } catch (error) {
      await this.logger.fail(error instanceof Error ? error : new Error('Unknown error'));
      throw error;
    }

    return results;
  }

  /**
   * Calculate stability metrics for all completed phases and save to analysis dir
   */
  private async calculateAndSaveMetrics(results: Map<string, PhaseResult>): Promise<void> {
    console.log('\n=== Calculating Stability Metrics ===\n');

    const elements = await this.configLoader.getElements(true);
    const elementOrder = elements.map((e) => e.id);
    const metrics: Record<string, unknown> = {};

    // Phase 0: Baseline Cosine Similarity + Procrustes Residual
    const phase0 = results.get('phase0');
    if (phase0 && phase0.grids.length > 0) {
      try {
        const constructsWithEmbeddings = phase0.grids
          .flatMap((g) => g.constructs)
          .filter((c): c is typeof c & { embedding: number[] } => !!c.embedding && c.embedding.length > 0);

        const phase0Metrics = calculatePhase0Metrics(
          phase0.grids,
          elementOrder,
          constructsWithEmbeddings
        );
        metrics.phase0 = phase0Metrics;
        console.log(`Phase 0 - Procrustes Residual (raw): ${phase0Metrics.metrics.procrustesResidual.toFixed(4)}`);
        console.log(`Phase 0 - Procrustes Residual (normalized): ${phase0Metrics.metrics.normalizedProcrustesResidual?.toFixed(4)}`);
        console.log(`Phase 0 - Stability Score: ${phase0Metrics.metrics.stabilityScore?.toFixed(4)}`);
        console.log(`Phase 0 - Cosine Similarity: ${phase0Metrics.metrics.baselineCosineSimilarity.toFixed(4)}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`Phase 0 metrics FAILED: ${msg}`);
        metrics.phase0 = { error: msg };
      }
    }

    // Phase 1: SVR + Procrustes Residual
    const phase1 = results.get('phase1');
    if (phase1 && phase1.grids.length > 0) {
      try {
        const neutralGrids = phase1.grids.filter((g) => g.phrasing === 'neutral');
        const dysGrids = phase1.grids.filter((g) => g.phrasing === 'dysphemistic');

        if (neutralGrids.length > 0 && dysGrids.length > 0) {
          const phase1Metrics = calculatePhase1Metrics(neutralGrids, dysGrids, elementOrder);
          metrics.phase1 = phase1Metrics;
          console.log(`Phase 1 - SVR: ${phase1Metrics.metrics.synonymVarianceRatio?.toFixed(4)}`);
          console.log(`Phase 1 - Procrustes Residual (raw): ${phase1Metrics.metrics.procrustesResidual.toFixed(4)}`);
          console.log(`Phase 1 - Procrustes Residual (normalized): ${phase1Metrics.metrics.normalizedProcrustesResidual?.toFixed(4)}`);
          console.log(`Phase 1 - Stability Score: ${phase1Metrics.metrics.stabilityScore?.toFixed(4)}`);
        } else {
          console.log('Phase 1 metrics skipped: need both neutral and dysphemistic grids');
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`Phase 1 metrics FAILED: ${msg}`);
        metrics.phase1 = { error: msg };
      }
    }

    // Phase 2: PDS + Procrustes Residual (computed per non-default persona)
    const phase2 = results.get('phase2');
    if (phase2 && phase2.grids.length > 0) {
      try {
        const defaultGrids = phase2.grids.filter((g) => g.persona === 'default');
        // Get all unique non-default personas
        const nonDefaultPersonas = [...new Set(
          phase2.grids.filter(g => g.persona !== 'default').map(g => g.persona)
        )];

        if (defaultGrids.length >= 2 && nonDefaultPersonas.length > 0) {
          for (const steeredPersona of nonDefaultPersonas) {
            const steeredGrids = phase2.grids.filter((g) => g.persona === steeredPersona);
            if (steeredGrids.length < 2) {
              console.log(`Phase 2 - Skipping persona "${steeredPersona}": only ${steeredGrids.length} grids (need >=2)`);
              continue;
            }

            const phase2Metrics = calculatePhase2Metrics(defaultGrids, steeredGrids, elementOrder);
            // Store per-persona metrics
            metrics[`phase2_${steeredPersona}`] = phase2Metrics;
            // Keep first one as phase2 for backwards compatibility
            if (!metrics.phase2) metrics.phase2 = phase2Metrics;

            console.log(`Phase 2 - Persona: default vs ${steeredPersona}`);
            console.log(`Phase 2 - PDS: ${phase2Metrics.metrics.personaDisplacementScore?.toFixed(4) ?? 'N/A'}`);
            console.log(`Phase 2 - Procrustes Residual (raw): ${phase2Metrics.metrics.procrustesResidual?.toFixed(4) ?? 'N/A'}`);
            console.log(`Phase 2 - Procrustes Residual (normalized): ${phase2Metrics.metrics.normalizedProcrustesResidual?.toFixed(4) ?? 'N/A'}`);
            console.log(`Phase 2 - Stability Score: ${phase2Metrics.metrics.stabilityScore?.toFixed(4) ?? 'N/A'}`);
          }
        } else {
          console.log('Phase 2 metrics skipped: need both default (>=2) and steered persona grids');
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`Phase 2 metrics FAILED: ${msg}`);
        metrics.phase2 = { error: msg };
      }
    }

    if (Object.keys(metrics).length > 0) {
      const analysisDir = join(this.logger.getBaseDir(), 'analysis');
      await this.storage.mkdir(analysisDir);
      await this.storage.write(
        join(analysisDir, 'stability_metrics.json'),
        JSON.stringify(metrics, null, 2)
      );
      console.log('\nStability metrics saved to analysis/stability_metrics.json');
    }
  }

  getExperimentId(): string {
    return this.logger.getExperimentId();
  }

  getOutputDir(): string {
    return this.logger.getBaseDir();
  }

  /**
   * Load phase 0 triads from a previous experiment
   */
  private async loadPhase0Triads(experimentDir: string): Promise<{ triad: [string, string, string]; iteration: number }[]> {
    const gridsDir = join(experimentDir, 'grids');
    const files = await this.storage.list(gridsDir);
    const triadsWithIteration: { triad: [string, string, string]; iteration: number }[] = [];

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const content = await this.storage.read(join(gridsDir, file));
      const grid: GridLog = JSON.parse(content);

      if (grid.conditions.phase === 'phase0') {
        for (const construct of grid.constructs) {
          triadsWithIteration.push({
            triad: construct.triad,
            iteration: grid.conditions.iteration,
          });
        }
      }
    }

    return triadsWithIteration.sort((a, b) => a.iteration - b.iteration);
  }

  /**
   * Rerun Phase 0 using triads from a previous experiment
   */
  async rerunPhase0FromPrevious(previousExperimentId: string): Promise<PhaseResult> {
    if (!this.initialized || !this.experimentConfig) {
      throw new Error('Experiment not initialized. Call initialize() first.');
    }

    console.log(`\n=== Rerunning Phase 0 from ${previousExperimentId} ===\n`);
    const startTime = Date.now();

    const previousDir = join('data/results', previousExperimentId);
    const triadsWithIteration = await this.loadPhase0Triads(previousDir);

    if (triadsWithIteration.length === 0) {
      throw new Error(`No phase0 triads found in experiment ${previousExperimentId}`);
    }

    console.log(`Loaded ${triadsWithIteration.length} triads from previous experiment`);
    this.logger.logDecision('rerun_source', previousExperimentId,
      `Rerunning phase0 with triads from previous experiment`);

    const elements = await this.configLoader.getElements(true);
    const expConfig = await this.configLoader.loadExperiment();
    const persona = expConfig.phases.phase0.persona || 'default';
    const phrasing = (expConfig.phases.phase0.phrasing || 'neutral') as 'neutral' | 'dysphemistic' | 'euphemistic';

    const grids: Grid[] = [];
    const gridLogs: GridLog[] = [];

    for (let i = 0; i < triadsWithIteration.length; i++) {
      const { triad, iteration } = triadsWithIteration[i];
      console.log(`\nIteration ${i + 1}/${triadsWithIteration.length} (original iteration ${iteration})`);

      const { grid, gridLog } = await this.elicitor.generateGridWithFixedTriad(
        this.logger.getExperimentId(),
        elements,
        triad,
        persona,
        phrasing,
        { phase: 'phase0', iteration: i + 1 }
      );

      grids.push(grid);
      gridLogs.push(gridLog);
      await this.logger.logGrid(gridLog);

      console.log(`  Construct: "${grid.constructs[0].emergentPole}" vs "${grid.constructs[0].contrastPole}"`);
    }

    await this.embedConstructsForGrids(grids, gridLogs, 'phase0');

    const duration = Date.now() - startTime;
    console.log(`\nPhase 0 rerun complete: ${grids.length} grids in ${(duration / 1000).toFixed(1)}s`);

    return { phase: 'phase0', grids, gridLogs, duration };
  }

  async finalizeRerun(result: PhaseResult): Promise<void> {
    await this.logger.finalize({
      totalGrids: result.grids.length,
      totalApiCalls: 0,
      totalTokensUsed: { input: 0, output: 0 },
      phases: {},
    });

    console.log('\n=== Rerun Complete ===');
    console.log(`Total grids: ${result.grids.length}`);
    console.log(`Results saved to: ${this.logger.getBaseDir()}`);
  }

  /**
   * Rerun Phase 0 in-place (updates existing experiment with alternative model results)
   */
  async rerunInPlace(existingExperimentId: string): Promise<void> {
    console.log(`\n=== Rerunning Phase 0 in-place for ${existingExperimentId} ===\n`);
    console.log(`Using model: ${this.selectedModel}`);

    const existingDir = join('data/results', existingExperimentId);

    const triadsWithIteration = await this.loadPhase0Triads(existingDir);
    if (triadsWithIteration.length === 0) {
      throw new Error(`No phase0 triads found in experiment ${existingExperimentId}`);
    }

    console.log(`Loaded ${triadsWithIteration.length} triads from existing experiment`);

    const elements = await this.configLoader.getElements(true);
    const expConfig = await this.configLoader.loadExperiment();
    const persona = expConfig.phases.phase0.persona || 'default';
    const phrasing = (expConfig.phases.phase0.phrasing || 'neutral') as 'neutral' | 'dysphemistic' | 'euphemistic';

    const rerunDir = join(existingDir, 'rerun', this.selectedModel);
    await this.storage.mkdir(rerunDir);

    const grids: Grid[] = [];
    const gridLogs: GridLog[] = [];

    for (let i = 0; i < triadsWithIteration.length; i++) {
      const { triad, iteration } = triadsWithIteration[i];
      console.log(`\nIteration ${i + 1}/${triadsWithIteration.length} (original iteration ${iteration})`);

      const { grid, gridLog } = await this.elicitor.generateGridWithFixedTriad(
        existingExperimentId,
        elements,
        triad,
        persona,
        phrasing,
        { phase: 'phase0_rerun', iteration: i + 1 }
      );

      grid.model = this.llmClient.getConfig().model;

      grids.push(grid);
      gridLogs.push(gridLog);

      const gridPath = join(rerunDir, `${gridLog.gridId}.json`);
      await this.storage.write(gridPath, JSON.stringify(gridLog, null, 2));

      console.log(`  Construct: "${grid.constructs[0].emergentPole}" vs "${grid.constructs[0].contrastPole}"`);
    }

    // Generate embeddings for rerun grids
    console.log('\nGenerating embeddings for rerun constructs...');
    const allConstructs = grids.flatMap((g) => g.constructs);
    const constructTexts = allConstructs.map(
      (c) => `${c.emergentPole} vs ${c.contrastPole}`
    );

    try {
      const result = await this.voyageClient.embed(constructTexts, {
        inputType: 'document',
        metadata: { phase: 'phase0_rerun', iteration: 0 },
      });

      allConstructs.forEach((construct, index) => {
        construct.embedding = result.embeddings[index];
      });

      for (const gridLog of gridLogs) {
        const grid = grids.find((g) => g.id === gridLog.gridId);
        if (grid) {
          gridLog.constructs.forEach((logConstruct, index) => {
            const gridConstruct = grid.constructs[index];
            if (gridConstruct?.embedding) {
              logConstruct.embedding = gridConstruct.embedding;
            }
          });
          const gridPath = join(rerunDir, `${gridLog.gridId}.json`);
          await this.storage.write(gridPath, JSON.stringify(gridLog, null, 2));
        }
      }

      console.log(`  Embeddings generated: ${result.embeddings.length}`);
    } catch (error) {
      console.error('  Failed to generate embeddings:', error instanceof Error ? error.message : error);
    }

    // Update manifest with rerun info
    const manifestPath = join(existingDir, 'manifest.json');
    const manifestContent = await this.storage.read(manifestPath);
    const manifest = JSON.parse(manifestContent);

    if (!manifest.reruns) {
      manifest.reruns = {};
    }
    manifest.reruns[this.selectedModel] = {
      model: this.llmClient.getConfig().model,
      provider: this.llmClient.getProvider(),
      timestamp: new Date().toISOString(),
      gridCount: grids.length,
      constructCount: grids.reduce((sum, g) => sum + g.constructs.length, 0),
    };

    await this.storage.write(manifestPath, JSON.stringify(manifest, null, 2));

    await this.updateConsolidatedResultsWithRerun(existingDir, gridLogs, this.selectedModel);

    console.log('\n=== Running Cross-Model Analysis ===\n');
    await this.runCrossModelAnalysis(existingDir, gridLogs, this.selectedModel);

    console.log(`\n=== Rerun Complete ===`);
    console.log(`Results saved to: ${rerunDir}`);
    console.log(`Manifest updated with rerun info`);
  }

  /**
   * Extract constructs with embeddings from grid logs
   */
  private extractConstructsWithEmbeddings(gridLogs: GridLog[]): ConstructWithEmbedding[] {
    return gridLogs.flatMap((grid) =>
      grid.constructs
        .filter((c) => c.embedding && c.embedding.length > 0)
        .map((c) => ({
          id: c.id,
          emergentPole: c.emergentPole,
          contrastPole: c.contrastPole,
          embedding: c.embedding!,
          iteration: grid.conditions.iteration,
        }))
    );
  }

  /**
   * Load original phase0 grid logs from experiment directory
   */
  private async loadOriginalGridLogs(experimentDir: string): Promise<GridLog[]> {
    const gridsDir = join(experimentDir, 'grids');
    const files = await this.storage.list(gridsDir);
    const gridLogs: GridLog[] = [];

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const content = await this.storage.read(join(gridsDir, file));
      const grid: GridLog = JSON.parse(content);
      if (grid.conditions.phase === 'phase0') {
        gridLogs.push(grid);
      }
    }

    return gridLogs.sort((a, b) => a.conditions.iteration - b.conditions.iteration);
  }

  /**
   * Run cross-model analysis after a rerun
   */
  private async runCrossModelAnalysis(
    experimentDir: string,
    rerunGridLogs: GridLog[],
    rerunModel: string
  ): Promise<void> {
    try {
      const originalGridLogs = await this.loadOriginalGridLogs(experimentDir);

      const originalConstructs = this.extractConstructsWithEmbeddings(originalGridLogs);
      const rerunConstructs = this.extractConstructsWithEmbeddings(rerunGridLogs);

      console.log(`Original constructs: ${originalConstructs.length}`);
      console.log(`Rerun constructs: ${rerunConstructs.length}`);

      if (originalConstructs.length === 0 || rerunConstructs.length === 0) {
        console.log('Skipping analysis: insufficient construct embeddings');
        return;
      }

      const manifestPath = join(experimentDir, 'manifest.json');
      const manifestContent = await this.storage.read(manifestPath);
      const manifest = JSON.parse(manifestContent);
      const originalModel = manifest.config.model;

      const rerunModelId = this.llmClient.getConfig().model;

      const originalDimensionality = estimateDimensionality(originalConstructs, originalModel, this.clusterThreshold);
      const rerunDimensionality = estimateDimensionality(rerunConstructs, rerunModelId, this.clusterThreshold);

      console.log(`\nDimensionality Analysis:`);
      console.log(`  Original (${originalModel}): ${originalDimensionality.uniqueDimensions} unique dimensions`);
      console.log(`  Rerun (${rerunModelId}): ${rerunDimensionality.uniqueDimensions} unique dimensions`);

      const comparison = compareModels(
        originalConstructs,
        rerunConstructs,
        originalModel,
        rerunModelId,
        this.clusterThreshold
      );

      console.log(`\nCross-Model Comparison:`);
      console.log(`  Shared dimensions: ${comparison.sharedDimensions}`);
      console.log(`  Original-only: ${comparison.originalOnly}`);
      console.log(`  Rerun-only: ${comparison.rerunOnly}`);
      console.log(`  Overlap ratio: ${(comparison.overlapRatio * 100).toFixed(1)}%`);

      const analysisDir = join(experimentDir, 'analysis');
      await this.storage.mkdir(analysisDir);

      await this.storage.write(
        join(analysisDir, 'dimensionality.json'),
        JSON.stringify({ original: originalDimensionality, rerun: rerunDimensionality }, null, 2)
      );

      await this.storage.write(
        join(analysisDir, 'cross_model_comparison.json'),
        JSON.stringify(comparison, null, 2)
      );

      const summary = generateComparisonSummary(comparison);
      await this.storage.write(join(analysisDir, 'comparison_summary.txt'), summary);

      console.log(`\nAnalysis saved to: ${analysisDir}`);

      await this.updateConsolidatedWithAnalysis(experimentDir, comparison, originalDimensionality, rerunDimensionality);
    } catch (error) {
      console.error('Failed to run cross-model analysis:', error instanceof Error ? error.message : error);
    }
  }

  private async updateConsolidatedWithAnalysis(
    experimentDir: string,
    comparison: ReturnType<typeof compareModels>,
    originalDimensionality: ReturnType<typeof estimateDimensionality>,
    rerunDimensionality: ReturnType<typeof estimateDimensionality>
  ): Promise<void> {
    const consolidatedPath = join(experimentDir, 'consolidated_results.json');

    try {
      const content = await this.storage.read(consolidatedPath);
      const consolidated = JSON.parse(content);

      consolidated.analysis = {
        dimensionality: { original: originalDimensionality, rerun: rerunDimensionality },
        crossModel: comparison,
        saturationCurves: {
          original: comparison.saturationCurves.original,
          rerun: comparison.saturationCurves.rerun,
        },
        summary: comparison.summary,
      };

      await this.storage.write(consolidatedPath, JSON.stringify(consolidated, null, 2));
      console.log('Consolidated results updated with analysis');
    } catch (error) {
      console.error('Failed to update consolidated results with analysis:', error instanceof Error ? error.message : error);
    }
  }

  private async updateConsolidatedResultsWithRerun(
    experimentDir: string,
    rerunGridLogs: GridLog[],
    rerunModel: string
  ): Promise<void> {
    const consolidatedPath = join(experimentDir, 'consolidated_results.json');

    try {
      const content = await this.storage.read(consolidatedPath);
      const consolidated = JSON.parse(content);

      if (!consolidated.reruns) {
        consolidated.reruns = {};
      }

      const rerunConstructs = rerunGridLogs.flatMap((grid) =>
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

      consolidated.reruns[rerunModel] = {
        model: this.llmClient.getConfig().model,
        provider: this.llmClient.getProvider(),
        timestamp: new Date().toISOString(),
        grids: rerunGridLogs,
        constructs: rerunConstructs,
      };

      consolidated.modelComparison = {
        originalModel: consolidated.config.model,
        rerunModels: Object.keys(consolidated.reruns),
        comparisonReady: true,
      };

      await this.storage.write(consolidatedPath, JSON.stringify(consolidated, null, 2));
      console.log('Consolidated results updated with rerun data');
    } catch (error) {
      console.error('Failed to update consolidated results:', error instanceof Error ? error.message : error);
    }
  }
}
