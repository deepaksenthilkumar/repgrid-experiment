/**
 * Human Baseline Analyzer
 *
 * Loads human-generated grids from the human-baseline survey app,
 * computes consistency metrics, and compares against model outputs.
 *
 * This establishes whether model consistency falls within or outside
 * the range of normal human variation in construct generation.
 */

import { join } from 'path';
import type { StorageAdapter } from '../services/storage.js';
import type { Grid } from '../core/types.js';
import { runGPA, calculateStabilityFromGPA } from './gpa.js';

export interface HumanGrid {
  participantId: string;
  timestamp: string;
  constructs: Array<{
    emergentPole: string;
    contrastPole: string;
    triad: [string, string, string];
    ratings: Record<string, number>;
  }>;
}

export interface HumanBaselineResult {
  participantCount: number;
  totalGrids: number;
  humanResiduals: number[];
  humanResidualMedian: number;
  humanResidualMean: number;
  humanResidualStd: number;
  humanResidual5th: number;
  humanResidual95th: number;
  modelComparison: {
    modelResidual: number;
    percentileInHumanDist: number;
    interpretation: string;
  } | null;
  modelResiduals: number[];
  timestamp: string;
}

function percentile(sortedArr: number[], p: number): number {
  if (sortedArr.length === 0) return 0;
  const index = (p / 100) * (sortedArr.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedArr[lower];
  return sortedArr[lower] + (sortedArr[upper] - sortedArr[lower]) * (index - lower);
}

export class HumanBaselineAnalyzer {
  private humanDataPath: string;
  private storage: StorageAdapter;

  constructor(storage: StorageAdapter, humanDataPath: string = 'data/human_baselines') {
    this.storage = storage;
    this.humanDataPath = humanDataPath;
  }

  /**
   * Load human grids from the export directory
   * Expects Grid-compatible JSON files from the human-baseline app
   */
  async loadHumanGrids(): Promise<Grid[]> {
    const grids: Grid[] = [];

    try {
      const files = await this.storage.list(this.humanDataPath);

      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        try {
          const content = await this.storage.read(join(this.humanDataPath, file));
          const data = JSON.parse(content);

          // Support both single grid and array of grids
          if (Array.isArray(data)) {
            grids.push(...data);
          } else if (data.constructs) {
            grids.push(data);
          }
        } catch {
          // Skip invalid files
        }
      }
    } catch {
      // Directory doesn't exist yet
    }

    return grids;
  }

  /**
   * Compute human consistency metrics using GPA
   */
  computeHumanConsistency(grids: Grid[], elements: string[]): number[] {
    if (grids.length < 3) {
      return [];
    }

    const residuals: number[] = [];

    // Compute GPA residual for subsets of human grids
    // Use bootstrap-like approach: sample subsets and compute residual
    const subsetSize = Math.min(grids.length, 10);
    const iterations = Math.min(50, Math.floor(grids.length / 2));

    for (let i = 0; i < iterations; i++) {
      // Random subset
      const shuffled = [...grids].sort(() => Math.random() - 0.5);
      const subset = shuffled.slice(0, subsetSize);

      try {
        const gpaResult = runGPA(subset, elements);
        const metrics = calculateStabilityFromGPA(gpaResult);
        residuals.push(metrics.procrustesResidual);
      } catch {
        // Skip failed iterations
      }
    }

    return residuals;
  }

  /**
   * Compare model consistency against human distribution
   */
  compareModelToHuman(
    modelResidual: number,
    humanResiduals: number[]
  ): {
    percentileInHumanDist: number;
    interpretation: string;
  } {
    if (humanResiduals.length === 0) {
      return {
        percentileInHumanDist: -1,
        interpretation: 'Insufficient human data for comparison',
      };
    }

    const belowCount = humanResiduals.filter((r) => r < modelResidual).length;
    const pctile = (belowCount / humanResiduals.length) * 100;

    let interpretation: string;
    if (pctile < 10) {
      interpretation = 'Model is MORE consistent than most humans - possibly over-constrained';
    } else if (pctile < 30) {
      interpretation = 'Model is more consistent than average human - within normal range';
    } else if (pctile < 70) {
      interpretation = 'Model consistency is typical of human variation';
    } else if (pctile < 90) {
      interpretation = 'Model is less consistent than average human - some instability';
    } else {
      interpretation = 'Model is LESS consistent than most humans - significant instability';
    }

    return { percentileInHumanDist: pctile, interpretation };
  }

  /**
   * Run full human baseline analysis and save results
   */
  async analyze(
    elements: string[],
    modelResidual?: number,
    modelResiduals?: number[]
  ): Promise<HumanBaselineResult> {
    console.log('\n=== Human Baseline Analysis ===\n');

    const grids = await this.loadHumanGrids();
    console.log(`Loaded ${grids.length} human grids`);

    if (grids.length < 3) {
      throw new Error(
        `Insufficient human data: ${grids.length} grids (need at least 3). ` +
        'Collect more data via the human-baseline survey app.'
      );
    }

    // Get unique participants
    const participants = new Set(grids.map((g) => g.persona || 'unknown'));

    // Compute human residuals
    const humanResiduals = this.computeHumanConsistency(grids, elements);
    const sorted = [...humanResiduals].sort((a, b) => a - b);

    const mean = humanResiduals.reduce((a, b) => a + b, 0) / humanResiduals.length;
    const variance = humanResiduals.reduce((sum, r) => sum + (r - mean) ** 2, 0) / humanResiduals.length;

    console.log(`Human residuals computed: ${humanResiduals.length} samples`);
    console.log(`  Mean: ${mean.toFixed(4)}`);
    console.log(`  Median: ${percentile(sorted, 50).toFixed(4)}`);

    // Compare model if residual provided
    let modelComparison = null;
    if (modelResidual !== undefined) {
      const comparison = this.compareModelToHuman(modelResidual, humanResiduals);
      modelComparison = {
        modelResidual,
        ...comparison,
      };
      console.log(`\nModel comparison: ${comparison.interpretation}`);
      console.log(`  Model at ${comparison.percentileInHumanDist.toFixed(1)}th percentile of human distribution`);
    }

    const result: HumanBaselineResult = {
      participantCount: participants.size,
      totalGrids: grids.length,
      humanResiduals,
      humanResidualMedian: percentile(sorted, 50),
      humanResidualMean: mean,
      humanResidualStd: Math.sqrt(variance),
      humanResidual5th: percentile(sorted, 5),
      humanResidual95th: percentile(sorted, 95),
      modelComparison,
      modelResiduals: modelResiduals || [],
      timestamp: new Date().toISOString(),
    };

    // Save results
    const outputPath = join('data/analysis', 'human_baseline.json');
    await this.storage.write(outputPath, JSON.stringify(result, null, 2));

    console.log(`\nResults saved to: data/analysis/human_baseline.json`);

    return result;
  }
}
