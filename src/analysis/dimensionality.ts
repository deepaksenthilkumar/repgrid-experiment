/**
 * Dimensionality Analysis
 * Estimates the number of unique ethical dimensions by clustering construct embeddings
 */

export interface ConstructWithEmbedding {
  id: string;
  emergentPole: string;
  contrastPole: string;
  embedding: number[];
  iteration?: number;
}

export interface DimensionalityResult {
  model: string;
  totalConstructs: number;
  uniqueDimensions: number;
  saturationCurve: number[];
  clusterSizes: number[];
  averageIntraClusterSimilarity: number;
  topDimensions: Array<{
    exemplar: string;
    size: number;
    members: string[];
  }>;
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
 * Cluster constructs by embedding similarity
 * Returns clusters with minimum size of 1 (singletons count as unique dimensions)
 */
function clusterConstructs(
  constructs: ConstructWithEmbedding[],
  threshold: number
): Array<{
  members: ConstructWithEmbedding[];
  centroid: number[];
  intraClusterSimilarity: number;
}> {
  if (constructs.length === 0) return [];

  // Build similarity matrix
  const n = constructs.length;
  const similarities: number[][] = [];
  for (let i = 0; i < n; i++) {
    similarities[i] = [];
    for (let j = 0; j < n; j++) {
      if (i === j) {
        similarities[i][j] = 1;
      } else if (j < i) {
        similarities[i][j] = similarities[j][i];
      } else {
        similarities[i][j] = cosineSimilarity(
          constructs[i].embedding,
          constructs[j].embedding
        );
      }
    }
  }

  // Greedy clustering (any construct can start a cluster)
  const assigned = new Set<number>();
  const clusters: Array<{
    members: ConstructWithEmbedding[];
    centroid: number[];
    intraClusterSimilarity: number;
  }> = [];

  for (let i = 0; i < n; i++) {
    if (assigned.has(i)) continue;

    // Start new cluster
    const memberIndices: number[] = [i];
    assigned.add(i);

    // Find all similar constructs
    for (let j = i + 1; j < n; j++) {
      if (assigned.has(j)) continue;

      // Check similarity to all current members
      let minSim = 1;
      for (const member of memberIndices) {
        minSim = Math.min(minSim, similarities[member][j]);
      }

      if (minSim >= threshold) {
        memberIndices.push(j);
        assigned.add(j);
      }
    }

    // Calculate centroid
    const dim = constructs[0].embedding.length;
    const centroid = new Array(dim).fill(0);
    for (const idx of memberIndices) {
      for (let d = 0; d < dim; d++) {
        centroid[d] += constructs[idx].embedding[d] / memberIndices.length;
      }
    }

    // Calculate intra-cluster similarity
    let totalSim = 0;
    let count = 0;
    for (let a = 0; a < memberIndices.length; a++) {
      for (let b = a + 1; b < memberIndices.length; b++) {
        totalSim += similarities[memberIndices[a]][memberIndices[b]];
        count++;
      }
    }

    clusters.push({
      members: memberIndices.map((idx) => constructs[idx]),
      centroid,
      intraClusterSimilarity: count > 0 ? totalSim / count : 1,
    });
  }

  return clusters;
}

/**
 * Calculate saturation curve - cumulative unique dimensions as constructs are added
 */
export function calculateSaturationCurve(
  constructs: ConstructWithEmbedding[],
  threshold: number = 0.8
): number[] {
  if (constructs.length === 0) return [];

  // Sort by iteration if available
  const sorted = [...constructs].sort((a, b) => (a.iteration || 0) - (b.iteration || 0));

  const curve: number[] = [];
  const seenCentroids: number[][] = [];

  for (let i = 0; i < sorted.length; i++) {
    const construct = sorted[i];

    // Check if this construct is similar to any seen centroid
    let isNew = true;
    for (const centroid of seenCentroids) {
      const sim = cosineSimilarity(construct.embedding, centroid);
      if (sim >= threshold) {
        isNew = false;
        break;
      }
    }

    if (isNew) {
      seenCentroids.push(construct.embedding);
    }

    curve.push(seenCentroids.length);
  }

  return curve;
}

/**
 * Estimate dimensionality of the ethical construct space
 */
export function estimateDimensionality(
  constructs: ConstructWithEmbedding[],
  model: string,
  threshold: number = 0.8
): DimensionalityResult {
  if (constructs.length === 0) {
    return {
      model,
      totalConstructs: 0,
      uniqueDimensions: 0,
      saturationCurve: [],
      clusterSizes: [],
      averageIntraClusterSimilarity: 0,
      topDimensions: [],
    };
  }

  // Cluster constructs
  const clusters = clusterConstructs(constructs, threshold);

  // Calculate statistics
  const clusterSizes = clusters.map((c) => c.members.length).sort((a, b) => b - a);
  const avgIntraClusterSim =
    clusters.reduce((sum, c) => sum + c.intraClusterSimilarity, 0) / clusters.length;

  // Get top dimensions with exemplars
  const topDimensions = clusters
    .sort((a, b) => b.members.length - a.members.length)
    .slice(0, 10)
    .map((cluster) => {
      // Find member closest to centroid as exemplar
      let bestIdx = 0;
      let bestSim = -1;
      for (let i = 0; i < cluster.members.length; i++) {
        const sim = cosineSimilarity(cluster.members[i].embedding, cluster.centroid);
        if (sim > bestSim) {
          bestSim = sim;
          bestIdx = i;
        }
      }
      const exemplar = cluster.members[bestIdx];

      return {
        exemplar: `${exemplar.emergentPole} vs ${exemplar.contrastPole}`,
        size: cluster.members.length,
        members: cluster.members.map((m) => `${m.emergentPole} vs ${m.contrastPole}`),
      };
    });

  // Calculate saturation curve
  const saturationCurve = calculateSaturationCurve(constructs, threshold);

  return {
    model,
    totalConstructs: constructs.length,
    uniqueDimensions: clusters.length,
    saturationCurve,
    clusterSizes,
    averageIntraClusterSimilarity: avgIntraClusterSim,
    topDimensions,
  };
}
