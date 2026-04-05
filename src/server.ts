/**
 * Fastify Server
 * REST API for running experiments and fetching results
 */

import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { join } from 'path';
import { ExperimentRunner } from './experiment/runner.js';
import { ModelRegistry } from './clients/registry.js';
import { UserStore } from './auth/users.js';
import { registerAuth } from './auth/middleware.js';
import { createStorage } from './services/storage.js';
import { ThresholdCalibrator } from './analysis/thresholdCalibration.js';
import type { ExperimentManifest, GridLog } from './core/types.js';

const fastify = Fastify({
  logger: true,
});

// Register CORS
await fastify.register(cors, {
  origin: true,
});

// Initialize storage
const storage = createStorage();

// Initialize auth
const userStore = new UserStore();
await userStore.seedFromEnv();
await registerAuth(fastify, userStore);

// Track running experiments
const runningExperiments = new Map<string, {
  runner: ExperimentRunner;
  status: 'running' | 'completed' | 'failed';
  error?: string;
}>();

// Mark stale "running" experiments as "interrupted" on startup
async function markStaleExperiments(): Promise<void> {
  const resultsDir = 'data/results';
  try {
    const dirs = await storage.list(resultsDir);
    for (const dir of dirs) {
      try {
        const manifestPath = join(resultsDir, dir, 'manifest.json');
        const content = await storage.read(manifestPath);
        const manifest: ExperimentManifest = JSON.parse(content);
        if (manifest.status === 'running') {
          manifest.status = 'interrupted';
          manifest.endTime = new Date().toISOString();
          await storage.write(manifestPath, JSON.stringify(manifest, null, 2));
          console.log(`[Startup] Marked stale experiment ${manifest.id} as interrupted`);
        }
      } catch {
        // Skip invalid directories
      }
    }
  } catch {
    // Results directory doesn't exist yet
  }
}
await markStaleExperiments();

// Routes

/**
 * Health check
 */
