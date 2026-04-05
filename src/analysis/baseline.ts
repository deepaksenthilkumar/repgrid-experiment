/**
 * Random Baseline Generation
 *
 * Generates random grids to establish a null distribution for metrics.
 * Without this baseline, metrics like SVR=1.2 are uninterpretable -
 * we need to know what "random" looks like to judge if observed values
 * indicate stability or just noise.
 *
 * Usage:
 *   const baseline = await calculateRandomBaseline(elements, 100);
 *   // Now interpret real metrics relative to baseline
 *   if (observedResidual < baseline.percentile5) {
 *     // Significantly more stable than random
 *   }
 */

import { v4 as uuidv4 } from 'uuid';
import type { Grid, Construct, StabilityMetrics } from '../core/types.js';
import { runGPA, calculateStabilityFromGPA } from './gpa.js';

export interface RandomBaselineResult {
  // Procrustes residual distribution
  residual: {
    mean: number;
    std: number;
    min: number;
    max: number;
    percentile5: number;   // Values below this are "significantly stable"
    percentile25: number;
    percentile50: number;  // Median
    percentile75: number;
    percentile95: number;  // Values above this are "significantly unstable"
  };
  // Stability score distribution (1 - normalized residual)
  stabilityScore: {
    mean: number;
    std: number;
    percentile5: number;
    percentile50: number;
    percentile95: number;
  };
  // Raw data for plotting
  rawResiduals: number[];
  // Configuration used
  config: {
    numGrids: number;
    numConstructsPerGrid: number;
    numElements: number;
    numIterations: number;
  };
}

/**
 * Generate a single random grid with given structure
 */
export function generateRandomGrid(
  experimentId: string,
  elements: string[],
  numConstructs: number = 1,
  options: {
    persona?: string;
    phrasing?: 'neutral' | 'dysphemistic' | 'euphemistic';
    phase?: string;
    iteration?: number;
  } = {}
): Grid {
  const constructs: Construct[] = [];

  for (let i = 0; i < numConstructs; i++) {
    // Generate random ratings (1-10) for each element
    const ratings: Record<string, number> = {};
    for (const elementId of elements) {
      ratings[elementId] = Math.floor(Math.random() * 10) + 1;
    }

    // Select random triad
    const shuffled = [...elements].sort(() => Math.random() - 0.5);
    const triad: [string, string, string] = [shuffled[0], shuffled[1], shuffled[2]];

    constructs.push({
      id: uuidv4(),
      emergentPole: `RandomPoleA_${i}`,
      contrastPole: `RandomPoleB_${i}`,
      similarPair: [triad[0], triad[1]],
      explanation: 'Random baseline construct',
      ratings,
      sourceTriad: triad,
    });
  }

  return {
    id: uuidv4(),
    experimentId,
    model: 'random-baseline',
    persona: options.persona || 'random',
    phrasing: options.phrasing || 'neutral',
    constructs,
    timestamp: new Date().toISOString(),
    metadata: {
      phase: options.phase || 'baseline',
      iteration: options.iteration || 0,
      condition: 'random_baseline',
    },
  };
}

/**
 * Generate multiple random grids
 */
export function generateRandomGrids(
  experimentId: string,
  elements: string[],
  numGrids: number,
  numConstructsPerGrid: number = 1
): Grid[] {
  const grids: Grid[] = [];

  for (let i = 0; i < numGrids; i++) {
    grids.push(
      generateRandomGrid(experimentId, elements, numConstructsPerGrid, {
        iteration: i + 1,
      })
    );
  }

  return grids;
}

/**
 * Calculate percentile from sorted array
 */
function percentile(sortedArr: number[], p: number): number {
  if (sortedArr.length === 0) return 0;
  const index = (p / 100) * (sortedArr.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedArr[lower];
  return sortedArr[lower] + (sortedArr[upper] - sortedArr[lower]) * (index - lower);
}

/**
 * Calculate statistics from array of values
 */
function calculateStats(values: number[]): {
  mean: number;
  std: number;
  min: number;
  max: number;
} {
  if (values.length === 0) {
    return { mean: 0, std: 0, min: 0, max: 0 };
  }

  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, val) => sum + (val - mean) ** 2, 0) / values.length;
  const std = Math.sqrt(variance);
  const min = Math.min(...values);
  const max = Math.max(...values);

  return { mean, std, min, max };
}

/**
 * Calculate random baseline by running GPA on many sets of random grids
 *
 * @param elements - List of element IDs
 * @param numIterations - Number of GPA runs to perform (default: 100)
 * @param gridsPerIteration - Number of grids per GPA run (default: 10, matching pilot)
 * @param constructsPerGrid - Number of constructs per grid (default: 1)
 */
