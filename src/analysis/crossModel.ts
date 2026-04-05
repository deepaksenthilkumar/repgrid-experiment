/**
 * Cross-Model Comparison Analysis
 * Compares constructs elicited by different LLM models on the same triads
 */

import {
  ConstructWithEmbedding,
  DimensionalityResult,
  estimateDimensionality,
  calculateSaturationCurve,
} from './dimensionality.js';

export interface StabilityMetric {
  metric: string;
  original: number;
  rerun: number;
  difference: number;
  interpretation: string;
}

export interface ElementStability {
  elementId: string;
  originalMeanRating: number;
  rerunMeanRating: number;
  originalVariance: number;
  rerunVariance: number;
  ratingDifference: number;
}

export interface CrossModelComparison {
  originalModel: string;
  rerunModel: string;

  // Per-model dimensionality
  originalDimensionality: DimensionalityResult;
  rerunDimensionality: DimensionalityResult;

  // Construct overlap analysis
  sharedDimensions: number;
  originalOnly: number;
  rerunOnly: number;
  overlapRatio: number;

  // Saturation curves
  saturationCurves: {
    original: number[];
    rerun: number[];
  };

  // Stability comparison
  stabilityMetrics: StabilityMetric[];

  // Element-level comparison
  elementStability: ElementStability[];

  // Summary statistics
  summary: {
    dimensionalityDifference: number;
    avgSaturationRateOriginal: number;
    avgSaturationRateRerun: number;
    constructConvergence: number;
  };
}

/**
 * Calculate cosine similarity between two vectors
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error('Vectors must have same length');
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
  return denominator === 0 ? 0 : dotProduct / denominator;
}

/**
 * Find clusters that overlap between two sets of constructs
 */
function findOverlappingClusters(
  originalConstructs: ConstructWithEmbedding[],
  rerunConstructs: ConstructWithEmbedding[],
  threshold: number = 0.8
): { shared: number; originalOnly: number; rerunOnly: number } {
  // Get centroids from each set
  const originalDim = estimateDimensionality(originalConstructs, 'original', threshold);
  const rerunDim = estimateDimensionality(rerunConstructs, 'rerun', threshold);

  // Find exemplar embeddings for each dimension
  const originalExemplars = originalDim.topDimensions.map((d) => {
    const exemplarStr = d.exemplar;
    const match = originalConstructs.find(
      (c) => `${c.emergentPole} vs ${c.contrastPole}` === exemplarStr
    );
    return match?.embedding || [];
  });

  const rerunExemplars = rerunDim.topDimensions.map((d) => {
    const exemplarStr = d.exemplar;
    const match = rerunConstructs.find(
      (c) => `${c.emergentPole} vs ${c.contrastPole}` === exemplarStr
    );
    return match?.embedding || [];
  });

  // Count overlapping dimensions
  const originalMatched = new Set<number>();
  const rerunMatched = new Set<number>();

  for (let i = 0; i < originalExemplars.length; i++) {
    if (originalExemplars[i].length === 0) continue;

    for (let j = 0; j < rerunExemplars.length; j++) {
      if (rerunExemplars[j].length === 0) continue;

      const sim = cosineSimilarity(originalExemplars[i], rerunExemplars[j]);
      if (sim >= threshold) {
        originalMatched.add(i);
        rerunMatched.add(j);
      }
    }
  }

  return {
    shared: originalMatched.size,
    originalOnly: originalDim.uniqueDimensions - originalMatched.size,
    rerunOnly: rerunDim.uniqueDimensions - rerunMatched.size,
  };
}

/**
 * Calculate average saturation rate (how quickly new dimensions are discovered)
 */
function calculateSaturationRate(curve: number[]): number {
  if (curve.length < 2) return 0;

  // Rate of discovery in early iterations vs late iterations
  const midpoint = Math.floor(curve.length / 2);
  const earlyGrowth = curve[midpoint] / (midpoint + 1);
  const lateGrowth = (curve[curve.length - 1] - curve[midpoint]) / (curve.length - midpoint);

  return earlyGrowth > 0 ? lateGrowth / earlyGrowth : 0;
}

