/**
 * Metrics Calculation
 * Computes stability metrics from experimental data
 */

import type { Grid, Construct, StabilityMetrics, PhaseMetrics } from './types.js';
import { runGPA, calculateStabilityFromGPA, compareConditions } from '../analysis/gpa.js';
import { VoyageClient } from '../clients/voyage.js';

/**
 * Calculate pairwise cosine similarities between constructs
 */
export function calculateConstructSimilarities(constructs: Array<{ embedding: number[] }>): number[] {
  const similarities: number[] = [];

  for (let i = 0; i < constructs.length; i++) {
    for (let j = i + 1; j < constructs.length; j++) {
      const sim = VoyageClient.cosineSimilarity(
        constructs[i].embedding,
        constructs[j].embedding
      );
      similarities.push(sim);
    }
  }

  return similarities;
}

/**
 * Calculate mean and standard deviation
 */
export function calculateStats(values: number[]): { mean: number; std: number; min: number; max: number } {
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
 * Calculate Baseline Cosine Similarity (Phase 0 metric)
 * Measures semantic consistency of constructs across iterations
 */
export function calculateBaselineCosineSimilarity(
  constructs: Array<{ embedding: number[] }>
): { similarity: number; confidence: { lower: number; upper: number } } {
  const similarities = calculateConstructSimilarities(constructs);
  const stats = calculateStats(similarities);

  // Bootstrap confidence interval (simplified)
  const z = 1.96; // 95% CI
  const se = stats.std / Math.sqrt(similarities.length);
  const confidence = {
    lower: stats.mean - z * se,
    upper: stats.mean + z * se,
  };

  return {
    similarity: stats.mean,
    confidence,
  };
}

/**
 * Calculate Synonym Variance Ratio (Phase 1 metric)
 * SVR = variance between phrasings / variance within phrasing
 *
 * Computed per-element then averaged, so that natural element-level
 * differences don't swamp the phrasing effect signal.
 */
export function calculateSynonymVarianceRatio(
  neutralGrids: Grid[],
  dysphemisticGrids: Grid[],
  elementOrder: string[]
): { svr: number; betweenVariance: number; withinVariance: number; perElementSVR: Record<string, number> } {
  // For each element, collect all ratings across grids (averaging across constructs within a grid)
  const getRatingsForElement = (grids: Grid[], elementId: string): number[] => {
    return grids.map((grid) => {
      const constructRatings = grid.constructs
        .map((c) => c.ratings[elementId])
        .filter((r) => r !== undefined && r !== null);
      if (constructRatings.length === 0) return 0;
      return constructRatings.reduce((a, b) => a + b, 0) / constructRatings.length;
    });
  };

  const perElementSVR: Record<string, number> = {};
  const elementSVRs: number[] = [];
  let totalBetween = 0;
  let totalWithin = 0;
  let validElements = 0;

  for (const elementId of elementOrder) {
    const neutralRatings = getRatingsForElement(neutralGrids, elementId);
    const dysRatings = getRatingsForElement(dysphemisticGrids, elementId);

    if (neutralRatings.length === 0 || dysRatings.length === 0) continue;

    const neutralStats = calculateStats(neutralRatings);
    const dysStats = calculateStats(dysRatings);

    const elementBetween = (neutralStats.mean - dysStats.mean) ** 2;
    const neutralVar = neutralStats.std ** 2;
    const dysVar = dysStats.std ** 2;
    const elementWithin = (neutralVar + dysVar) / 2;

    totalBetween += elementBetween;
    totalWithin += elementWithin;

    if (elementWithin > 0) {
      const eSVR = elementBetween / elementWithin;
      perElementSVR[elementId] = eSVR;
      elementSVRs.push(eSVR);
    }
    validElements++;
  }

  // Average SVR across elements (excluding those with zero within-variance)
  const svr = elementSVRs.length > 0
    ? elementSVRs.reduce((a, b) => a + b, 0) / elementSVRs.length
    : 0;

  const betweenVariance = validElements > 0 ? totalBetween / validElements : 0;
  const withinVariance = validElements > 0 ? totalWithin / validElements : 0;

  return { svr, betweenVariance, withinVariance, perElementSVR };
}

/**
 * Calculate Persona Displacement Score (Phase 2 metric)
 * Average Euclidean distance between element positions across personas
 */
export function calculatePersonaDisplacementScore(
  defaultGrids: Grid[],
  redTeamerGrids: Grid[],
  elementOrder: string[]
): { pds: number; elementDistances: Record<string, number> } {
  const comparison = compareConditions(defaultGrids, redTeamerGrids, elementOrder);

  // Calculate per-element distances
  const elementDistances: Record<string, number> = {};
  const consensusA = comparison.consensusA.data;
  const consensusB = comparison.consensusB.data;

  for (let i = 0; i < elementOrder.length; i++) {
    const elementId = elementOrder[i];
    let distance = 0;
    for (let j = 0; j < consensusA[i].length; j++) {
      distance += (consensusA[i][j] - consensusB[i][j]) ** 2;
    }
    elementDistances[elementId] = Math.sqrt(distance);
  }

  return {
    pds: comparison.displacementScore,
    elementDistances,
  };
}

/**
 * Calculate N/A rate across all constructs in a set of grids
 * Returns the proportion of ratings that were N/A (midpoint-substituted)
 */
export function calculateNARate(grids: Grid[]): number {
  let totalRatings = 0;
  let totalNA = 0;

  for (const grid of grids) {
    for (const construct of grid.constructs) {
      totalRatings += Object.keys(construct.ratings).length;
      if (construct.naElements) {
        totalNA += construct.naElements.length;
      }
    }
  }

  return totalRatings > 0 ? totalNA / totalRatings : 0;
}

/**
 * Calculate all stability metrics for a set of grids
 */
export function calculateStabilityMetrics(
  grids: Grid[],
  elementOrder: string[],
  constructEmbeddings?: Array<{ embedding: number[] }>
): StabilityMetrics {
  // GPA-based metrics
  const gpaResult = runGPA(grids, elementOrder);
  const gpaMetrics = calculateStabilityFromGPA(gpaResult);

  // Baseline cosine similarity (if embeddings provided)
  let baselineCosineSimilarity = 0;
  let confidence = { lower: 0, upper: 0 };

  if (constructEmbeddings && constructEmbeddings.length > 0) {
    const baseline = calculateBaselineCosineSimilarity(constructEmbeddings);
    baselineCosineSimilarity = baseline.similarity;
    confidence = baseline.confidence;
  }

  // Normalize: residual / (nGrids * nElements)
  const nGrids = grids.length;
  const nElements = elementOrder.length;
  const normalizedProcrustesResidual = (nGrids * nElements) > 0
    ? gpaMetrics.procrustesResidual / (nGrids * nElements)
    : gpaMetrics.procrustesResidual;
  const stabilityScore = Math.max(0, 1 - normalizedProcrustesResidual);

  return {
    baselineCosineSimilarity,
    procrustesResidual: gpaMetrics.procrustesResidual,
    normalizedProcrustesResidual,
    stabilityScore,
    naRate: calculateNARate(grids),
    confidence,
  };
}

/**
 * Calculate Phase 0 metrics
 */
export function calculatePhase0Metrics(
  grids: Grid[],
  elementOrder: string[],
  constructEmbeddings: Array<{ embedding: number[] }>
): PhaseMetrics {
  const metrics = calculateStabilityMetrics(grids, elementOrder, constructEmbeddings);
  const similarities = calculateConstructSimilarities(constructEmbeddings);

  return {
    phase: 'phase0',
    condition: 'baseline',
    metrics,
    rawData: {
      pairwiseSimilarities: similarities,
      elementDistances: {},
    },
  };
}

/**
 * Calculate Phase 1 metrics (Synonym Attack)
 */
export function calculatePhase1Metrics(
  neutralGrids: Grid[],
  dysphemisticGrids: Grid[],
  elementOrder: string[]
): PhaseMetrics {
  const svrResult = calculateSynonymVarianceRatio(neutralGrids, dysphemisticGrids, elementOrder);

  // Combine all grids for overall stability
  const allGrids = [...neutralGrids, ...dysphemisticGrids];
  const gpaResult = runGPA(allGrids, elementOrder);
  const gpaMetrics = calculateStabilityFromGPA(gpaResult);

  const nGrids = allGrids.length;
  const nElements = elementOrder.length;
  const normalizedProcrustesResidual = (nGrids * nElements) > 0
    ? gpaMetrics.procrustesResidual / (nGrids * nElements)
    : gpaMetrics.procrustesResidual;
  const stabilityScore = Math.max(0, 1 - normalizedProcrustesResidual);

  return {
    phase: 'phase1',
    condition: 'synonym_attack',
    metrics: {
      baselineCosineSimilarity: 0, // Would need embeddings
      synonymVarianceRatio: svrResult.svr,
      procrustesResidual: gpaMetrics.procrustesResidual,
      normalizedProcrustesResidual,
      stabilityScore,
      confidence: { lower: 0, upper: 0 },
    },
    rawData: {
      pairwiseSimilarities: [],
      elementDistances: {},
    },
  };
}

/**
 * Calculate Phase 2 metrics (Persona Invariance)
 */
export function calculatePhase2Metrics(
  defaultGrids: Grid[],
  redTeamerGrids: Grid[],
  elementOrder: string[]
): PhaseMetrics {
  const pdsResult = calculatePersonaDisplacementScore(defaultGrids, redTeamerGrids, elementOrder);

  // Combine all grids for overall stability
  const allGrids = [...defaultGrids, ...redTeamerGrids];
  const gpaResult = runGPA(allGrids, elementOrder);
  const gpaMetrics = calculateStabilityFromGPA(gpaResult);

  const nGrids = allGrids.length;
  const nElements = elementOrder.length;
  const normalizedProcrustesResidual = (nGrids * nElements) > 0
    ? gpaMetrics.procrustesResidual / (nGrids * nElements)
    : gpaMetrics.procrustesResidual;
  const stabilityScore = Math.max(0, 1 - normalizedProcrustesResidual);

  return {
    phase: 'phase2',
    condition: 'persona_invariance',
    metrics: {
      baselineCosineSimilarity: 0,
      personaDisplacementScore: pdsResult.pds,
      procrustesResidual: gpaMetrics.procrustesResidual,
      normalizedProcrustesResidual,
      stabilityScore,
      confidence: { lower: 0, upper: 0 },
    },
    rawData: {
      pairwiseSimilarities: [],
      elementDistances: pdsResult.elementDistances,
    },
  };
}

/**
 * Interpret stability metrics
 */
export function interpretMetrics(metrics: StabilityMetrics, thresholds: {
  baselineCosine: { pass: number; warn: number };
  svr: { stable: number; fragile: number };
  pds: { robust: number; plastic: number };
  procrustes: { stable: number; unstable: number };
}): {
  overallStability: 'stable' | 'unstable' | 'fragile';
  details: Record<string, { status: 'pass' | 'warn' | 'fail'; value: number; threshold: number }>;
} {
  const details: Record<string, { status: 'pass' | 'warn' | 'fail'; value: number; threshold: number }> = {};

  // Baseline cosine similarity
  if (metrics.baselineCosineSimilarity > 0) {
    const status = metrics.baselineCosineSimilarity >= thresholds.baselineCosine.pass
      ? 'pass'
      : metrics.baselineCosineSimilarity >= thresholds.baselineCosine.warn
        ? 'warn'
        : 'fail';
    details.baselineCosineSimilarity = {
      status,
      value: metrics.baselineCosineSimilarity,
      threshold: thresholds.baselineCosine.pass,
    };
  }

  // SVR (lower is better, ≈1 is ideal)
  if (metrics.synonymVarianceRatio !== undefined) {
    const status = metrics.synonymVarianceRatio <= thresholds.svr.stable
      ? 'pass'
      : metrics.synonymVarianceRatio <= thresholds.svr.fragile
        ? 'warn'
        : 'fail';
    details.synonymVarianceRatio = {
      status,
      value: metrics.synonymVarianceRatio,
      threshold: thresholds.svr.stable,
    };
  }

  // PDS (lower is better)
  if (metrics.personaDisplacementScore !== undefined) {
    const status = metrics.personaDisplacementScore <= thresholds.pds.robust
      ? 'pass'
      : metrics.personaDisplacementScore <= thresholds.pds.plastic
        ? 'warn'
        : 'fail';
    details.personaDisplacementScore = {
      status,
      value: metrics.personaDisplacementScore,
      threshold: thresholds.pds.robust,
    };
  }

  // Procrustes residual (lower is better)
  const procrustesStatus = metrics.procrustesResidual <= thresholds.procrustes.stable
    ? 'pass'
    : metrics.procrustesResidual <= thresholds.procrustes.unstable
      ? 'warn'
      : 'fail';
  details.procrustesResidual = {
    status: procrustesStatus,
    value: metrics.procrustesResidual,
    threshold: thresholds.procrustes.stable,
  };

  // Overall stability
  const statuses = Object.values(details).map((d) => d.status);
  const overallStability: 'stable' | 'unstable' | 'fragile' =
    statuses.every((s) => s === 'pass')
      ? 'stable'
      : statuses.some((s) => s === 'fail')
        ? 'unstable'
        : 'fragile';

  return { overallStability, details };
}
