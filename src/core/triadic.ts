/**
 * Triadic Elicitation Logic
 * Core algorithm for generating constructs via triadic comparison
 */

import { v4 as uuidv4 } from 'uuid';
import type { LLMClient } from '../clients/llmClient.js';
import type { ConfigLoader } from '../services/config.js';
import { retryWithBackoff } from '../services/retry.js';
import type { Element, Construct, Grid, GridLog, ConstructLog } from './types.js';

export interface TriadSelectionStrategy {
  name: string;
  selectTriad(elements: Element[], previousTriads: [string, string, string][]): [Element, Element, Element];
}

/**
 * Random triad selection (default)
 */
export const randomTriadSelection: TriadSelectionStrategy = {
  name: 'random',
  selectTriad(elements: Element[], _previousTriads: [string, string, string][]): [Element, Element, Element] {
    if (elements.length < 3) {
      throw new Error('Need at least 3 elements for triadic elicitation');
    }

    // Fisher-Yates shuffle to select 3 random elements
    const shuffled = [...elements];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    return [shuffled[0], shuffled[1], shuffled[2]];
  },
};

/**
 * Diversified triad selection (tries to avoid repeating triads)
 */
export const diversifiedTriadSelection: TriadSelectionStrategy = {
  name: 'diversified',
  selectTriad(elements: Element[], previousTriads: [string, string, string][]): [Element, Element, Element] {
    if (elements.length < 3) {
      throw new Error('Need at least 3 elements for triadic elicitation');
    }

    // Create a set of previous triad signatures for quick lookup
    const previousSignatures = new Set(
      previousTriads.map((t) => [...t].sort().join(','))
    );

    // Try to find a new unique triad
    const maxAttempts = 100;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const shuffled = [...elements];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }

      const triad: [Element, Element, Element] = [shuffled[0], shuffled[1], shuffled[2]];
      const signature = [triad[0].id, triad[1].id, triad[2].id].sort().join(',');

      if (!previousSignatures.has(signature)) {
        return triad;
      }
    }

    // If we can't find a unique triad, return a random one
    return randomTriadSelection.selectTriad(elements, previousTriads);
  },
};

export interface ElicitationResult {
  construct_pole_a: string;
  construct_pole_b: string;
  similar_pair: [string, string];
  explanation: string;
}

export interface RawRatingResult {
  ratings: Record<string, number | string>;
}

export interface RatingResult {
  ratings: Record<string, number>;
  naElements: string[];  // Elements where model responded N/A (midpoint-substituted)
}

export class TriadicElicitor {
  private client: LLMClient;
  private config: ConfigLoader;
  private selectionStrategy: TriadSelectionStrategy;
  private apiDelayMs: number;

  constructor(
    client: LLMClient,
    config: ConfigLoader,
    selectionStrategy: TriadSelectionStrategy = diversifiedTriadSelection,
    apiDelaySeconds: number = 0
  ) {
    this.client = client;
    this.config = config;
    this.selectionStrategy = selectionStrategy;
    this.apiDelayMs = apiDelaySeconds * 1000;
  }

