/**
 * Generalized Procrustes Analysis (GPA)
 * Aligns multiple grids to measure geometric stability
 *
 * GPA performs three transformations to align configurations:
 * 1. Translation - center to common origin
 * 2. Scaling - normalize to unit size
 * 3. Rotation - optimal rotation via SVD (Singular Value Decomposition)
 *
 * The Procrustes residual measures how much configurations differ
 * after optimal alignment - i.e., true geometric instability.
 */

import { Matrix, SingularValueDecomposition, determinant } from 'ml-matrix';
import type { Grid, ConstructCluster } from '../core/types.js';

export interface GridMatrix {
  gridId: string;
  condition: string;
  elements: string[];
  // Matrix: rows = elements, columns = constructs/dimensions
  data: number[][];
}

export interface GPAResult {
  // Aligned configurations for each grid
  alignedGrids: GridMatrix[];
  // Consensus (mean) configuration
  consensus: GridMatrix;
  // Procrustes residual (sum of squared distances from consensus)
  residual: number;
  // Per-grid residuals
  gridResiduals: Record<string, number>;
  // Scaling factors applied
  scalingFactors: Record<string, number>;
}

/**
 * Convert a Grid to a numeric matrix
 * Rows = elements, Columns = construct ratings
 */
export function gridToMatrix(grid: Grid, elementOrder: string[]): GridMatrix {
  const data: number[][] = [];

  for (const elementId of elementOrder) {
    const row: number[] = [];
    for (const construct of grid.constructs) {
      const rating = construct.ratings[elementId];
      if (rating === undefined || rating === null) {
        // Substitute midpoint for missing ratings (consistent with N/A handling per CLAUDE.md §3.4)
        console.warn(`Missing rating for element ${elementId} in construct ${construct.id} — substituting midpoint 5.5`);
        row.push(5.5);
      } else {
        row.push(rating);
      }
    }
    data.push(row);
  }

  return {
    gridId: grid.id,
    condition: `${grid.persona}_${grid.phrasing}`,
    elements: elementOrder,
    data,
  };
}

/**
 * Center a matrix (subtract column means)
 */
function centerMatrix(matrix: number[][]): number[][] {
  const nRows = matrix.length;
  const nCols = matrix[0]?.length || 0;

  // Calculate column means
  const colMeans = new Array(nCols).fill(0);
  for (let j = 0; j < nCols; j++) {
    for (let i = 0; i < nRows; i++) {
      colMeans[j] += matrix[i][j] / nRows;
    }
  }

  // Subtract means
  return matrix.map((row) =>
    row.map((val, j) => val - colMeans[j])
  );
}

/**
 * Calculate Frobenius norm of a matrix
 */
function frobeniusNorm(matrix: number[][]): number {
  let sum = 0;
  for (const row of matrix) {
    for (const val of row) {
      sum += val * val;
    }
  }
  return Math.sqrt(sum);
}

/**
 * Scale matrix to unit Frobenius norm
 */
function normalizeMatrix(matrix: number[][]): { normalized: number[][]; scale: number } {
  const norm = frobeniusNorm(matrix);
  if (norm === 0) return { normalized: matrix, scale: 1 };

  const normalized = matrix.map((row) => row.map((val) => val / norm));
  return { normalized, scale: norm };
}

/**
 * Matrix transpose
 */
function transpose(matrix: number[][]): number[][] {
  const nRows = matrix.length;
  const nCols = matrix[0]?.length || 0;
  const result: number[][] = [];

  for (let j = 0; j < nCols; j++) {
    result[j] = [];
    for (let i = 0; i < nRows; i++) {
      result[j][i] = matrix[i][j];
    }
  }

  return result;
}

/**
 * Matrix multiplication
 */
function matmul(A: number[][], B: number[][]): number[][] {
  const m = A.length;
  const n = B[0].length;
  const p = B.length;

  const result: number[][] = [];
  for (let i = 0; i < m; i++) {
    result[i] = [];
    for (let j = 0; j < n; j++) {
      let sum = 0;
      for (let k = 0; k < p; k++) {
        sum += A[i][k] * B[k][j];
      }
      result[i][j] = sum;
    }
  }

  return result;
}

