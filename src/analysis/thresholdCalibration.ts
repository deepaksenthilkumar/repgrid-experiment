/**
 * Threshold Calibration
 *
 * Analyzes existing experiment data to find the optimal cosine similarity
 * threshold for construct clustering. The current 0.8 threshold is arbitrary;
 * this module finds the empirical bimodal valley in the similarity distribution.
 *
 * Also runs sensitivity analysis: how do GPA results change at different thresholds?
 */

import { join } from 'path';
import { VoyageClient } from '../clients/voyage.js';
import type { StorageAdapter } from '../services/storage.js';
import type { GridLog, Grid, Construct, ExperimentManifest } from '../core/types.js';
import { runGPA, calculateStabilityFromGPA } from './gpa.js';
import { calculateRandomBaseline } from './baseline.js';

interface ExperimentGridData {
  gridLogs: GridLog[];
  elementOrder: string[];
}

export interface SimilarityDistribution {
  bins: number[];
  counts: number[];
  binWidth: number;
  totalPairs: number;
  mean: number;
  std: number;
  median: number;
}

export interface SensitivityResult {
  threshold: number;
  procrustesResidual: number;
  stabilityScore: number;
  matchedConstructs: number;
  totalConstructs: number;
  matchRatio: number;
}

export interface CalibrationResult {
  timestamp: string;
  experimentsAnalyzed: number;
  totalConstructPairs: number;
  similarityDistribution: SimilarityDistribution;
  suggestedThreshold: number;
  bimodalValleyEstimate: number | null;
  sensitivityAnalysis: SensitivityResult[];
  randomBaseline: {
    residualMedian: number;
    residual5th: number;
    residual95th: number;
  } | null;
}

interface ConstructPair {
  embedding: number[];
  label: string;
  gridId: string;
  experimentId: string;
}

/**
 * Calculate cosine similarity between two vectors
 */