export function calculateRandomBaseline(
  elements: string[],
  numIterations: number = 100,
  gridsPerIteration: number = 10,
  constructsPerGrid: number = 1
): RandomBaselineResult {
  console.log(`\nCalculating random baseline...`);
  console.log(`  Iterations: ${numIterations}`);
  console.log(`  Grids per iteration: ${gridsPerIteration}`);
  console.log(`  Elements: ${elements.length}`);

  const experimentId = `random-baseline-${Date.now()}`;
  const residuals: number[] = [];
  const stabilityScores: number[] = [];

  for (let i = 0; i < numIterations; i++) {
    // Generate random grids for this iteration
    const grids = generateRandomGrids(
      experimentId,
      elements,
      gridsPerIteration,
      constructsPerGrid
    );

    try {
      // Run GPA on these random grids
      const gpaResult = runGPA(grids, elements);
      const metrics = calculateStabilityFromGPA(gpaResult);

      residuals.push(metrics.procrustesResidual);
      stabilityScores.push(metrics.stabilityScore);
    } catch (error) {
      // Skip failed iterations (e.g., degenerate matrices)
      console.warn(`  Iteration ${i + 1} failed:`, error instanceof Error ? error.message : error);
    }

    // Progress indicator
    if ((i + 1) % 10 === 0) {
      console.log(`  Completed ${i + 1}/${numIterations} iterations`);
    }
  }

  // Sort for percentile calculations
  const sortedResiduals = [...residuals].sort((a, b) => a - b);
  const sortedStability = [...stabilityScores].sort((a, b) => a - b);

  const residualStats = calculateStats(residuals);
  const stabilityStats = calculateStats(stabilityScores);

  const result: RandomBaselineResult = {
    residual: {
      ...residualStats,
      percentile5: percentile(sortedResiduals, 5),
      percentile25: percentile(sortedResiduals, 25),
      percentile50: percentile(sortedResiduals, 50),
      percentile75: percentile(sortedResiduals, 75),
      percentile95: percentile(sortedResiduals, 95),
    },
    stabilityScore: {
      mean: stabilityStats.mean,
      std: stabilityStats.std,
      percentile5: percentile(sortedStability, 5),
      percentile50: percentile(sortedStability, 50),
      percentile95: percentile(sortedStability, 95),
    },
    rawResiduals: residuals,
    config: {
      numGrids: gridsPerIteration,
      numConstructsPerGrid: constructsPerGrid,
      numElements: elements.length,
      numIterations,
    },
  };

  console.log(`\nRandom Baseline Results:`);
  console.log(`  Residual: mean=${result.residual.mean.toFixed(4)}, std=${result.residual.std.toFixed(4)}`);
  console.log(`  Residual 5th percentile: ${result.residual.percentile5.toFixed(4)} (values below = significantly stable)`);
  console.log(`  Residual 95th percentile: ${result.residual.percentile95.toFixed(4)} (values above = significantly unstable)`);

  return result;
}

/**
 * Interpret observed metrics against random baseline
 */
export function interpretAgainstBaseline(
  observedResidual: number,
  baseline: RandomBaselineResult
): {
  interpretation: 'significantly_stable' | 'stable' | 'neutral' | 'unstable' | 'significantly_unstable';
  percentileRank: number;
  description: string;
} {
  // Calculate percentile rank of observed value
  const belowCount = baseline.rawResiduals.filter((r) => r < observedResidual).length;
  const percentileRank = (belowCount / baseline.rawResiduals.length) * 100;

  let interpretation: 'significantly_stable' | 'stable' | 'neutral' | 'unstable' | 'significantly_unstable';
  let description: string;

  if (observedResidual < baseline.residual.percentile5) {
    interpretation = 'significantly_stable';
    description = `Residual (${observedResidual.toFixed(4)}) is below the 5th percentile of random baseline (${baseline.residual.percentile5.toFixed(4)}). The model shows significantly more geometric stability than random chance.`;
  } else if (observedResidual < baseline.residual.percentile25) {
    interpretation = 'stable';
    description = `Residual (${observedResidual.toFixed(4)}) is between 5th and 25th percentile. The model shows more stability than most random configurations.`;
  } else if (observedResidual < baseline.residual.percentile75) {
    interpretation = 'neutral';
    description = `Residual (${observedResidual.toFixed(4)}) is near the median of random baseline. Stability is indistinguishable from random.`;
  } else if (observedResidual < baseline.residual.percentile95) {
    interpretation = 'unstable';
    description = `Residual (${observedResidual.toFixed(4)}) is between 75th and 95th percentile. The model shows less stability than most random configurations.`;
  } else {
    interpretation = 'significantly_unstable';
    description = `Residual (${observedResidual.toFixed(4)}) is above the 95th percentile of random baseline (${baseline.residual.percentile95.toFixed(4)}). The model shows significantly less geometric stability than random chance - possible systematic instability.`;
  }

  return { interpretation, percentileRank, description };
}

/**
 * Compare two conditions against random baseline
 */
export function compareConditionsAgainstBaseline(
  displacementScore: number,
  baseline: RandomBaselineResult
): {
  interpretation: 'no_difference' | 'small_difference' | 'moderate_difference' | 'large_difference';
  description: string;
} {
  // Use standard deviations from mean as reference
  const zScore = (displacementScore - baseline.residual.mean) / baseline.residual.std;

  let interpretation: 'no_difference' | 'small_difference' | 'moderate_difference' | 'large_difference';
  let description: string;

  if (Math.abs(zScore) < 1) {
    interpretation = 'no_difference';
    description = `Displacement (${displacementScore.toFixed(4)}) is within 1 standard deviation of random baseline mean. Conditions are geometrically similar.`;
  } else if (Math.abs(zScore) < 2) {
    interpretation = 'small_difference';
    description = `Displacement (${displacementScore.toFixed(4)}) is 1-2 standard deviations from random baseline mean. Conditions show some geometric difference.`;
  } else if (Math.abs(zScore) < 3) {
    interpretation = 'moderate_difference';
    description = `Displacement (${displacementScore.toFixed(4)}) is 2-3 standard deviations from random baseline mean. Conditions show moderate geometric difference.`;
  } else {
    interpretation = 'large_difference';
    description = `Displacement (${displacementScore.toFixed(4)}) is >3 standard deviations from random baseline mean. Conditions show significant geometric difference - persona/phrasing substantially alters the model's ethical topology.`;
  }

  return { interpretation, description };
}