/**
 * Calculate mean of multiple matrices
 */
function meanMatrix(matrices: number[][][]): number[][] {
  const n = matrices.length;
  const nRows = matrices[0].length;
  const nCols = matrices[0][0].length;

  const result: number[][] = [];
  for (let i = 0; i < nRows; i++) {
    result[i] = [];
    for (let j = 0; j < nCols; j++) {
      let sum = 0;
      for (let k = 0; k < n; k++) {
        sum += matrices[k][i][j];
      }
      result[i][j] = sum / n;
    }
  }

  return result;
}

/**
 * Calculate sum of squared differences between two matrices
 */
function sumSquaredDiff(A: number[][], B: number[][]): number {
  let sum = 0;
  for (let i = 0; i < A.length; i++) {
    for (let j = 0; j < A[i].length; j++) {
      const diff = A[i][j] - B[i][j];
      sum += diff * diff;
    }
  }
  return sum;
}

/**
 * Procrustes rotation using SVD (Singular Value Decomposition)
 *
 * Given target Y and source X, find optimal rotation matrix R that minimizes
 * ||Y - X*R||² (Frobenius norm of difference).
 *
 * Solution: R = V * U^T where SVD(X^T * Y) = U * S * V^T
 *
 * This ensures rotation invariance - two identical configurations that differ
 * only by rotation will have zero residual after alignment.
 */
function procrustesRotation(target: number[][], source: number[][]): number[][] {
  const Y = new Matrix(target);
  const X = new Matrix(source);

  // Handle dimension mismatch by padding with zeros if necessary
  const rowsX = X.rows;
  const colsX = X.columns;
  const rowsY = Y.rows;
  const colsY = Y.columns;

  // Ensure matrices have compatible dimensions for rotation
  if (rowsX !== rowsY) {
    throw new Error(`Row mismatch: source has ${rowsX} rows, target has ${rowsY} rows`);
  }

  // If column counts differ, we can't rotate - just return source
  if (colsX !== colsY) {
    console.warn(`Column mismatch in Procrustes rotation: ${colsX} vs ${colsY}. Skipping rotation.`);
    return source;
  }

  // M = X^T * Y
  const M = X.transpose().mmul(Y);

  // SVD of M: M = U * S * V^T
  const svd = new SingularValueDecomposition(M);
  const U = svd.leftSingularVectors;
  const V = svd.rightSingularVectors;

  // Optimal rotation: R = V * U^T
  // For M = X^T Y with SVD(M) = U S V^T, the optimal rotation minimizing
  // ||X R - Y||² is R = V * U^T (standard orthogonal Procrustes solution)
  const R = V.mmul(U.transpose());

  // Check for reflection (det(R) = -1) and correct if necessary
  // A proper rotation should have det(R) = +1
  const det = determinant(R);
  let rotationMatrix = R;

  if (det < 0) {
    // Flip sign of last column of V to get a proper rotation
    const Vcorrected = V.clone();
    const lastCol = V.columns - 1;
    for (let i = 0; i < V.rows; i++) {
      Vcorrected.set(i, lastCol, -V.get(i, lastCol));
    }
    rotationMatrix = Vcorrected.mmul(U.transpose());
  }

  // Apply rotation: X_rotated = X * R
  const rotated = X.mmul(rotationMatrix);
  return rotated.to2DArray();
}

/**
 * Run Generalized Procrustes Analysis on multiple grids
 */
