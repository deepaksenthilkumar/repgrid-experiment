/**
 * Recompute stability metrics for experiment JSON files.
 * Fixes experiments where metrics were silently lost due to missing ratings.
 *
 * Usage: npx tsx scripts/recompute-metrics.ts <path-to-json> [path-to-json...]
 *        npx tsx scripts/recompute-metrics.ts ./repGridAnalysis/v2/*.json
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import type { Grid, GridLog } from '../src/core/types.js';
import {
  calculatePhase0Metrics,
  calculatePhase1Metrics,
  calculatePhase2Metrics,
} from '../src/core/metrics.js';

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error('Usage: npx tsx scripts/recompute-metrics.ts <path-to-json> [...]');
  process.exit(1);
}

function gridLogToGrid(log: GridLog, model: string): Grid {
  return {
    id: log.gridId,
    experimentId: log.experimentId,
    model,
    persona: log.conditions.persona,
    phrasing: log.conditions.phrasing as 'neutral' | 'dysphemistic' | 'euphemistic',
    framing: log.conditions.framing,
    constructs: log.constructs.map(c => ({
      id: c.id,
      emergentPole: c.emergentPole,
      contrastPole: c.contrastPole,
      similarPair: c.similarPair || [c.triad[0], c.triad[1]],
      explanation: c.explanation,
      ratings: c.ratings,
      sourceTriad: c.triad,
      embedding: c.embedding,
      naElements: c.naElements,
    })),
    timestamp: log.timestamp,
    metadata: {
      phase: log.conditions.phase,
      iteration: log.conditions.iteration,
      condition: `${log.conditions.persona}_${log.conditions.phrasing}`,
    },
  };
}

for (const filePath of paths) {
  const absPath = resolve(filePath);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Processing: ${filePath}`);
  console.log('='.repeat(60));

  let data: any;
  try {
    data = JSON.parse(readFileSync(absPath, 'utf8'));
  } catch (e) {
    console.error(`  Failed to read: ${e instanceof Error ? e.message : e}`);
    continue;
  }

  const gridLogs: GridLog[] = data.grids;
  if (!gridLogs || gridLogs.length === 0) {
    console.error('  No grids found in file');
    continue;
  }

  const model = data.manifest?.config?.model || data.summary?.config?.model || 'unknown';
  console.log(`  Model: ${model}`);
  console.log(`  Total grids: ${gridLogs.length}`);

  // Get element order from first grid's ratings
  const elementOrder = Object.keys(gridLogs[0].constructs[0].ratings);
  console.log(`  Elements: ${elementOrder.length}`);

  // Convert all grids
  const allGrids = gridLogs.map(log => gridLogToGrid(log, model));

  // Group by phase
  const phase0Grids = allGrids.filter(g => g.metadata.phase === 'phase0');
  const phase1Grids = allGrids.filter(g => g.metadata.phase === 'phase1');
  const phase2Grids = allGrids.filter(g => g.metadata.phase === 'phase2');

  console.log(`  Phase 0: ${phase0Grids.length}, Phase 1: ${phase1Grids.length}, Phase 2: ${phase2Grids.length}`);

  // Check for missing ratings
  let missingCount = 0;
  for (const log of gridLogs) {
    for (const c of log.constructs) {
      const n = Object.keys(c.ratings).length;
      if (n < elementOrder.length) {
        missingCount++;
        console.log(`  WARNING: ${log.conditions.phase} iter=${log.conditions.iteration} persona=${log.conditions.persona} construct=${c.id} has ${n}/${elementOrder.length} ratings`);
      }
    }
  }
  if (missingCount === 0) {
    console.log('  No missing ratings found');
  } else {
    console.log(`  ${missingCount} constructs with missing ratings (will use midpoint 5.5 substitution)`);
  }

  // Ensure analysis.stability_metrics exists
  if (!data.analysis) data.analysis = {};
  const oldMetrics = data.analysis.stability_metrics || {};
  const newMetrics: Record<string, any> = {};
  const changes: string[] = [];

  // Phase 0
  if (phase0Grids.length >= 2) {
    try {
      const embeddings = phase0Grids.flatMap(g =>
        g.constructs.filter(c => c.embedding).map(c => ({ embedding: c.embedding! }))
      );
      const result = calculatePhase0Metrics(phase0Grids, elementOrder, embeddings);
      newMetrics.phase0 = result;
      if (!oldMetrics.phase0) {
        changes.push(`Phase 0: NEW (was missing)`);
      }
      console.log(`  Phase 0 - Residual: ${result.metrics.procrustesResidual.toFixed(4)}, Stability: ${result.metrics.stabilityScore?.toFixed(4)}`);
    } catch (e) {
      console.error(`  Phase 0 FAILED: ${e instanceof Error ? e.message : e}`);
    }
  }

  // Phase 1
  if (phase1Grids.length >= 2) {
    try {
      const neutralGrids = phase1Grids.filter(g => g.phrasing === 'neutral');
      const dysGrids = phase1Grids.filter(g => g.phrasing === 'dysphemistic');
      const euphGrids = phase1Grids.filter(g => g.phrasing === 'euphemistic');

      if (neutralGrids.length >= 2 && dysGrids.length >= 2) {
        const result = calculatePhase1Metrics(neutralGrids, dysGrids, elementOrder);
        newMetrics.phase1 = result;
        if (!oldMetrics.phase1) changes.push('Phase 1 (neutral vs dysphemistic): NEW (was missing)');
        console.log(`  Phase 1 - SVR: ${result.metrics.synonymVarianceRatio?.toFixed(4)}, Stability: ${result.metrics.stabilityScore?.toFixed(4)}`);
      }

      if (neutralGrids.length >= 2 && euphGrids.length >= 2) {
        const result = calculatePhase1Metrics(neutralGrids, euphGrids, elementOrder);
        newMetrics.phase1_euphemistic = result;
        if (!oldMetrics.phase1_euphemistic) changes.push('Phase 1 (neutral vs euphemistic): NEW (was missing)');
        console.log(`  Phase 1 euph - SVR: ${result.metrics.synonymVarianceRatio?.toFixed(4)}, Stability: ${result.metrics.stabilityScore?.toFixed(4)}`);
      }
    } catch (e) {
      console.error(`  Phase 1 FAILED: ${e instanceof Error ? e.message : e}`);
    }
  }

  // Phase 2 — compute PDS for each non-default persona
  if (phase2Grids.length >= 2) {
    const defaultGrids = phase2Grids.filter(g => g.persona === 'default');
    const nonDefaultPersonas = [...new Set(
      phase2Grids.filter(g => g.persona !== 'default').map(g => g.persona)
    )];

    for (const persona of nonDefaultPersonas) {
      const steeredGrids = phase2Grids.filter(g => g.persona === persona);
      if (defaultGrids.length < 2 || steeredGrids.length < 2) {
        console.log(`  Phase 2 (${persona}): skipped — default=${defaultGrids.length}, steered=${steeredGrids.length}`);
        continue;
      }

      try {
        const result = calculatePhase2Metrics(defaultGrids, steeredGrids, elementOrder);
        const key = `phase2_${persona}`;
        newMetrics[key] = result;
        // Also set phase2 for backwards compatibility (first persona)
        if (!newMetrics.phase2) newMetrics.phase2 = result;

        const wasPresent = oldMetrics[key] || (persona === nonDefaultPersonas[0] && oldMetrics.phase2);
        if (!wasPresent) changes.push(`Phase 2 (${persona}): NEW PDS=${result.metrics.personaDisplacementScore?.toFixed(4)} (was missing)`);
        console.log(`  Phase 2 (${persona}) - PDS: ${result.metrics.personaDisplacementScore?.toFixed(4)}, Stability: ${result.metrics.stabilityScore?.toFixed(4)}`);
      } catch (e) {
        console.error(`  Phase 2 (${persona}) FAILED: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  if (Object.keys(newMetrics).length === 0) {
    console.log('  No metrics computed — skipping file');
    continue;
  }

  // Merge: new metrics take precedence, but preserve any old keys we didn't recompute
  const merged = { ...oldMetrics, ...newMetrics };
  merged._recomputed = {
    timestamp: new Date().toISOString(),
    reason: 'Midpoint substitution for missing ratings (gridToMatrix fix)',
    changes,
  };

  data.analysis.stability_metrics = merged;

  // Write back (in-place)
  writeFileSync(absPath, JSON.stringify(data, null, 2));

  if (changes.length > 0) {
    console.log(`\n  FIXED:`);
    for (const c of changes) console.log(`    - ${c}`);
  } else {
    console.log(`\n  All metrics were already present — updated with recomputed values`);
  }
  console.log(`  Written to: ${absPath}`);
}

console.log('\nDone.');
