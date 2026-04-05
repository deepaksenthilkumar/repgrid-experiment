import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

/**
 * Export endpoint: receives survey results, formats as Grid JSON, and submits to backend
 * POST /api/export
 */
export async function POST(request: NextRequest) {
  try {
    const { results } = await request.json();

    if (!results || !Array.isArray(results)) {
      return NextResponse.json({ error: 'Invalid results data' }, { status: 400 });
    }

    const participantId = uuidv4();
    const timestamp = new Date().toISOString();

    // Convert to Grid-compatible format
    const grid = {
      id: uuidv4(),
      experimentId: `human-baseline-${Date.now()}`,
      model: 'human',
      persona: participantId,
      phrasing: 'neutral' as const,
      constructs: results.map((r: any) => ({
        id: uuidv4(),
        emergentPole: r.emergentPole,
        contrastPole: r.contrastPole,
        similarPair: r.similarPair === 'AB'
          ? [r.triad[0], r.triad[1]]
          : r.similarPair === 'AC'
            ? [r.triad[0], r.triad[2]]
            : [r.triad[1], r.triad[2]],
        explanation: r.explanation,
        ratings: r.ratings,
        sourceTriad: r.triad,
      })),
      timestamp,
      metadata: {
        phase: 'human_baseline',
        iteration: 1,
        condition: 'human_participant',
      },
    };

    // Submit to backend API
    const response = await fetch(`${API_URL}/human-baseline/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(grid),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: 'Backend request failed' }));
      return NextResponse.json(
        { error: err.error || 'Failed to submit to backend' },
        { status: response.status }
      );
    }

    return NextResponse.json({
      success: true,
      participantId,
      gridCount: 1,
      constructCount: results.length,
    });
  } catch (error) {
    console.error('Export error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Export failed' },
      { status: 500 }
    );
  }
}

/**
 * GET /api/export - List all human baseline data (proxied from backend)
 */
export async function GET() {
  try {
    const response = await fetch(`${API_URL}/human-baseline/grids`);

    if (!response.ok) {
      return NextResponse.json({ grids: [], count: 0 });
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('Failed to fetch human baseline grids:', error);
    return NextResponse.json({ grids: [], count: 0 });
  }
}