fastify.get('/health', async () => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

/**
 * Get experiment configuration
 */
fastify.get('/config', async () => {
  const configDir = 'config';
  const files = ['elements.yaml', 'personas.yaml', 'prompts.yaml', 'experiment.yaml'];
  const config: Record<string, string> = {};

  for (const file of files) {
    try {
      config[file] = await storage.read(join(configDir, file));
    } catch {
      config[file] = '';
    }
  }

  return config;
});

/**
 * Get available models from registry
 */
fastify.get('/models', async () => {
  const registry = new ModelRegistry();
  const keys = registry.getAvailableKeys();
  return {
    models: keys.map((key) => ({
      key,
      ...registry.getEntry(key),
      apiKeyAvailable: registry.validateApiKey(key),
    })),
  };
});

/**
 * Start a new experiment
 */
fastify.post<{
  Body: { pilot?: boolean; phases?: string[]; model?: string; rerunFrom?: string; apiDelaySeconds?: number; category?: string };
}>('/experiment/run', async (request, reply) => {
  const { pilot = true, phases, model = 'claude-haiku', rerunFrom, apiDelaySeconds, category = 'ethics' } = request.body || {};

  // Validate category
  const validCategories = ['ethics', 'meals', 'instruments', 'objects'];
  if (!validCategories.includes(category)) {
    reply.code(400);
    return { error: `Invalid category: ${category}. Must be one of: ${validCategories.join(', ')}` };
  }

  // Map category to config directory
  const configDir = category === 'ethics' ? 'config' : `config/${category}`;

  // Resolve model key (supports legacy + registry keys)
  const resolvedModel = ModelRegistry.resolveLegacyKey(model);

  const runner = new ExperimentRunner({
    configDir,
    outputDir: 'data/results',
    model: resolvedModel,
    category,
    storage,
    apiDelaySeconds: apiDelaySeconds || 0,
  });

  try {
    const experimentId = await runner.initialize(pilot);

    // Store runner
    runningExperiments.set(experimentId, {
      runner,
      status: 'running',
    });

    // Run in background
    (async () => {
      try {
        if (rerunFrom) {
          const result = await runner.rerunPhase0FromPrevious(rerunFrom);
          await runner.finalizeRerun(result);
        } else {
          await runner.runAll();
        }
        const entry = runningExperiments.get(experimentId);
        if (entry) {
          entry.status = 'completed';
        }
      } catch (error) {
        const errorMessage = error instanceof Error
          ? `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ''}`
          : 'Unknown error';
        console.error(`[Experiment ${experimentId}] FAILED:`, errorMessage);
        const entry = runningExperiments.get(experimentId);
        if (entry) {
          entry.status = 'failed';
          entry.error = error instanceof Error ? error.message : 'Unknown error';
        }
      }
    })();

    return {
      experimentId,
      status: 'started',
      outputDir: runner.getOutputDir(),
      model: resolvedModel,
      category,
      rerunFrom: rerunFrom || null,
    };
  } catch (error) {
    reply.code(500);
    return {
      error: error instanceof Error ? error.message : 'Failed to start experiment',
    };
  }
});

/**
 * Rerun Phase 0 with alternative model (updates existing experiment)
 */
fastify.post<{
  Params: { experimentId: string };
  Body: { model?: string };
}>('/experiment/:experimentId/rerun', async (request, reply) => {
  const { experimentId } = request.params;
  const experimentDir = join('data/results', experimentId);

  try {
    const manifestContent = await storage.read(join(experimentDir, 'manifest.json'));
    const manifest: ExperimentManifest = JSON.parse(manifestContent);

    // Determine alternative model
    const originalModel = manifest.config.model;
    const requestedModel = request.body?.model;
    let altModelKey: string;

    if (requestedModel) {
      altModelKey = ModelRegistry.resolveLegacyKey(requestedModel);
    } else {
      // Default: swap to an alternative model within the same provider family
      const ALT_MODEL_MAP: Record<string, string> = {
        'claude-haiku': 'claude-sonnet',
        'claude-sonnet': 'claude-haiku',
        'claude-opus': 'claude-sonnet',
        'gpt-5': 'gpt-4.1',
        'gpt-4.1': 'gpt-5',
        'o3': 'gpt-5',
        'gemini-2.5-pro': 'gemini-2.5-flash',
        'gemini-2.5-flash': 'gemini-2.5-pro',
        'deepseek-v3': 'deepseek-r1',
        'deepseek-r1': 'deepseek-v3',
        'deepseek-v3-openrouter': 'deepseek-r1-openrouter',
        'deepseek-r1-openrouter': 'deepseek-v3-openrouter',
        'llama-4': 'deepseek',
        'deepseek': 'llama-4',
        'gpt-oss': 'llama-4',
      };
      // Try to resolve the original model key from the model string
      const resolvedOriginal = Object.entries(ALT_MODEL_MAP).find(
        ([key]) => originalModel.includes(key.replace('claude-', ''))
      );
      altModelKey = resolvedOriginal
        ? ALT_MODEL_MAP[resolvedOriginal[0]]
        : originalModel.includes('haiku') ? 'claude-sonnet' : 'claude-haiku';
    }

    console.log(`[Rerun] Starting rerun of ${experimentId} with ${altModelKey} (original: ${originalModel})`);

    const runner = new ExperimentRunner({
      configDir: 'config',
      outputDir: 'data/results',
      model: altModelKey,
      storage,
    });

    runningExperiments.set(experimentId, {
      runner,
      status: 'running',
    });

    (async () => {
      try {
        await runner.rerunInPlace(experimentId);
        const entry = runningExperiments.get(experimentId);
        if (entry) {
          entry.status = 'completed';
        }
      } catch (error) {
        const errorMessage = error instanceof Error
          ? `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ''}`
          : 'Unknown error';
        console.error(`[Rerun ${experimentId}] FAILED:`, errorMessage);
        const entry = runningExperiments.get(experimentId);
        if (entry) {
          entry.status = 'failed';
          entry.error = error instanceof Error ? error.message : 'Unknown error';
        }
      }
    })();

    return {
      experimentId,
      status: 'rerun_started',
      originalModel,
      rerunModel: altModelKey,
    };
  } catch (error) {
    reply.code(500);
    return {
      error: error instanceof Error ? error.message : 'Failed to start rerun',
    };
  }
});

/**
 * Get experiment status
 */
fastify.get<{
  Params: { experimentId: string };
}>('/experiment/status/:experimentId', async (request, reply) => {
  const { experimentId } = request.params;

  const running = runningExperiments.get(experimentId);
  if (running) {
    return {
      experimentId,
      status: running.status,
      error: running.error,
    };
  }

  const resultsDir = 'data/results';
  const experimentDir = join(resultsDir, experimentId);

  try {
    const manifestContent = await storage.read(join(experimentDir, 'manifest.json'));
    const manifest: ExperimentManifest = JSON.parse(manifestContent);
    return {
      experimentId,
      status: manifest.status,
      startTime: manifest.startTime,
      endTime: manifest.endTime,
    };
  } catch {
    reply.code(404);
    return { error: 'Experiment not found' };
  }
});

/**
 * List all experiments
 */
fastify.get('/experiments', async () => {
  const resultsDir = 'data/results';
  const experiments: Array<{
    id: string;
    status: string;
    startTime: string;
    endTime?: string;
    model?: string;
    category?: string;
    provider?: string;
    hasRerun?: boolean;
    rerunModels?: string[];
  }> = [];

  try {
    const dirs = await storage.list(resultsDir);

    for (const dir of dirs) {
      try {
        const manifestPath = join(resultsDir, dir, 'manifest.json');
        const content = await storage.read(manifestPath);
        const manifest: ExperimentManifest = JSON.parse(content);

        const reruns = (manifest as any).reruns;
        const hasRerun = reruns && Object.keys(reruns).length > 0;
        const rerunModels = hasRerun ? Object.keys(reruns) : undefined;

        experiments.push({
          id: manifest.id,
          status: manifest.status,
          startTime: manifest.startTime,
          endTime: manifest.endTime,
          model: manifest.config.model,
          category: manifest.config.category || 'ethics',
          hasRerun,
          rerunModels,
        });
      } catch {
        // Skip invalid directories
      }
    }
  } catch {
    // Results directory doesn't exist yet
  }

  experiments.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());

  return { experiments };
});

