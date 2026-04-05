/**
 * Configuration Loader
 * Loads and validates YAML configuration files
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { parse } from 'yaml';
import type { Element, ElementPhrasing, Persona } from '../core/types.js';

export interface ElementsConfig {
  elements: Record<string, {
    label: string;
    description: string;
    pilot: boolean;
    dimensions?: string[];
  }>;
}

export interface SynonymsConfig {
  synonyms: Record<string, ElementPhrasing>;
}

export interface PersonasConfig {
  personas: Record<string, {
    id: string;
    label: string;
    description: string;
    pilot: boolean;
    systemPrompt: string;
  }>;
  reference_texts?: Record<string, {
    label: string;
    description: string;
    content: string;
  }>;
}

export interface FramingConfig {
  system: string;
  description: string;
}

export interface PromptsConfig {
  triadic_elicitation: {
    system: string;
    user: string;
  };
  rating: {
    system: string;
    user: string;
  };
  framings?: Record<string, FramingConfig>;
  synonym_generation: {
    system: string;
    user: string;
  };
  construct_validity: {
    system: string;
    user: string;
  };
  doctrinal_oracle: {
    system: string;
    user: string;
  };
}

export interface ExperimentConfigFile {
  experiment: {
    name: string;
    version: string;
    description: string;
  };
  models: {
    primary: {
      provider: string;
      model: string;
      temperature: number;
      maxTokens: number;
    };
    comparison?: Array<{
      provider: string;
      model: string;
      temperature: number;
      maxTokens: number;
    }>;
    registry?: Record<string, {
      provider: string;
      model: string;
      temperature?: number;
      maxTokens?: number;
      baseUrl?: string;
    }>;
  };
  embeddings: {
    provider: string;
    model: string;
    clusterThreshold: number;
    calibratedThreshold?: number | null;
    useCalibrated?: boolean;
  };
  evaluation_awareness?: {
    rotateFramings: boolean;
    framings: string[];
    defaultFraming: string;
  };
  sensitivity?: {
    enabled: boolean;
    temperatures: number[];
  };
  baselines?: {
    human?: {
      dataPath: string;
      minParticipants: number;
      enabled: boolean;
    };
  };
  pilot: {
    usePilotElements: boolean;
    elementCount: number;
    iterations: number;
    constructsPerGrid?: number;
    phrasings: string[];
    personas: string[];
  };
  full: {
    usePilotElements: boolean;
    elementCount: number;
    iterations: number;
    constructsPerGrid?: number;
    phrasings: string[];
    personas: string[];
  };
  phases: Record<string, {
    name: string;
    description: string;
    enabled: boolean;
    iterations?: number;
    persona?: string;
    phrasing?: string;
    phrasings?: string[];
    personas?: string[];
  }>;
  thresholds: Record<string, {
    pass?: number;
    warn?: number;
    stable?: number;
    fragile?: number;
    robust?: number;
    plastic?: number;
    unstable?: number;
    description: string;
  }>;
  logging: {
    logApiCalls: boolean;
    logGrids: boolean;
    logEmbeddings: boolean;
    outputDir: string;
  };
}

export interface TrivialElementsConfig {
  trivial_elements: Record<string, {
    label: string;
    description: string;
  }>;
}

export class ConfigLoader {
  private configDir: string;
  private elementsConfig: ElementsConfig | null = null;
  private synonymsConfig: SynonymsConfig | null = null;
  private personasConfig: PersonasConfig | null = null;
  private promptsConfig: PromptsConfig | null = null;
  private experimentConfig: ExperimentConfigFile | null = null;
  private trivialElementsConfig: TrivialElementsConfig | null = null;

  constructor(configDir: string = 'config') {
    this.configDir = configDir;
  }

  /**
   * Load all configuration files
   */
  async loadAll(): Promise<void> {
    await Promise.all([
      this.loadElements(),
      this.loadSynonyms(),
      this.loadPersonas(),
      this.loadPrompts(),
      this.loadExperiment(),
    ]);
  }

  /**
   * Load elements configuration
   */
  async loadElements(): Promise<ElementsConfig> {
    if (!this.elementsConfig) {
      const content = await readFile(join(this.configDir, 'elements.yaml'), 'utf-8');
      this.elementsConfig = parse(content) as ElementsConfig;
    }
    return this.elementsConfig;
  }

  /**
   * Load synonyms configuration
   */
  async loadSynonyms(): Promise<SynonymsConfig> {
    if (!this.synonymsConfig) {
      const content = await readFile(join(this.configDir, 'synonyms.yaml'), 'utf-8');
      this.synonymsConfig = parse(content) as SynonymsConfig;
    }
    return this.synonymsConfig;
  }

  /**
   * Load personas configuration
   */
  async loadPersonas(): Promise<PersonasConfig> {
    if (!this.personasConfig) {
      const content = await readFile(join(this.configDir, 'personas.yaml'), 'utf-8');
      this.personasConfig = parse(content) as PersonasConfig;
    }
    return this.personasConfig;
  }

  /**
   * Load prompts configuration
   */
  async loadPrompts(): Promise<PromptsConfig> {
    if (!this.promptsConfig) {
      const content = await readFile(join(this.configDir, 'prompts.yaml'), 'utf-8');
      this.promptsConfig = parse(content) as PromptsConfig;
    }
    return this.promptsConfig;
  }

  /**
   * Load experiment configuration
   */
  async loadExperiment(): Promise<ExperimentConfigFile> {
    if (!this.experimentConfig) {
      const content = await readFile(join(this.configDir, 'experiment.yaml'), 'utf-8');
      this.experimentConfig = parse(content) as ExperimentConfigFile;
    }
    return this.experimentConfig;
  }

  /**
   * Get elements for the experiment (pilot or full)
   */
  async getElements(pilotOnly: boolean = true): Promise<Element[]> {
    const config = await this.loadElements();
    return Object.entries(config.elements)
      .filter(([_, elem]) => !pilotOnly || elem.pilot)
      .map(([id, elem]) => ({
        id,
        label: elem.label,
        description: elem.description,
        pilot: elem.pilot,
        dimensions: elem.dimensions,
      }));
  }

  /**
   * Get element phrasings
   */
  async getElementPhrasing(elementId: string, phrasing: 'neutral' | 'dysphemistic' | 'euphemistic'): Promise<string> {
    const elementsConfig = await this.loadElements();
    const synonymsConfig = await this.loadSynonyms();

    const element = elementsConfig.elements[elementId];
    if (!element) {
      throw new Error(`Element not found: ${elementId}`);
    }

    // Neutral phrasing comes from elements.yaml
    if (phrasing === 'neutral') {
      return element.description;
    }

    // Other phrasings come from synonyms.yaml
    const synonyms = synonymsConfig.synonyms[elementId];
    if (!synonyms) {
      throw new Error(`Synonyms not found for element: ${elementId}`);
    }

    const phrasedText = synonyms[phrasing];
    if (!phrasedText) {
      throw new Error(`Phrasing '${phrasing}' not found for element: ${elementId}`);
    }

    return phrasedText;
  }

  /**
   * Get personas for the experiment (pilot or full)
   */
  async getPersonas(pilotOnly: boolean = true): Promise<Persona[]> {
    const config = await this.loadPersonas();
    return Object.entries(config.personas)
      .filter(([_, persona]) => !pilotOnly || persona.pilot)
      .map(([_, persona]) => ({
        id: persona.id,
        label: persona.label,
        description: persona.description,
        pilot: persona.pilot,
        systemPrompt: persona.systemPrompt,
      }));
  }

  /**
   * Get persona by ID
   */
  async getPersona(personaId: string): Promise<Persona> {
    const config = await this.loadPersonas();
    const persona = config.personas[personaId];
    if (!persona) {
      throw new Error(`Persona not found: ${personaId}`);
    }
    return {
      id: persona.id,
      label: persona.label,
      description: persona.description,
      pilot: persona.pilot,
      systemPrompt: persona.systemPrompt,
    };
  }

  /**
   * Get formatted triadic elicitation prompt
   */
  async getTriadicPrompt(scenarioA: string, scenarioB: string, scenarioC: string): Promise<{ system: string; user: string }> {
    const config = await this.loadPrompts();
    return {
      system: config.triadic_elicitation.system,
      user: config.triadic_elicitation.user
        .replace('{scenario_a}', scenarioA)
        .replace('{scenario_b}', scenarioB)
        .replace('{scenario_c}', scenarioC),
    };
  }

  /**
   * Get formatted rating prompt
   */
  async getRatingPrompt(poleA: string, poleB: string, elements: Array<{ id: string; description: string }>): Promise<{ system: string; user: string }> {
    const config = await this.loadPrompts();
    const elementsList = elements
      .map((e) => `${e.id}: ${e.description}`)
      .join('\n');

    return {
      system: config.rating.system,
      user: config.rating.user
        .replace('{pole_a}', poleA)
        .replace('{pole_b}', poleB)
        .replace('{elements_list}', elementsList),
    };
  }

  /**
   * Get framing system prompt by framing ID
   * Returns the framing's system prompt, or falls back to the default triadic system prompt
   */
  async getFramingSystemPrompt(framingId: string): Promise<string> {
    const config = await this.loadPrompts();
    const framing = config.framings?.[framingId];
    if (!framing) {
      // Fall back to default triadic system prompt
      return config.triadic_elicitation.system;
    }
    return framing.system;
  }

  /**
   * Load trivial elements for control experiments
   */
  async loadTrivialElements(): Promise<TrivialElementsConfig> {
    if (!this.trivialElementsConfig) {
      try {
        const content = await readFile(join(this.configDir, 'trivial_elements.yaml'), 'utf-8');
        this.trivialElementsConfig = parse(content) as TrivialElementsConfig;
      } catch {
        // Return empty config if file doesn't exist
        this.trivialElementsConfig = { trivial_elements: {} };
      }
    }
    return this.trivialElementsConfig;
  }

  /**
   * Get trivial elements as Element array
   */
  async getTrivialElements(): Promise<Element[]> {
    const config = await this.loadTrivialElements();
    return Object.entries(config.trivial_elements).map(([id, elem]) => ({
      id,
      label: elem.label,
      description: elem.description,
      pilot: true,
    }));
  }
}
