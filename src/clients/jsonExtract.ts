/**
 * Robust JSON extraction from LLM responses
 * Handles markdown code fences, nested braces, and multiple JSON blocks
 */

/** Maximum input size to prevent DoS from extremely large LLM responses */
const MAX_INPUT_LENGTH = 1_000_000; // 1MB

/**
 * Extract and parse JSON from an LLM response string.
 *
 * Strategy:
 * 1. Strip markdown code fences (```json ... ``` or ``` ... ```)
 * 2. Find the outermost balanced JSON object using brace counting
 * 3. Parse and return
 *
 * Throws if no valid JSON object can be extracted.
 */
export function extractJSON<T>(content: string): T {
  if (content.length > MAX_INPUT_LENGTH) {
    throw new Error(`Response too large for JSON extraction (${content.length} chars, max ${MAX_INPUT_LENGTH})`);
  }
  // Step 1: Strip markdown code fences
  let cleaned = content;

  // Match ```json ... ``` or ``` ... ``` (with optional language tag)
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  // Step 2: Find the first balanced JSON object
  const startIdx = cleaned.indexOf('{');
  if (startIdx === -1) {
    throw new Error(`No JSON object found in response: ${content.slice(0, 200)}`);
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  let endIdx = -1;

  for (let i = startIdx; i < cleaned.length; i++) {
    const char = cleaned[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\' && inString) {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
  }

  if (endIdx === -1) {
    throw new Error(`Unbalanced braces in response: ${content.slice(0, 200)}`);
  }

  const jsonStr = cleaned.slice(startIdx, endIdx + 1);

  try {
    return JSON.parse(jsonStr) as T;
  } catch (error) {
    throw new Error(
      `Failed to parse JSON from response: ${jsonStr.slice(0, 200)}\nError: ${error instanceof Error ? error.message : 'Unknown'}`
    );
  }
}