/**
 * Delete an experiment
 */
fastify.delete<{
  Params: { experimentId: string };
}>('/experiments/:experimentId', async (request, reply) => {
  const { experimentId } = request.params;
  const manifestPath = join('data/results', experimentId, 'manifest.json');

  try {
    const exists = await storage.exists(manifestPath);
    if (!exists) {
      reply.code(404);
      return { error: 'Experiment not found' };
    }

    // Clean up in-memory tracking if present
    runningExperiments.delete(experimentId);

    await storage.deleteDir(join('data/results', experimentId));
    return { success: true };
  } catch (error) {
    reply.code(500);
    return {
      error: error instanceof Error ? error.message : 'Failed to delete experiment',
    };
  }
});

/**
 * Get experiment results
 */
fastify.get<{
  Params: { experimentId: string };
}>('/results/:experimentId', async (request, reply) => {
  const { experimentId } = request.params;
  const experimentDir = join('data/results', experimentId);

  try {
    const manifestContent = await storage.read(join(experimentDir, 'manifest.json'));
    const manifest: ExperimentManifest = JSON.parse(manifestContent);

    let summary = null;
    try {
      const summaryContent = await storage.read(join(experimentDir, 'summary.json'));
      summary = JSON.parse(summaryContent);
    } catch { /* No summary yet */ }

    let analysis: Record<string, unknown> | null = null;
    try {
      const analysisDir = join(experimentDir, 'analysis');
      const analysisFiles = await storage.list(analysisDir);
      analysis = {};
      for (const file of analysisFiles) {
        if (file.endsWith('.json')) {
          const content = await storage.read(join(analysisDir, file));
          analysis[file.replace('.json', '')] = JSON.parse(content);
        }
      }
    } catch { /* No analysis yet */ }

    return { manifest, summary, analysis };
  } catch {
    reply.code(404);
    return { error: 'Experiment not found' };
  }
});