  private async maybeDelay(): Promise<void> {
    if (this.apiDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this.apiDelayMs));
    }
  }

  /**
   * Elicit a single construct from a triad
   */
  async elicitConstruct(
    triad: [Element, Element, Element],
    persona: string,
    phrasing: 'neutral' | 'dysphemistic' | 'euphemistic',
    metadata: { phase: string; iteration: number; framing?: string; temperature?: number }
  ): Promise<{ result: ElicitationResult; callId: string }> {
    // Get phrased descriptions
    const [scenarioA, scenarioB, scenarioC] = await Promise.all([
      this.config.getElementPhrasing(triad[0].id, phrasing),
      this.config.getElementPhrasing(triad[1].id, phrasing),
      this.config.getElementPhrasing(triad[2].id, phrasing),
    ]);

    // Get persona and prompts
    const personaConfig = await this.config.getPersona(persona);
    const prompts = await this.config.getTriadicPrompt(scenarioA, scenarioB, scenarioC);

    // Use framing system prompt if specified, otherwise use default triadic prompt
    const triadicSystemPrompt = metadata.framing
      ? await this.config.getFramingSystemPrompt(metadata.framing)
      : prompts.system;

    // Combine persona system prompt with triadic system prompt (skip empty persona for neutral baseline)
    const systemPrompt = personaConfig.systemPrompt?.trim()
      ? `${personaConfig.systemPrompt}\n\n${triadicSystemPrompt}`
      : triadicSystemPrompt;

    // Call LLM with retry for transient failures
    const { data, response } = await retryWithBackoff(
      () => this.client.sendMessageForJSON<ElicitationResult>(
        prompts.user,
        {
          systemPrompt,
          temperature: metadata.temperature,
          metadata: {
            phase: metadata.phase,
            iteration: metadata.iteration,
            persona,
            phrasing,
            triadElements: [triad[0].id, triad[1].id, triad[2].id],
            purpose: 'elicitation',
          },
        }
      ),
      {
        maxRetries: 3,
        onRetry: (error, attempt) => {
          console.warn(`[TriadicElicitor] Elicitation retry ${attempt}/3: ${error instanceof Error ? error.message : 'Unknown error'}`);
        },
      }
    );

    // Use the callId from the logger (threaded through the LLM response)
    const callId = response.callId || uuidv4();

    return { result: data, callId };
  }

  /**
   * Rate all elements on a construct
   */
  async rateElements(
    poleA: string,
    poleB: string,
    elements: Element[],
    persona: string,
    phrasing: 'neutral' | 'dysphemistic' | 'euphemistic',
    metadata: { phase: string; iteration: number; framing?: string; temperature?: number }
  ): Promise<{ result: RatingResult; callId: string }> {
    // Get phrased descriptions for all elements
    const phrasedElements = await Promise.all(
      elements.map(async (e) => ({
        id: e.id,
        description: await this.config.getElementPhrasing(e.id, phrasing),
      }))
    );

    // Randomize element order to reduce order effects
    const shuffled = [...phrasedElements].sort(() => Math.random() - 0.5);

    // Get persona and prompts
    const personaConfig = await this.config.getPersona(persona);
    const prompts = await this.config.getRatingPrompt(poleA, poleB, shuffled);

    // Combine persona system prompt with rating system prompt (skip empty persona for neutral baseline)
    const systemPrompt = personaConfig.systemPrompt?.trim()
      ? `${personaConfig.systemPrompt}\n\n${prompts.system}`
      : prompts.system;

    // Call LLM with retry — parse as RawRatingResult to handle N/A strings
    const { data: rawData, response } = await retryWithBackoff(
      () => this.client.sendMessageForJSON<RawRatingResult>(
        prompts.user,
        {
          systemPrompt,
          temperature: metadata.temperature,
          metadata: {
            phase: metadata.phase,
            iteration: metadata.iteration,
            persona,
            phrasing,
            purpose: 'rating',
          },
        }
      ),
      {
        maxRetries: 3,
        onRetry: (error, attempt) => {
          console.warn(`[TriadicElicitor] Rating retry ${attempt}/3: ${error instanceof Error ? error.message : 'Unknown error'}`);
        },
      }
    );

    // Process N/A values: substitute midpoint (5.5), track which elements were N/A
    const NA_MIDPOINT = 5.5;
    const naElements: string[] = [];
    const ratings: Record<string, number> = {};

    for (const [key, value] of Object.entries(rawData.ratings)) {
      if (typeof value === 'string' && value.toUpperCase().includes('N/A')) {
        ratings[key] = NA_MIDPOINT;
        naElements.push(key);
      } else {
        ratings[key] = Number(value);
      }
    }

    const result: RatingResult = { ratings, naElements };

    // Use the callId from the logger (threaded through the LLM response)
    const callId = response.callId || uuidv4();

    return { result, callId };
  }

  /**
   * Run a single iteration of triadic elicitation
   * Returns one construct with ratings
   */
  async runIteration(
    elements: Element[],
    persona: string,
    phrasing: 'neutral' | 'dysphemistic' | 'euphemistic',
    metadata: { phase: string; iteration: number; framing?: string; temperature?: number },
    previousTriads: [string, string, string][] = []
  ): Promise<{ construct: Construct; triad: [string, string, string]; elicitationCallId: string; ratingCallId: string }> {
    // Select a triad
    const triad = this.selectionStrategy.selectTriad(elements, previousTriads);
    const triadIds: [string, string, string] = [triad[0].id, triad[1].id, triad[2].id];

    // Elicit construct
    await this.maybeDelay();
    const { result: elicitationResult, callId: elicitationCallId } = await this.elicitConstruct(
      triad,
      persona,
      phrasing,
      metadata
    );

    // Rate all elements on this construct
    await this.maybeDelay();
    const { result: ratingResult, callId: ratingCallId } = await this.rateElements(
      elicitationResult.construct_pole_a,
      elicitationResult.construct_pole_b,
      elements,
      persona,
      phrasing,
      metadata
    );

    // Build construct
    const construct: Construct = {
      id: uuidv4(),
      emergentPole: elicitationResult.construct_pole_a,
      contrastPole: elicitationResult.construct_pole_b,
      similarPair: elicitationResult.similar_pair,
      explanation: elicitationResult.explanation,
      ratings: ratingResult.ratings,
      sourceTriad: triadIds,
      naElements: ratingResult.naElements.length > 0 ? ratingResult.naElements : undefined,
    };

    return { construct, triad: triadIds, elicitationCallId, ratingCallId };
  }

  /**
   * Generate a complete grid (multiple constructs)
   */
  async generateGrid(
    experimentId: string,
    elements: Element[],
    persona: string,
    phrasing: 'neutral' | 'dysphemistic' | 'euphemistic',
    metadata: { phase: string; iteration: number; framing?: string; temperature?: number },
    constructCount: number = 1
  ): Promise<{ grid: Grid; gridLog: GridLog }> {
    const gridId = uuidv4();
    const constructs: Construct[] = [];
    const constructLogs: ConstructLog[] = [];
    const previousTriads: [string, string, string][] = [];

    let failures = 0;
    for (let i = 0; i < constructCount; i++) {
      try {
        const { construct, triad, elicitationCallId, ratingCallId } = await this.runIteration(
          elements,
          persona,
          phrasing,
          metadata,
          previousTriads
        );

        constructs.push(construct);
        previousTriads.push(triad);

        constructLogs.push({
          id: construct.id,
          elicitationCallId,
          ratingCallId,
          triad,
          emergentPole: construct.emergentPole,
          contrastPole: construct.contrastPole,
          similarPair: construct.similarPair,
          explanation: construct.explanation,
          ratings: construct.ratings,
          naElements: construct.naElements,
        });
      } catch (error) {
        failures++;
        console.error(
          `[TriadicElicitor] Construct ${i + 1}/${constructCount} failed (${failures} total failures): ${error instanceof Error ? error.message.slice(0, 200) : 'Unknown error'}`
        );
        // Continue to next construct — don't crash the whole grid
      }
    }

    if (constructs.length === 0) {
      throw new Error(
        `All ${constructCount} construct(s) failed for grid generation (phase=${metadata.phase}, iteration=${metadata.iteration}, persona=${persona}, phrasing=${phrasing}). The model may be refusing to respond with JSON.`
      );
    }

    const timestamp = new Date().toISOString();

    const grid: Grid = {
      id: gridId,
      experimentId,
      model: this.client.getConfig().model,
      persona,
      phrasing,
      framing: metadata.framing,
      constructs,
      timestamp,
      metadata: {
        phase: metadata.phase,
        iteration: metadata.iteration,
        condition: `${persona}_${phrasing}`,
      },
    };

    const gridLog: GridLog = {
      gridId,
      experimentId,
      timestamp,
      conditions: {
        phase: metadata.phase,
        iteration: metadata.iteration,
        persona,
        phrasing,
        framing: metadata.framing,
      },
      constructs: constructLogs,
    };

    return { grid, gridLog };
  }

  /**
   * Generate a grid using a fixed triad (for controlled reruns)
   * This enables comparing model outputs with identical inputs
   */
  async generateGridWithFixedTriad(
    experimentId: string,
    elements: Element[],
    fixedTriadIds: [string, string, string],
    persona: string,
    phrasing: 'neutral' | 'dysphemistic' | 'euphemistic',
    metadata: { phase: string; iteration: number }
  ): Promise<{ grid: Grid; gridLog: GridLog }> {
    const gridId = uuidv4();

    // Find the elements for the fixed triad
    const triadElements: [Element, Element, Element] = [
      elements.find((e) => e.id === fixedTriadIds[0])!,
      elements.find((e) => e.id === fixedTriadIds[1])!,
      elements.find((e) => e.id === fixedTriadIds[2])!,
    ];

    if (triadElements.some((e) => !e)) {
      throw new Error(`Could not find all elements for triad: ${fixedTriadIds.join(', ')}`);
    }

    // Elicit construct using the fixed triad
    const { result: elicitationResult, callId: elicitationCallId } = await this.elicitConstruct(
      triadElements,
      persona,
      phrasing,
      metadata
    );

    // Rate all elements on this construct
    const { result: ratingResult, callId: ratingCallId } = await this.rateElements(
      elicitationResult.construct_pole_a,
      elicitationResult.construct_pole_b,
      elements,
      persona,
      phrasing,
      metadata
    );

    // Build construct
    const construct: Construct = {
      id: uuidv4(),
      emergentPole: elicitationResult.construct_pole_a,
      contrastPole: elicitationResult.construct_pole_b,
      similarPair: elicitationResult.similar_pair,
      explanation: elicitationResult.explanation,
      ratings: ratingResult.ratings,
      sourceTriad: fixedTriadIds,
    };

    const constructLog: ConstructLog = {
      id: construct.id,
      elicitationCallId,
      ratingCallId,
      triad: fixedTriadIds,
      emergentPole: construct.emergentPole,
      contrastPole: construct.contrastPole,
      similarPair: construct.similarPair,
      explanation: construct.explanation,
      ratings: construct.ratings,
    };

    const timestamp = new Date().toISOString();

    const grid: Grid = {
      id: gridId,
      experimentId,
      model: this.client.getConfig().model,
      persona,
      phrasing,
      constructs: [construct],
      timestamp,
      metadata: {
        phase: metadata.phase,
        iteration: metadata.iteration,
        condition: `${persona}_${phrasing}`,
      },
    };

    const gridLog: GridLog = {
      gridId,
      experimentId,
      timestamp,
      conditions: {
        phase: metadata.phase,
        iteration: metadata.iteration,
        persona,
        phrasing,
      },
      constructs: [constructLog],
    };

    return { grid, gridLog };
  }
}