function cosineSimilarity(a: number[], b: number[]): number {
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

export class ThresholdCalibrator {
  private resultsDir: string;
  private storage: StorageAdapter;

  constructor(storage: StorageAdapter, resultsDir: string = 'data/results') {
    this.storage = storage;
    this.resultsDir = resultsDir;
  }

  /**
   * Load all construct embeddings from all experiments
   */
  private async loadAllConstructs(): Promise<ConstructPair[]> {
    const constructs: ConstructPair[] = [];
    let experimentDirs: string[];

    try {
      experimentDirs = await this.storage.list(this.resultsDir);
    } catch {
      console.log('No results directory found.');
      return constructs;
    }

    for (const dir of experimentDirs) {
      const gridsDir = join(this.resultsDir, dir, 'grids');
      let files: string[];

      try {
        files = await this.storage.list(gridsDir);
      } catch {
        continue;
      }

      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        try {
          const content = await this.storage.read(join(gridsDir, file));
          const grid: GridLog = JSON.parse(content);

          for (const construct of grid.constructs) {
            if (construct.embedding && construct.embedding.length > 0) {
              constructs.push({
                embedding: construct.embedding,
                label: `${construct.emergentPole} vs ${construct.contrastPole}`,
                gridId: grid.gridId,
                experimentId: dir,
              });
            }
          }
        } catch {
          // Skip invalid files
        }
      }
    }

    return constructs;
  }

  /**
   * Load all grid logs and element orderings grouped by experiment
   */
  private async loadAllGridData(): Promise<Map<string, ExperimentGridData>> {
    const data = new Map<string, ExperimentGridData>();
    let experimentDirs: string[];

    try {
      experimentDirs = await this.storage.list(this.resultsDir);
    } catch {
      return data;
    }

    for (const dir of experimentDirs) {
      // Load element order from manifest
      let elementOrder: string[];
      try {
        const manifestContent = await this.storage.read(join(this.resultsDir, dir, 'manifest.json'));
        const manifest: ExperimentManifest = JSON.parse(manifestContent);
        elementOrder = manifest.config.elements;
      } catch {
        continue; // Can't use this experiment without element order
      }

      // Load grid logs
      const gridsDir = join(this.resultsDir, dir, 'grids');
      let files: string[];
      try {
        files = await this.storage.list(gridsDir);
      } catch {
        continue;
      }

      const gridLogs: GridLog[] = [];
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const content = await this.storage.read(join(gridsDir, file));
          const grid: GridLog = JSON.parse(content);
          // Only include grids that have constructs with embeddings and ratings
          if (grid.constructs.some(c => c.embedding && c.embedding.length > 0 && Object.keys(c.ratings).length > 0)) {
            gridLogs.push(grid);
          }
        } catch {
          continue;
        }
      }

      if (gridLogs.length >= 2) {
        data.set(dir, { gridLogs, elementOrder });
      }
    }

    return data;
  }

  /**
   * Convert a GridLog to a Grid object for GPA, using only constructs in the given cluster indices
   */
  private static gridLogToGrid(gridLog: GridLog, constructIndices: number[]): Grid {
    const constructs: Construct[] = constructIndices.map(idx => {
      const cl = gridLog.constructs[idx];
      return {
        id: cl.id,
        emergentPole: cl.emergentPole,
        contrastPole: cl.contrastPole,
        similarPair: cl.similarPair,
        explanation: cl.explanation,
        ratings: cl.ratings,
        sourceTriad: cl.triad,
        embedding: cl.embedding,
      };
    });

    return {
      id: gridLog.gridId,
      experimentId: gridLog.experimentId,
      model: '',
      persona: gridLog.conditions.persona,
      phrasing: gridLog.conditions.phrasing as 'neutral' | 'dysphemistic' | 'euphemistic',
      constructs,
      timestamp: gridLog.timestamp,
      metadata: {
        phase: gridLog.conditions.phase,
        iteration: gridLog.conditions.iteration,
        condition: `${gridLog.conditions.persona}_${gridLog.conditions.phrasing}`,
      },
    };
  }

  /**
   * Compute full pairwise cosine similarity matrix and return distribution
   */
  private computeSimilarityDistribution(constructs: ConstructPair[]): {
    similarities: number[];
    distribution: SimilarityDistribution;
  } {
    const similarities: number[] = [];

    for (let i = 0; i < constructs.length; i++) {
      for (let j = i + 1; j < constructs.length; j++) {
        const sim = cosineSimilarity(constructs[i].embedding, constructs[j].embedding);
        similarities.push(sim);
      }
    }

    // Create histogram
    const binWidth = 0.02;
    const numBins = Math.ceil(2.0 / binWidth); // Range -1 to 1
    const bins: number[] = [];
    const counts: number[] = new Array(numBins).fill(0);

    for (let i = 0; i < numBins; i++) {
      bins.push(-1.0 + i * binWidth);
    }

    for (const sim of similarities) {
      const binIndex = Math.min(
        Math.floor((sim + 1.0) / binWidth),
        numBins - 1
      );
      if (binIndex >= 0) counts[binIndex]++;
    }

    // Statistics
    const mean = similarities.reduce((a, b) => a + b, 0) / similarities.length;
    const variance = similarities.reduce((sum, s) => sum + (s - mean) ** 2, 0) / similarities.length;
    const sorted = [...similarities].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];

    return {
      similarities,
      distribution: {
        bins,
        counts,
        binWidth,
        totalPairs: similarities.length,
        mean,
        std: Math.sqrt(variance),
        median,
      },
    };
  }

  /**
   * Find bimodal valley using simple kernel density estimation
   * The valley between "same concept" and "different concept" peaks
   * indicates the optimal threshold.
   */
  private findBimodalValley(similarities: number[]): number | null {
    // Focus on the 0.3-1.0 range where we expect the bimodal split
    const bandwidth = 0.05;
    const evaluationPoints = 100;
    const start = 0.3;
    const end = 1.0;
    const step = (end - start) / evaluationPoints;

    const density: { x: number; y: number }[] = [];

    for (let i = 0; i <= evaluationPoints; i++) {
      const x = start + i * step;
      let y = 0;

      for (const sim of similarities) {
        // Gaussian kernel
        const u = (x - sim) / bandwidth;
        y += Math.exp(-0.5 * u * u) / (bandwidth * Math.sqrt(2 * Math.PI));
      }
      y /= similarities.length;

      density.push({ x, y });
    }

    // Find local minima (valleys) in the density curve
    const valleys: { x: number; y: number }[] = [];

    for (let i = 1; i < density.length - 1; i++) {
      if (density[i].y < density[i - 1].y && density[i].y < density[i + 1].y) {
        valleys.push(density[i]);
      }
    }

    if (valleys.length === 0) return null;

    // Return the valley closest to the 0.6-0.85 range (expected bimodal split)
    const targetRange = valleys.filter((v) => v.x >= 0.55 && v.x <= 0.9);
    if (targetRange.length > 0) {
      // Pick the deepest valley in range
      return targetRange.reduce((best, v) => (v.y < best.y ? v : best)).x;
    }

    // Fallback: deepest valley overall
    return valleys.reduce((best, v) => (v.y < best.y ? v : best)).x;
  }

  /**
   * Cluster constructs within a set of grid logs at a given threshold.
   * Returns indices of constructs that form clusters spanning multiple grids.
   * Each cluster becomes one "matched dimension" for GPA.
   *
   * Returns: array of clusters, where each cluster is an array of
   * { gridLogIndex, constructIndex } pairs.
   */
  private clusterConstructsAtThreshold(
    gridLogs: GridLog[],
    threshold: number
  ): Array<Array<{ gridLogIndex: number; constructIndex: number }>> {
    // Collect all constructs with embeddings
    const items: Array<{ gridLogIndex: number; constructIndex: number; embedding: number[] }> = [];
    for (let gi = 0; gi < gridLogs.length; gi++) {
      for (let ci = 0; ci < gridLogs[gi].constructs.length; ci++) {
        const c = gridLogs[gi].constructs[ci];
        if (c.embedding && c.embedding.length > 0) {
          items.push({ gridLogIndex: gi, constructIndex: ci, embedding: c.embedding });
        }
      }
    }

    // Greedy clustering (same approach as constructMatch.ts)
    const assigned = new Set<number>();
    const clusters: Array<Array<{ gridLogIndex: number; constructIndex: number }>> = [];

    for (let i = 0; i < items.length; i++) {
      if (assigned.has(i)) continue;
      const members = [i];
      assigned.add(i);

      for (let j = i + 1; j < items.length; j++) {
        if (assigned.has(j)) continue;
        // Check similarity to all current members
        let minSim = 1;
        for (const m of members) {
          minSim = Math.min(minSim, cosineSimilarity(items[m].embedding, items[j].embedding));
        }
        if (minSim >= threshold) {
          members.push(j);
          assigned.add(j);
        }
      }

      // Only keep clusters spanning multiple grids
      const gridIndicesInCluster = new Set(members.map(m => items[m].gridLogIndex));
      if (gridIndicesInCluster.size >= 2) {
        clusters.push(members.map(m => ({
          gridLogIndex: items[m].gridLogIndex,
          constructIndex: items[m].constructIndex,
        })));
      }
    }

    return clusters;
  }

  /**
   * Run sensitivity analysis: how do GPA metrics change at different thresholds?
   * For each threshold, clusters constructs by embedding similarity, builds
   * Grid objects from matched constructs, and runs GPA.
   */
  private runSensitivityAnalysis(
    constructs: ConstructPair[],
    similarities: number[],
    thresholds: number[],
    experimentGridData: Map<string, ExperimentGridData>
  ): SensitivityResult[] {
    const results: SensitivityResult[] = [];

    for (const threshold of thresholds) {
      const matchedPairs = similarities.filter((s) => s >= threshold).length;
      const totalPairs = similarities.length;

      // Aggregate GPA across experiments
      let totalResidual = 0;
      let totalStability = 0;
      let experimentCount = 0;
      let totalMatchedConstructs = 0;

      for (const [_expId, { gridLogs, elementOrder }] of experimentGridData) {
        // Cluster constructs at this threshold
        const clusters = this.clusterConstructsAtThreshold(gridLogs, threshold);
        if (clusters.length === 0) continue;

        // For each grid, find which construct indices are in clusters
        // Build a Grid with one construct per cluster (using the grid's representative)
        const gridConstructMap = new Map<number, number[]>(); // gridLogIndex → cluster indices
        for (let clusterIdx = 0; clusterIdx < clusters.length; clusterIdx++) {
          for (const { gridLogIndex } of clusters[clusterIdx]) {
            if (!gridConstructMap.has(gridLogIndex)) {
              gridConstructMap.set(gridLogIndex, []);
            }
            gridConstructMap.get(gridLogIndex)!.push(clusterIdx);
          }
        }

        // Only include grids that have ALL clusters represented
        const gridsWithAllClusters: number[] = [];
        for (const [gridLogIndex, clusterIndices] of gridConstructMap) {
          if (new Set(clusterIndices).size === clusters.length) {
            gridsWithAllClusters.push(gridLogIndex);
          }
        }

        if (gridsWithAllClusters.length < 2) continue;

        // Build Grid objects: for each qualifying grid, pick one construct per cluster
        const grids: Grid[] = [];
        for (const gridLogIndex of gridsWithAllClusters) {
          const constructIndices: number[] = [];
          for (const cluster of clusters) {
            // Find this grid's construct in this cluster
            const entry = cluster.find(e => e.gridLogIndex === gridLogIndex);
            if (entry) constructIndices.push(entry.constructIndex);
          }
          try {
            grids.push(ThresholdCalibrator.gridLogToGrid(gridLogs[gridLogIndex], constructIndices));
          } catch {
            continue;
          }
        }

        if (grids.length < 2) continue;

        // Run GPA
        try {
          const gpaResult = runGPA(grids, elementOrder);
          const stability = calculateStabilityFromGPA(gpaResult);
          totalResidual += stability.procrustesResidual;
          totalStability += stability.stabilityScore;
          totalMatchedConstructs += clusters.length;
          experimentCount++;
        } catch {
          // GPA can fail if matrices are degenerate
          continue;
        }
      }

      results.push({
        threshold,
        procrustesResidual: experimentCount > 0 ? totalResidual / experimentCount : 0,
        stabilityScore: experimentCount > 0 ? totalStability / experimentCount : 0,
        matchedConstructs: totalMatchedConstructs,
        totalConstructs: constructs.length,
        matchRatio: totalPairs > 0 ? matchedPairs / totalPairs : 0,
      });
    }

    return results;
  }

  /**
   * Run full calibration against all existing experiment data
   */
  async calibrate(): Promise<CalibrationResult> {
    console.log('\n=== Threshold Calibration ===\n');

    // Load all constructs with embeddings
    const constructs = await this.loadAllConstructs();
    console.log(`Loaded ${constructs.length} constructs with embeddings`);

    if (constructs.length < 10) {
      throw new Error(
        `Insufficient data for calibration: ${constructs.length} constructs (need at least 10). ` +
        'Run more experiments first.'
      );
    }

    // Compute similarity distribution
    console.log('Computing pairwise similarities...');
    const { similarities, distribution } = this.computeSimilarityDistribution(constructs);
    console.log(`  Total pairs: ${distribution.totalPairs}`);
    console.log(`  Mean similarity: ${distribution.mean.toFixed(4)}`);
    console.log(`  Std deviation: ${distribution.std.toFixed(4)}`);
    console.log(`  Median: ${distribution.median.toFixed(4)}`);

    // Find bimodal valley
    console.log('\nSearching for bimodal valley...');
    const valley = this.findBimodalValley(similarities);
    if (valley) {
      console.log(`  Bimodal valley found at: ${valley.toFixed(3)}`);
    } else {
      console.log('  No clear bimodal valley detected');
    }

    // Load full grid data for GPA-based sensitivity analysis
    console.log('\nLoading grid data for GPA analysis...');
    const experimentGridData = await this.loadAllGridData();
    console.log(`  Loaded grid data from ${experimentGridData.size} experiments`);

    // Sensitivity analysis
    const thresholds = [0.65, 0.70, 0.75, 0.80, 0.85, 0.90];
    console.log('\nRunning sensitivity analysis...');
    const sensitivity = this.runSensitivityAnalysis(constructs, similarities, thresholds, experimentGridData);

    for (const result of sensitivity) {
      console.log(
        `  Threshold ${result.threshold.toFixed(2)}: ` +
        `${result.matchedConstructs} matched constructs, ` +
        `residual=${result.procrustesResidual.toFixed(4)}, ` +
        `stability=${result.stabilityScore.toFixed(4)}, ` +
        `pair match ratio=${(result.matchRatio * 100).toFixed(1)}%`
      );
    }

    // Compute random baseline
    console.log('\nComputing random baseline...');
    let randomBaseline = null;
    try {
      // Get element IDs from first experiment
      const elementIds = [...new Set(
        constructs.flatMap((c) => {
          // Can't easily recover element IDs here, use a generic set
          return ['E01', 'E02', 'E04', 'E05', 'E07', 'E08', 'E09', 'E14', 'E16', 'E19', 'E21', 'E24'];
        })
      )];
      const baseline = calculateRandomBaseline(elementIds, 100, 10, 1);
      randomBaseline = {
        residualMedian: baseline.residual.percentile50,
        residual5th: baseline.residual.percentile5,
        residual95th: baseline.residual.percentile95,
      };
    } catch (error) {
      console.warn('  Random baseline computation failed:', error instanceof Error ? error.message : error);
    }

    // Determine suggested threshold
    const suggestedThreshold = valley || 0.80; // Default to 0.8 if no valley found

    const result: CalibrationResult = {
      timestamp: new Date().toISOString(),
      experimentsAnalyzed: new Set(constructs.map((c) => c.experimentId)).size,
      totalConstructPairs: distribution.totalPairs,
      similarityDistribution: distribution,
      suggestedThreshold,
      bimodalValleyEstimate: valley,
      sensitivityAnalysis: sensitivity,
      randomBaseline,
    };

    // Save results
    const outputPath = join('data/analysis', 'threshold_calibration.json');
    await this.storage.write(outputPath, JSON.stringify(result, null, 2));

    console.log(`\n=== Calibration Complete ===`);
    console.log(`Suggested threshold: ${suggestedThreshold.toFixed(3)}`);
    console.log(`Results saved to: data/analysis/threshold_calibration.json`);

    return result;
  }
}
