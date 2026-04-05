/**
 * CLI Entry Point for RepGrid Experiment
 * Run with: npx tsx src/cli.ts
 */

import 'dotenv/config';
import { ExperimentRunner } from './experiment/runner.js';
import { ModelRegistry } from './clients/registry.js';
import { ThresholdCalibrator } from './analysis/thresholdCalibration.js';
import { createStorage } from './services/storage.js';

async function main() {
  const args = process.argv.slice(2);
  const pilot = !args.includes('--full');
  const phase = args.find(a => a.startsWith('--phase='))?.split('=')[1];
  const modelArg = args.find(a => a.startsWith('--model='))?.split('=')[1];
  const rerunFrom = args.find(a => a.startsWith('--rerun='))?.split('=')[1];
  const calibrate = args.includes('--calibrate');

  // Create storage adapter
  const storage = createStorage();

  // Handle calibration mode
  if (calibrate) {
    console.log('Running threshold calibration against existing data...\n');
    const calibrator = new ThresholdCalibrator(storage);
    await calibrator.calibrate();
    return;
  }

  // Resolve model key (supports legacy 'haiku'/'sonnet' and new registry keys)
  const model = modelArg
    ? ModelRegistry.resolveLegacyKey(modelArg)
    : 'claude-haiku';

  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║        RepGrid Stability Experiment                        ║');
  console.log('║        Geometry of Representations Protocol                ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`Model: ${model}`);
  if (rerunFrom) {
    console.log(`Rerunning from: ${rerunFrom}`);
  }
  console.log('');

  const runner = new ExperimentRunner({
    configDir: 'config',
    outputDir: 'data/results',
    model,
    storage,
  });

  try {
    // Initialize
    const experimentId = await runner.initialize(pilot);

    if (rerunFrom) {
      // Rerun phase 0 from previous experiment with different model
      const result = await runner.rerunPhase0FromPrevious(rerunFrom);
      await runner.finalizeRerun(result);
    } else if (phase) {
      // Run specific phase
      switch (phase) {
        case '0':
        case 'phase0':
          await runner.runPhase0();
          break;
        case '1':
        case 'phase1':
          await runner.runPhase1();
          break;
        case '2':
        case 'phase2':
          await runner.runPhase2();
          break;
        default:
          console.error(`Unknown phase: ${phase}`);
          process.exit(1);
      }
    } else {
      // Run all phases
      await runner.runAll();
    }

    console.log('\n✓ Experiment completed successfully');
    console.log(`  Results: ${runner.getOutputDir()}`);

  } catch (error) {
    console.error('\n✗ Experiment failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

// Help text
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  const registry = new ModelRegistry();
  const availableModels = registry.getAvailableKeys();

  console.log(`
RepGrid Stability Experiment CLI

Usage:
  npx tsx src/cli.ts [options]

Options:
  --pilot           Run pilot experiment (default)
  --full            Run full experiment (all 20 elements, 50 iterations)
  --phase=N         Run only phase N (0, 1, or 2)
  --model=MODEL     Choose model (default: claude-haiku)
  --rerun=ID        Rerun phase 0 with same triads from experiment ID
  --calibrate       Run threshold calibration against all existing data
  --help, -h        Show this help message

Available Models:
  ${availableModels.map(k => {
    const entry = registry.getEntry(k);
    return `${k.padEnd(16)} ${entry?.provider}/${entry?.model}`;
  }).join('\n  ')}

  Legacy aliases: haiku -> claude-haiku, sonnet -> claude-sonnet,
                  gpt-4o -> gpt-5, gpt-4o-mini -> gpt-4.1, llama-3 -> llama-4

Examples:
  npx tsx src/cli.ts                           # Run pilot with haiku (all phases)
  npx tsx src/cli.ts --model=claude-sonnet     # Run pilot with sonnet
  npx tsx src/cli.ts --model=claude-opus       # Run pilot with Opus 4.6
  npx tsx src/cli.ts --model=gpt-5             # Run pilot with GPT-5.2
  npx tsx src/cli.ts --model=o3                # Run pilot with OpenAI o3
  npx tsx src/cli.ts --model=llama-4           # Run pilot with local Llama 4 Scout
  npx tsx src/cli.ts --model=deepseek          # Run pilot with local DeepSeek V3.2
  npx tsx src/cli.ts --phase=0                 # Run only Phase 0 (baseline)
  npx tsx src/cli.ts --calibrate               # Calibrate thresholds from existing data

  # Model comparison workflow:
  npx tsx src/cli.ts --model=claude-haiku      # First run with haiku
  # Note the experiment ID from output
  npx tsx src/cli.ts --model=claude-sonnet --rerun=<experiment-id>  # Rerun with sonnet
`);
  process.exit(0);
}

main();
