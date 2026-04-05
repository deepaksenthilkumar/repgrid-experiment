# RepGrid Experiment - Geometry of Representations

<!-- TODO: Add blog post link here -->

An experimental harness to test LLM stability and alignment using Repertory Grid methodology with triadic elicitation and Generalized Procrustes Analysis (GPA).

## Overview

This project implements the "Geometry of Representations" protocol, which measures the topological stability of LLM representations through:

1. **Triadic Elicitation**: Present 3 items, model generates discriminant dimensions
2. **Monte Carlo Bootstrapping**: Multiple iterations to build consensus grids
3. **Stability Testing**: Phrasing variants and persona steering across domains
4. **Generalized Procrustes Analysis**: Geometric alignment to measure instability

### Experimental Domains

| Domain | Elements | Purpose |
|--------|----------|---------|
| **Ethics** | 15 discrete ethical situations | Primary domain — tests moral reasoning structure |
| **Meals** | 12 common dishes | Control domain — culinary preferences |
| **Instruments** | 12 musical instruments | Control domain — aesthetic judgments |
| **Objects** | 12 physical objects | Baseline control — zero evaluative loading |

## Supported Models

| Provider | Models | API Key Env Var |
|----------|--------|-----------------|
| **Anthropic** | Claude Haiku 4.5, Sonnet 4.5, Opus 4.6 | `ANTHROPIC_API_KEY` |
| **OpenAI** | GPT-5.2, GPT-4.1, o3 | `OPENAI_API_KEY` |
| **Google** | Gemini 2.5 Pro, Gemini 2.0 Flash | `GOOGLE_API_KEY` |
| **DeepSeek** | DeepSeek V3 (chat), DeepSeek R1 (reasoner) | `DEEPSEEK_API_KEY` |
| **Ollama** | Llama 4 Scout, DeepSeek V3.2 (local), GPT-OSS 120B | None (local) |

---

## Local Development

### Prerequisites

- Node.js 20+
- At least one LLM API key (Anthropic, OpenAI, Google, or DeepSeek)
- Voyage AI API key (for construct embeddings)

### 1. Install Dependencies

```bash
# Backend
npm install

# Frontend
cd web && npm install && cd ..
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` and fill in your API keys. At minimum you need:

```env
# Required
ANTHROPIC_API_KEY=sk-ant-...    # or at least one LLM provider key
VOYAGE_API_KEY=pa-...            # required for construct embeddings

# Optional (leave blank to skip these providers)
OPENAI_API_KEY=sk-...
GOOGLE_API_KEY=AIza...
DEEPSEEK_API_KEY=sk-...
```

### 3. Start the Development Servers

Open two terminals:

```bash
# Terminal 1: Backend API server (auto-reloads on file changes)
npm run dev
```

```bash
# Terminal 2: Frontend dashboard (with HMR)
cd web && npm run dev
```

- **API server**: http://localhost:3001
- **Dashboard**: http://localhost:3000

### 4. Run an Experiment

Via the dashboard (recommended):
1. Open http://localhost:3000
2. Go to "Experiments" tab
3. Select a model and click "Run Experiment"

Via the CLI:

```bash
# Run pilot experiment with Claude Haiku (default)
npm run experiment

# Specify a model
npm run experiment -- --model=claude-sonnet
npm run experiment -- --model=gpt-5
npm run experiment -- --model=gemini-2.5-pro
npm run experiment -- --model=deepseek-v3

# Run specific phase only
npm run experiment -- --model=claude-haiku --phase=0

# Rerun an existing experiment with a different model (same triads)
npm run experiment -- --rerun=<experiment-id> --model=claude-sonnet

# Run threshold calibration against all existing data
npm run experiment -- --calibrate

# Run full experiment (not pilot)
npm run experiment -- --full
```

### 5. View Results

Results are saved to `data/results/<experiment-id>/` and visible in the dashboard. Each experiment produces:

```
data/results/{experimentId}/
├── manifest.json           # Full experiment config and decisions
├── summary.json            # Human-readable summary
├── consolidated_results.json  # All data in one file
├── logs/
│   └── api_calls.jsonl     # Every API call with timestamps
├── grids/
│   └── {gridId}.json       # Individual grid data with constructs
└── analysis/
    ├── dimensionality.json # Ethical dimensionality estimation
    └── cross_model_comparison.json  # If rerun with different model
```

---

## Experimental Phases