export function runGPA(
  grids: Grid[],
  elementOrder: string[],
  maxIterations: number = 100,
  tolerance: number = 1e-6
): GPAResult {
  if (grids.length < 2) {
    throw new Error('GPA requires at least 2 grids');
  }

  // Convert grids to matrices
  const matrices = grids.map((g) => gridToMatrix(g, elementOrder));

  // Ensure all matrices have the same number of columns (constructs).
  // Grids may occasionally have fewer constructs (e.g., if an elicitation failed).
  // Pad shorter matrices with zero columns so GPA dimensions are consistent.
  const maxCols = Math.max(...matrices.map((m) => m.data[0]?.length || 0));
  for (const m of matrices) {
    const currentCols = m.data[0]?.length || 0;
    if (currentCols < maxCols) {
      m.data = m.data.map((row) => [...row, ...new Array(maxCols - currentCols).fill(0)]);
    }
  }

  // Step 1: Center all matrices
  let centered = matrices.map((m) => ({
    ...m,
    data: centerMatrix(m.data),
  }));

  // Step 2: Normalize (scale to unit norm)
  const scalingFactors: Record<string, number> = {};
  centered = centered.map((m) => {
    const { normalized, scale } = normalizeMatrix(m.data);
    scalingFactors[m.gridId] = scale;
    return { ...m, data: normalized };
  });

  // Step 3: Iterative Procrustes alignment
  let prevResidual = Infinity;
  let consensus = meanMatrix(centered.map((m) => m.data));

  for (let iter = 0; iter < maxIterations; iter++) {
    // Rotate each matrix towards consensus
    const rotated = centered.map((m) => ({
      ...m,
      data: procrustesRotation(consensus, m.data),
    }));

    // Update consensus
    consensus = meanMatrix(rotated.map((m) => m.data));

    // Calculate total residual
    let totalResidual = 0;
    for (const m of rotated) {
      totalResidual += sumSquaredDiff(m.data, consensus);
    }

    // Check convergence
    if (Math.abs(prevResidual - totalResidual) < tolerance) {
      break;
    }
    prevResidual = totalResidual;
    centered = rotated;
  }

  // Calculate final per-grid residuals
  const gridResiduals: Record<string, number> = {};
  let totalResidual = 0;
  for (const m of centered) {
    const residual = sumSquaredDiff(m.data, consensus);
    gridResiduals[m.gridId] = residual;
    totalResidual += residual;
  }

  return {
    alignedGrids: centered,
    consensus: {
      gridId: 'consensus',
      condition: 'consensus',
      elements: elementOrder,
      data: consensus,
    },
    residual: totalResidual,
    gridResiduals,
    scalingFactors,
  };
}

/**
 * Calculate stability metrics from GPA results
 */
export function calculateStabilityFromGPA(gpaResult: GPAResult): {
  procrustesResidual: number;
  avgGridResidual: number;
  maxGridResidual: number;
  stabilityScore: number;
} {
  const residuals = Object.values(gpaResult.gridResiduals);
  const avgResidual = residuals.reduce((a, b) => a + b, 0) / residuals.length;
  const maxResidual = Math.max(...residuals);

  // Stability score: 1 - normalized residual (higher = more stable)
  // Normalize by number of grids and elements
  const nGrids = gpaResult.alignedGrids.length;
  const nElements = gpaResult.consensus.elements.length;
  const normalizedResidual = gpaResult.residual / (nGrids * nElements);
  const stabilityScore = Math.max(0, 1 - normalizedResidual);

  return {
    procrustesResidual: gpaResult.residual,
    avgGridResidual: avgResidual,
    maxGridResidual: maxResidual,
    stabilityScore,
  };
}

/**
 * Compare two conditions using GPA
 * Returns displacement score between conditions
 */
export function compareConditions(
  gridsA: Grid[],
  gridsB: Grid[],
  elementOrder: string[]
): {
  displacementScore: number;
  consensusA: GridMatrix;
  consensusB: GridMatrix;
} {
  // Run GPA separately on each condition
  const gpaA = runGPA(gridsA, elementOrder);
  const gpaB = runGPA(gridsB, elementOrder);

  // Calculate displacement between consensuses
  const displacementScore = Math.sqrt(
    sumSquaredDiff(gpaA.consensus.data, gpaB.consensus.data)
  );

  return {
    displacementScore,
    consensusA: gpaA.consensus,
    consensusB: gpaB.consensus,
  };
}
