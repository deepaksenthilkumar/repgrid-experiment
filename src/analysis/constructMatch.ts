/**
 * Construct Matching via Embeddings
 * Clusters semantically similar constructs across grids before GPA alignment
 */

import { VoyageClient } from '../clients/voyage.js';
import type { Grid, Construct, ConstructCluster } from '../core/types.js';

export interface ConstructReference {
  constructId: string;
  gridId: string;
  emergentPole: string;
  contrastPole: string;
  ratings: Record<string, number>;
  embedding?: number[];
}

export interface ClusteringOptions {
  similarityThreshold: number;
  minClusterSize: number;
}

const DEFAULT_OPTIONS: ClusteringOptions = {
  similarityThreshold: 0.8,
  minClusterSize: 2,
};

export class ConstructMatcher {
  private voyageClient: VoyageClient;
  private options: ClusteringOptions;

  constructor(voyageClient: VoyageClient, options: Partial<ClusteringOptions> = {}) {
    this.voyageClient = voyageClient;
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Extract all constructs from multiple grids
   */
  extractConstructs(grids: Grid[]): ConstructReference[] {
    const constructs: ConstructReference[] = [];

    for (const grid of grids) {
      for (const construct of grid.constructs) {
        constructs.push({
          constructId: construct.id,
          gridId: grid.id,
          emergentPole: construct.emergentPole,
          contrastPole: construct.contrastPole,
          ratings: construct.ratings,
        });
      }
    }

    return constructs;
  }

  /**
   * Embed all constructs
   */
  async embedConstructs(
    constructs: ConstructReference[],
    metadata?: { phase: string; iteration: number }
  ): Promise<ConstructReference[]> {
    // Create embedding text for each construct
    const texts = constructs.map(
      (c) => `${c.emergentPole} versus ${c.contrastPole}`
    );

    // Batch embed
    const result = await this.voyageClient.embed(texts, {
      inputType: 'document',
      metadata,
    });

    // Attach embeddings to constructs
    return constructs.map((c, i) => ({
      ...c,
      embedding: result.embeddings[i],
    }));
  }

  /**
   * Calculate cosine similarity between two embeddings
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    return VoyageClient.cosineSimilarity(a, b);
  }

  /**
   * Cluster constructs by semantic similarity
   * Uses simple agglomerative clustering
   */
  clusterConstructs(constructs: ConstructReference[]): ConstructCluster[] {
    if (constructs.length === 0) return [];

    // Verify all constructs have embeddings
    const embeddedConstructs = constructs.filter((c) => c.embedding);
    if (embeddedConstructs.length !== constructs.length) {
      throw new Error('All constructs must have embeddings before clustering');
    }

    // Build similarity matrix
    const n = embeddedConstructs.length;
    const similarities: number[][] = [];
    for (let i = 0; i < n; i++) {
      similarities[i] = [];
      for (let j = 0; j < n; j++) {
        if (i === j) {
          similarities[i][j] = 1;
        } else if (j < i) {
          similarities[i][j] = similarities[j][i];
        } else {
          similarities[i][j] = this.cosineSimilarity(
            embeddedConstructs[i].embedding!,
            embeddedConstructs[j].embedding!
          );
        }
      }
    }

    // Simple greedy clustering
    const assigned = new Set<number>();
    const clusters: ConstructCluster[] = [];
    let clusterId = 0;

    for (let i = 0; i < n; i++) {
      if (assigned.has(i)) continue;

      // Start new cluster with this construct
      const clusterMembers: number[] = [i];
      assigned.add(i);

      // Find all constructs similar enough to add to cluster
      for (let j = i + 1; j < n; j++) {
        if (assigned.has(j)) continue;

        // Check if similar to all current cluster members
        let minSimilarity = 1;
        for (const member of clusterMembers) {
          minSimilarity = Math.min(minSimilarity, similarities[member][j]);
        }

        if (minSimilarity >= this.options.similarityThreshold) {
          clusterMembers.push(j);
          assigned.add(j);
        }
      }

      // Only create cluster if it meets minimum size
      if (clusterMembers.length >= this.options.minClusterSize) {
        // Calculate centroid embedding
        const dim = embeddedConstructs[0].embedding!.length;
        const centroid = new Array(dim).fill(0);
        for (const idx of clusterMembers) {
          const emb = embeddedConstructs[idx].embedding!;
          for (let d = 0; d < dim; d++) {
            centroid[d] += emb[d] / clusterMembers.length;
          }
        }

        // Calculate intra-cluster similarity
        let totalSim = 0;
        let count = 0;
        for (let a = 0; a < clusterMembers.length; a++) {
          for (let b = a + 1; b < clusterMembers.length; b++) {
            totalSim += similarities[clusterMembers[a]][clusterMembers[b]];
            count++;
          }
        }
        const intraClusterSimilarity = count > 0 ? totalSim / count : 1;

        clusters.push({
          clusterId: `cluster_${clusterId++}`,
          constructs: clusterMembers.map((idx) => ({
            constructId: embeddedConstructs[idx].constructId,
            gridId: embeddedConstructs[idx].gridId,
            emergentPole: embeddedConstructs[idx].emergentPole,
            contrastPole: embeddedConstructs[idx].contrastPole,
          })),
          centroidEmbedding: centroid,
          intraClusterSimilarity,
        });
      }
    }

    // Handle singletons (constructs not in any cluster)
    for (let i = 0; i < n; i++) {
      if (!assigned.has(i)) {
        // Create singleton cluster
        clusters.push({
          clusterId: `singleton_${clusterId++}`,
          constructs: [{
            constructId: embeddedConstructs[i].constructId,
            gridId: embeddedConstructs[i].gridId,
            emergentPole: embeddedConstructs[i].emergentPole,
            contrastPole: embeddedConstructs[i].contrastPole,
          }],
          centroidEmbedding: embeddedConstructs[i].embedding!,
          intraClusterSimilarity: 1,
        });
      }
    }

    return clusters;
  }

  /**
   * Full pipeline: extract, embed, and cluster constructs from grids
   */
  async matchConstructsFromGrids(
    grids: Grid[],
    metadata?: { phase: string; iteration: number }
  ): Promise<{
    constructs: ConstructReference[];
    clusters: ConstructCluster[];
    stats: {
      totalConstructs: number;
      totalClusters: number;
      avgClusterSize: number;
      avgIntraClusterSimilarity: number;
    };
  }> {
    // Extract
    const constructs = this.extractConstructs(grids);
    console.log(`  Extracted ${constructs.length} constructs from ${grids.length} grids`);

    // Embed
    const embeddedConstructs = await this.embedConstructs(constructs, metadata);
    console.log(`  Embedded ${embeddedConstructs.length} constructs`);

    // Cluster
    const clusters = this.clusterConstructs(embeddedConstructs);
    console.log(`  Created ${clusters.length} clusters`);

    // Calculate stats
    const avgClusterSize =
      clusters.length > 0
        ? clusters.reduce((sum, c) => sum + c.constructs.length, 0) / clusters.length
        : 0;
    const avgIntraClusterSimilarity =
      clusters.length > 0
        ? clusters.reduce((sum, c) => sum + c.intraClusterSimilarity, 0) / clusters.length
        : 0;

    return {
      constructs: embeddedConstructs,
      clusters,
      stats: {
        totalConstructs: constructs.length,
        totalClusters: clusters.length,
        avgClusterSize,
        avgIntraClusterSimilarity,
      },
    };
  }
}