/**
 * Get grids for an experiment
 */
fastify.get<{
  Params: { experimentId: string };
  Querystring: { phase?: string; persona?: string; phrasing?: string };
}>('/results/:experimentId/grids', async (request, reply) => {
  const { experimentId } = request.params;
  const { phase, persona, phrasing } = request.query;

  const gridsDir = join('data/results', experimentId, 'grids');

  try {
    const files = await storage.list(gridsDir);
    const grids: GridLog[] = [];

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      const content = await storage.read(join(gridsDir, file));
      const grid: GridLog = JSON.parse(content);

      if (phase && grid.conditions.phase !== phase) continue;
      if (persona && grid.conditions.persona !== persona) continue;
      if (phrasing && grid.conditions.phrasing !== phrasing) continue;

      grids.push(grid);
    }

    grids.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    return { grids, count: grids.length };
  } catch {
    reply.code(404);
    return { error: 'Experiment or grids not found' };
  }
});

/**
 * Get dimensionality analysis for an experiment
 */
fastify.get<{
  Params: { experimentId: string };
}>('/results/:experimentId/analysis/dimensionality', async (request, reply) => {
  const { experimentId } = request.params;
  const analysisPath = join('data/results', experimentId, 'analysis', 'dimensionality.json');

  try {
    const content = await storage.read(analysisPath);
    return JSON.parse(content);
  } catch {
    reply.code(404);
    return { error: 'Dimensionality analysis not found' };
  }
});

/**
 * Get cross-model comparison for an experiment
 */
fastify.get<{
  Params: { experimentId: string };
}>('/results/:experimentId/analysis/cross-model', async (request, reply) => {
  const { experimentId } = request.params;
  const analysisPath = join('data/results', experimentId, 'analysis', 'cross_model_comparison.json');

  try {
    const content = await storage.read(analysisPath);
    return JSON.parse(content);
  } catch {
    reply.code(404);
    return { error: 'Cross-model comparison not found' };
  }
});

/**
 * Get all analysis data for an experiment
 */
fastify.get<{
  Params: { experimentId: string };
}>('/results/:experimentId/analysis', async (request, reply) => {
  const { experimentId } = request.params;
  const analysisDir = join('data/results', experimentId, 'analysis');

  try {
    const files = await storage.list(analysisDir);
    const analysis: Record<string, unknown> = {};

    for (const file of files) {
      if (file.endsWith('.json')) {
        const content = await storage.read(join(analysisDir, file));
        const key = file.replace('.json', '');
        analysis[key] = JSON.parse(content);
      }
    }

    return analysis;
  } catch {
    reply.code(404);
    return { error: 'Analysis not found' };
  }
});

/**
 * Get threshold calibration data
 */
fastify.get('/analysis/calibration', async (request, reply) => {
  const calibrationPath = 'data/analysis/threshold_calibration.json';

  try {
    const content = await storage.read(calibrationPath);
    return JSON.parse(content);
  } catch {
    reply.code(404);
    return { error: 'Calibration data not found. Run --calibrate first.' };
  }
});

/**
 * Run threshold calibration on all existing experiment data
 */
fastify.post('/analysis/calibrate', async (request, reply) => {
  try {
    const calibrator = new ThresholdCalibrator(storage);
    await calibrator.calibrate();
    const content = await storage.read('data/analysis/threshold_calibration.json');
    return JSON.parse(content);
  } catch (error) {
    reply.code(500);
    return { error: error instanceof Error ? error.message : 'Calibration failed' };
  }
});

/**
 * Get human baseline analysis
 */
fastify.get('/analysis/human', async (request, reply) => {
  const humanPath = 'data/analysis/human_baseline.json';

  try {
    const content = await storage.read(humanPath);
    return JSON.parse(content);
  } catch {
    reply.code(404);
    return { error: 'Human baseline data not found. Collect human data first.' };
  }
});