/**
 * Calculate stability metrics from construct ratings
 */
function calculateStabilityMetrics(
  originalConstructs: ConstructWithEmbedding[],
  rerunConstructs: ConstructWithEmbedding[],
  threshold: number = 0.8
): StabilityMetric[] {
  const metrics: StabilityMetric[] = [];

  // Dimensionality stability
  const origDim = estimateDimensionality(originalConstructs, 'original', threshold);
  const rerunDim = estimateDimensionality(rerunConstructs, 'rerun', threshold);

  metrics.push({
    metric: 'Unique Dimensions',
    original: origDim.uniqueDimensions,
    rerun: rerunDim.uniqueDimensions,
    difference: rerunDim.uniqueDimensions - origDim.uniqueDimensions,
    interpretation:
      rerunDim.uniqueDimensions > origDim.uniqueDimensions
        ? 'Rerun model explores more ethical dimensions'
        : rerunDim.uniqueDimensions < origDim.uniqueDimensions
          ? 'Original model explores more ethical dimensions'
          : 'Models explore similar number of dimensions',
  });

  // Cluster coherence
  metrics.push({
    metric: 'Avg Intra-Cluster Similarity',
    original: origDim.averageIntraClusterSimilarity,
    rerun: rerunDim.averageIntraClusterSimilarity,
    difference: rerunDim.averageIntraClusterSimilarity - origDim.averageIntraClusterSimilarity,
    interpretation:
      origDim.averageIntraClusterSimilarity > rerunDim.averageIntraClusterSimilarity
        ? 'Original model produces more coherent construct clusters'
        : 'Rerun model produces more coherent construct clusters',
  });

  // Construct count
  metrics.push({
    metric: 'Total Constructs',
    original: origDim.totalConstructs,
    rerun: rerunDim.totalConstructs,
    difference: rerunDim.totalConstructs - origDim.totalConstructs,
    interpretation: 'Number of constructs elicited in each run',
  });

  // Saturation rates
  const origCurve = calculateSaturationCurve(originalConstructs, threshold);
  const rerunCurve = calculateSaturationCurve(rerunConstructs, threshold);
  const origRate = calculateSaturationRate(origCurve);
  const rerunRate = calculateSaturationRate(rerunCurve);

  metrics.push({
    metric: 'Saturation Rate',
    original: origRate,
    rerun: rerunRate,
    difference: rerunRate - origRate,
    interpretation:
      origRate < rerunRate
        ? 'Rerun model continues discovering new dimensions longer'
        : 'Original model continues discovering new dimensions longer',
  });

  return metrics;
}

/**
 * Compare constructs from two models
 */
export function compareModels(
  originalConstructs: ConstructWithEmbedding[],
  rerunConstructs: ConstructWithEmbedding[],
  originalModel: string,
  rerunModel: string,
  threshold: number = 0.8
): CrossModelComparison {
  // Get dimensionality for each model
  const originalDimensionality = estimateDimensionality(originalConstructs, originalModel, threshold);
  const rerunDimensionality = estimateDimensionality(rerunConstructs, rerunModel, threshold);

  // Calculate overlap
  const overlap = findOverlappingClusters(originalConstructs, rerunConstructs, threshold);

  // Calculate saturation curves
  const originalCurve = calculateSaturationCurve(originalConstructs, threshold);
  const rerunCurve = calculateSaturationCurve(rerunConstructs, threshold);

  // Calculate stability metrics
  const stabilityMetrics = calculateStabilityMetrics(originalConstructs, rerunConstructs, threshold);

  // Element stability (placeholder - needs rating data)
  const elementStability: ElementStability[] = [];

  // Calculate summary statistics
  const totalDimensions = originalDimensionality.uniqueDimensions + rerunDimensionality.uniqueDimensions;
  const overlapRatio = totalDimensions > 0 ? (overlap.shared * 2) / totalDimensions : 0;

  const summary = {
    dimensionalityDifference:
      rerunDimensionality.uniqueDimensions - originalDimensionality.uniqueDimensions,
    avgSaturationRateOriginal: calculateSaturationRate(originalCurve),
    avgSaturationRateRerun: calculateSaturationRate(rerunCurve),
    constructConvergence: overlapRatio,
  };

  return {
    originalModel,
    rerunModel,
    originalDimensionality,
    rerunDimensionality,
    sharedDimensions: overlap.shared,
    originalOnly: overlap.originalOnly,
    rerunOnly: overlap.rerunOnly,
    overlapRatio,
    saturationCurves: {
      original: originalCurve,
      rerun: rerunCurve,
    },
    stabilityMetrics,
    elementStability,
    summary,
  };
}