### Phase 0: Baseline Stability Audit
- 50 iterations of triadic elicitation (10 for pilot)
- 15 discrete ethics elements / 12 elements for control domains
- Neutral facilitation prompt, no persona
- Measures baseline construct consistency

### Phase 1: Phrasing Sensitivity (Ethics Only)
- Tests stability under phrasing variation
- Three register variants: formal, conversational, instructional
- Calculates Synonym Variance Ratio (SVR)

### Phase 2: Mild Persona Steering (All Domains)
- Tests stability under mild persona steering
- Descriptive personas ("you tend to..."), not prescriptive
- Calculates Persona Displacement Score (PDS)

## Key Metrics

| Metric | Description | Good Value |
|--------|-------------|------------|
| Baseline Cosine Similarity | Semantic consistency of constructs | >0.7 |
| Synonym Variance Ratio (SVR) | Paraphrase resistance | ~1.0 |
| Persona Displacement Score (PDS) | Persona invariance | <0.3 |
| Procrustes Residual | Geometric instability | <0.2 |

---

## Authentication (Optional)

Authentication is **disabled by default** for local development. To enable it (required for deployment):

### Enable Auth

Set `JWT_SECRET` in `.env`:

```env
JWT_SECRET=your-secret-key-here-at-least-32-chars
```

When `JWT_SECRET` is set, all API routes (except `/health` and `/auth/*`) require a valid Bearer token.

### Create the First User

The first user to register automatically becomes an admin. You can either:

**Option A**: Use the registration form in the dashboard (first user becomes admin).

**Option B**: Use the CLI script:

```bash
npx tsx scripts/create-admin.ts admin@example.com yourpassword "Admin Name"
```

After that, only admins can create additional users via `POST /auth/register`.

---

## Deployment

### Architecture

```
┌─────────────────────────┐     ┌──────────────────────────────┐
│ Vercel (free tier)      │     │ Railway (~$5-7/mo)           │
│                         │     │                              │
│ React SPA               │────>│ Fastify API server           │
│ + Login page            │     │ + Experiment runner          │
│                         │     │ + SQLite for users           │
│                         │     │ + Persistent volume for data │
└─────────────────────────┘     └──────────────────────────────┘
```

### Deploy the Backend (Railway)

1. **Build the project**:

   ```bash
   npm run build
   ```

2. **Test the Docker build locally** (optional):

   ```bash
   docker build -t repgrid-api .
   docker run -p 3001:3001 \
     -e ANTHROPIC_API_KEY=... \
     -e VOYAGE_API_KEY=... \
     -e JWT_SECRET=... \
     -v repgrid-data:/app/data \
     repgrid-api
   ```

3. **Deploy to Railway**:

   - Connect your GitHub repo at https://railway.app
   - Set the **root directory** to `/` (the backend)
   - Set **build command**: `npm run build`
   - Set **start command**: `node dist/server.js`
   - Add a **persistent volume** mounted at `/app/data`
   - Set environment variables:

     | Variable | Required | Description |
     |----------|----------|-------------|
     | `ANTHROPIC_API_KEY` | Yes (for Claude) | Anthropic API key |
     | `VOYAGE_API_KEY` | Yes | Voyage AI embedding key |
     | `JWT_SECRET` | Yes | Secret for JWT signing (generate a random 64-char string) |
     | `OPENAI_API_KEY` | No | OpenAI API key |
     | `GOOGLE_API_KEY` | No | Google Gemini API key |
     | `DEEPSEEK_API_KEY` | No | DeepSeek API key |
     | `PORT` | No | Defaults to 3001 |
     | `STORAGE_BACKEND` | No | `fs` (default) or `s3` |

   Railway will build and deploy automatically on push.

4. **Note your Railway URL** (e.g., `https://repgrid-api.up.railway.app`).

### Deploy the Frontend (Vercel)

1. **Update the production API URL**:

   Copy `web/.env.production.example` to `web/.env.production` and set your Railway URL:

   ```env
   VITE_API_URL=https://your-railway-url.up.railway.app
   ```

2. **Deploy to Vercel**:

   - Go to https://vercel.com and import your repo
   - Set the **root directory** to `web`
   - Vercel will auto-detect Vite and use `web/vercel.json`
   - No environment variables needed (API URL is baked into the build)

3. **Test the deployment**:

   - Visit your Vercel URL
   - You should see the login page (since `JWT_SECRET` is set on the backend)
   - Register the first user (becomes admin)
   - Start an experiment from the dashboard

### Using S3/R2 Storage (Optional)