/**
 * Get API call logs for an experiment
 */
fastify.get<{
  Params: { experimentId: string };
  Querystring: { limit?: number; offset?: number };
}>('/results/:experimentId/logs', async (request, reply) => {
  const { experimentId } = request.params;
  const { limit = 100, offset = 0 } = request.query;

  const logPath = join('data/results', experimentId, 'logs', 'api_calls.jsonl');

  try {
    const content = await storage.read(logPath);
    const lines = content.trim().split('\n').filter(Boolean);
    const logs = lines.map((line) => JSON.parse(line));

    const paginated = logs.slice(offset, offset + limit);

    return {
      logs: paginated,
      total: logs.length,
      offset,
      limit,
    };
  } catch {
    reply.code(404);
    return { error: 'Logs not found' };
  }
});

// ─── Human Baseline Endpoints ───

/**
 * Submit a human baseline grid (called from human-baseline app)
 */
fastify.post<{
  Body: {
    id: string;
    experimentId: string;
    model: string;
    persona: string;
    constructs: unknown[];
    timestamp: string;
    metadata: unknown;
  };
}>('/human-baseline/submit', async (request, reply) => {
  try {
    const grid = request.body;

    if (!grid || !grid.persona || !grid.constructs || !Array.isArray(grid.constructs)) {
      reply.code(400);
      return { error: 'Invalid grid data: requires persona and constructs array' };
    }

    const path = join('data', 'human_baselines', `${grid.persona}.json`);
    await storage.write(path, JSON.stringify(grid, null, 2));

    return {
      success: true,
      participantId: grid.persona,
      constructCount: grid.constructs.length,
    };
  } catch (error) {
    reply.code(500);
    return {
      error: error instanceof Error ? error.message : 'Failed to save human baseline grid',
    };
  }
});

/**
 * List all human baseline grids
 */
fastify.get('/human-baseline/grids', async (request, reply) => {
  const baseDir = join('data', 'human_baselines');

  try {
    const files = await storage.list(baseDir);
    const grids: unknown[] = [];

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const content = await storage.read(join(baseDir, file));
      grids.push(JSON.parse(content));
    }

    return { grids, count: grids.length };
  } catch {
    return { grids: [], count: 0 };
  }
});

// Start server
const start = async () => {
  const port = parseInt(process.env.PORT || '3001', 10);
  const host = process.env.HOST || '0.0.0.0';

  try {
    await fastify.listen({ port, host });
    console.log(`\n  RepGrid API Server`);
    console.log(`  http://${host}:${port}`);
    console.log(`\n  Endpoints:`);
    console.log(`    GET  /health                     - Health check`);
    console.log(`    GET  /config                     - Get configuration`);
    console.log(`    GET  /models                     - List available models`);
    console.log(`    POST /experiment/run             - Start experiment`);
    console.log(`    POST /experiment/:id/rerun       - Rerun with alt model`);
    console.log(`    GET  /experiment/status/:id      - Get experiment status`);
    console.log(`    GET  /experiments                - List all experiments`);
    console.log(`    DELETE /experiments/:id           - Delete an experiment`);
    console.log(`    GET  /results/:id                - Get experiment results`);
    console.log(`    GET  /results/:id/grids          - Get grids`);
    console.log(`    GET  /results/:id/logs           - Get API call logs`);
    console.log(`    GET  /results/:id/analysis       - Get all analysis`);
    console.log(`    GET  /results/:id/analysis/dimensionality - Dimensionality`);
    console.log(`    GET  /results/:id/analysis/cross-model    - Cross-model`);
    console.log(`    GET  /analysis/calibration       - Threshold calibration`);
    console.log(`    POST /analysis/calibrate          - Run calibration`);
    console.log(`    GET  /analysis/human             - Human baseline`);
    console.log(`    POST /human-baseline/submit      - Submit human grid`);
    console.log(`    GET  /human-baseline/grids       - List human grids`);
    console.log('');
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