/**
 * Compare N models pairwise, returning a comparison matrix
 */
export function compareMultipleModels(
  modelsData: Array<{
    modelName: string;
    constructs: ConstructWithEmbedding[];
  }>,
  threshold: number = 0.8
): {
  models: string[];
  pairwiseComparisons: CrossModelComparison[];
  overlapMatrix: number[][];
  dimensionalitySummary: Array<{ model: string; uniqueDimensions: number }>;
} {
  const models = modelsData.map((m) => m.modelName);
  const pairwiseComparisons: CrossModelComparison[] = [];
  const overlapMatrix: number[][] = Array.from(
    { length: models.length },
    () => new Array(models.length).fill(1.0)
  );

  // Run pairwise comparisons
  for (let i = 0; i < modelsData.length; i++) {
    for (let j = i + 1; j < modelsData.length; j++) {
      const comparison = compareModels(
        modelsData[i].constructs,
        modelsData[j].constructs,
        modelsData[i].modelName,
        modelsData[j].modelName,
        threshold
      );
      pairwiseComparisons.push(comparison);
      overlapMatrix[i][j] = comparison.overlapRatio;
      overlapMatrix[j][i] = comparison.overlapRatio;
    }
  }

  // Dimensionality summary
  const dimensionalitySummary = modelsData.map((m) => ({
    model: m.modelName,
    uniqueDimensions: estimateDimensionality(m.constructs, m.modelName, threshold).uniqueDimensions,
  }));

  return { models, pairwiseComparisons, overlapMatrix, dimensionalitySummary };
}

/**
 * Generate a textual summary of the cross-model comparison
 */
export function generateComparisonSummary(comparison: CrossModelComparison): string {
  const lines: string[] = [];

  lines.push(`Cross-Model Comparison: ${comparison.originalModel} vs ${comparison.rerunModel}`);
  lines.push('='.repeat(60));
  lines.push('');

  lines.push('## Dimensionality Analysis');
  lines.push(`- Original model: ${comparison.originalDimensionality.uniqueDimensions} unique dimensions`);
  lines.push(`- Rerun model: ${comparison.rerunDimensionality.uniqueDimensions} unique dimensions`);
  lines.push(`- Shared dimensions: ${comparison.sharedDimensions}`);
  lines.push(`- Original-only: ${comparison.originalOnly}`);
  lines.push(`- Rerun-only: ${comparison.rerunOnly}`);
  lines.push(`- Overlap ratio: ${(comparison.overlapRatio * 100).toFixed(1)}%`);
  lines.push('');

  lines.push('## Stability Metrics');
  for (const metric of comparison.stabilityMetrics) {
    lines.push(`- ${metric.metric}:`);
    lines.push(`  - Original: ${metric.original.toFixed(3)}`);
    lines.push(`  - Rerun: ${metric.rerun.toFixed(3)}`);
    lines.push(`  - ${metric.interpretation}`);
  }
  lines.push('');

  lines.push('## Summary');
  if (comparison.summary.dimensionalityDifference > 0) {
    lines.push(
      `The ${comparison.rerunModel} model explored ${comparison.summary.dimensionalityDifference} more unique ethical dimensions.`
    );
  } else if (comparison.summary.dimensionalityDifference < 0) {
    lines.push(
      `The ${comparison.originalModel} model explored ${-comparison.summary.dimensionalityDifference} more unique ethical dimensions.`
    );
  } else {
    lines.push('Both models explored the same number of unique ethical dimensions.');
  }

  lines.push(
    `Construct convergence: ${(comparison.summary.constructConvergence * 100).toFixed(1)}% of dimensions are shared.`
  );

  return lines.join('\n');
}