For production, you can store experiment results in S3 or Cloudflare R2 instead of the local filesystem:

```env
STORAGE_BACKEND=s3
S3_BUCKET=repgrid-data
S3_REGION=auto                    # 'auto' for Cloudflare R2
S3_ENDPOINT=https://xxx.r2.cloudflarestorage.com  # R2 endpoint
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
```

With `STORAGE_BACKEND=fs` (default), all data is stored on the local filesystem / persistent volume.

---

## Project Structure

```
repGrid/
├── config/                 # YAML configuration files
│   ├── elements.yaml       # 15 discrete ethical situations (v2)
│   ├── synonyms.yaml       # Phrasing variants for stability testing
│   ├── personas.yaml       # Persona prompts (default, mild consequentialist/deontologist)
│   ├── prompts.yaml        # All prompt templates (neutral facilitation)
│   ├── experiment.yaml     # Experiment parameters, model registry, thresholds
│   ├── instruments/        # Musical instruments domain config
│   ├── meals/              # Meals domain config
│   └── objects/            # Physical objects domain config (baseline control)
├── src/
│   ├── auth/               # Authentication (SQLite users, JWT middleware)
│   ├── clients/            # LLM API clients (Anthropic, OpenAI, Gemini, Ollama)
│   │   ├── llmClient.ts    # Abstract LLMClient interface
│   │   ├── anthropic.ts    # Claude client
│   │   ├── openai.ts       # OpenAI/DeepSeek client (OpenAI-compatible)
│   │   ├── gemini.ts       # Gemini client
│   │   ├── ollama.ts       # Local Ollama client
│   │   └── registry.ts     # Model registry and factory
│   ├── core/               # Core types, triadic logic, metrics
│   ├── analysis/           # GPA, construct matching, cross-model, calibration
│   ├── experiment/         # Experiment runner (phases 0-2)
│   ├── services/           # Logger, config loader, storage adapter
│   ├── server.ts           # Fastify API server
│   └── cli.ts              # CLI entry point
├── web/                    # React dashboard (Vite + Plotly)
├── human-baseline/         # Next.js human baseline survey app
├── scripts/
│   └── create-admin.ts     # CLI to create admin user
├── Dockerfile              # Backend container for deployment
└── data/results/           # Experiment output (gitignored)
```

## API Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/health` | GET | No | Health check |
| `/auth/login` | POST | No | Login, returns JWT |
| `/auth/register` | POST | Admin* | Create user (*first user is auto-admin) |
| `/auth/me` | GET | Yes | Current user info |
| `/models` | GET | Yes | List available models with API key status |
| `/config` | GET | Yes | Get YAML configuration files |
| `/experiments` | GET | Yes | List all experiments |
| `/experiment/run` | POST | Yes | Start new experiment |
| `/experiment/:id/rerun` | POST | Yes | Rerun with different model |
| `/experiment/status/:id` | GET | Yes | Get experiment status |
| `/results/:id` | GET | Yes | Full experiment results |
| `/results/:id/grids` | GET | Yes | Grids with optional filters |
| `/results/:id/logs` | GET | Yes | Paginated API call logs |
| `/results/:id/analysis` | GET | Yes | All analysis data |
| `/results/:id/analysis/dimensionality` | GET | Yes | Dimensionality analysis |
| `/results/:id/analysis/cross-model` | GET | Yes | Cross-model comparison |
| `/analysis/calibration` | GET | Yes | Threshold calibration data |
| `/analysis/human` | GET | Yes | Human baseline data |

**Note**: Auth columns show "Yes" but authentication is only enforced when `JWT_SECRET` is set. In local dev without `JWT_SECRET`, all routes are open.

## Cost Estimation

Pilot experiment (12-15 elements, 10 iterations):

| Model | Approx. Cost |
|-------|-------------|
| Claude Haiku 4.5 | ~$0.20-0.40 |
| Claude Sonnet 4.5 | ~$2-5 |
| GPT-5.2 | ~$2-5 |
| GPT-4.1 | ~$1-3 |
| Gemini 2.5 Pro | ~$1-3 |
| DeepSeek V3 | ~$0.50-1 |
| Ollama (local) | Free |

## Documentation

- **[CLAUDE.md](./CLAUDE.md)** — v2 methodology, design principles, and implementation plan

## References

- Based on "The Geometry of Representations" research protocol
- Uses Repertory Grid Technique (Kelly, 1955)
- Generalized Procrustes Analysis for geometric alignment

## License

[MIT](./LICENSE)
