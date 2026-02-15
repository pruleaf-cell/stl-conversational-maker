# STL Conversational Maker

A full-stack web app that turns natural-language requests into printable STL models and sliced 3MF project files for Bambu Lab workflows.

## What this repository includes

- `apps/web`: Next.js App Router frontend with a guided flow:
  - Create
  - Questions
  - Refine
  - Build
  - Results
- `apps/api`: FastAPI backend with:
  - Six-agent parallel orchestration
  - Clarification questions (max 4)
  - Auto-adjust printability constraints
  - Build job orchestration and artefact links
- `workers/slicer`: Dedicated worker process for CAD + slicing jobs.
- `packages/contracts`: Shared TypeScript API contracts.
- `infra`: Dockerfiles, Render config, Bambu profile placeholders.

## Key product behaviours implemented

- British English copy and summaries (`en-GB`).
- No login required.
- PLA profiles for `A1_PLA_0.4`, `P1_PLA_0.4`, `X1_PLA_0.4`.
- Up to four follow-up questions before generation.
- Auto-adjustments with reasoned explanations.
- STL generation via CadQuery when available, with deterministic fallback STL writer.
- 3MF slicing via Bambu Studio CLI, with one retry and fallback placeholder package.
- 24-hour retention model for sessions and build jobs.
- Optional external Redis-backed worker dispatch (`USE_EXTERNAL_WORKER=true`).

## Repo layout

```text
.
├── apps
│   ├── api
│   └── web
├── workers
│   └── slicer
├── packages
│   └── contracts
├── infra
│   ├── bambu-profiles
│   └── docker
└── .github/workflows
```

## Local development

### Backend API

```bash
cd apps/api
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --reload --port 8000
```

API health: `GET /health`

### Frontend

```bash
npm install
cp apps/web/.env.example apps/web/.env.local
npm run dev:web
```

Set `NEXT_PUBLIC_API_BASE_URL` if your API is not `http://localhost:8000/api/v1`.

### Worker

```bash
cd workers/slicer
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python worker.py
```

To route API jobs through Redis to this worker, set:

```bash
export USE_EXTERNAL_WORKER=true
export REDIS_URL=redis://localhost:6379/0
```

To enable live six-agent LLM reasoning, set:

```bash
export OPENAI_API_KEY=your_key_here
export OPENAI_SPECIALIST_MODEL=gpt-5-mini
```

## API endpoints

- `POST /api/v1/sessions`
- `POST /api/v1/sessions/{sessionId}/answers`
- `PATCH /api/v1/sessions/{sessionId}/spec`
- `POST /api/v1/builds`
- `GET /api/v1/builds/{jobId}`
- `GET /api/v1/builds/{jobId}/artifacts`
- `GET /api/v1/builds/{jobId}/files/{filename}?token=...`

## Bambu profiles

Files in `infra/bambu-profiles` are placeholders so the repository is runnable.
Replace these with JSON presets exported from Bambu Studio before production slicing.

## Deployment

- Frontend: GitHub Pages (via `.github/workflows/ci.yml`)
- API + worker: Render (see `infra/render.yaml`)
- CI: `.github/workflows/ci.yml`

### Production bootstrap

Set these values in your shell:

- `RENDER_DEPLOY_HOOK_API`
- `RENDER_DEPLOY_HOOK_WORKER`
- `NEXT_PUBLIC_API_BASE_URL` (example: `https://stl-maker-api.onrender.com/api/v1`)

Then run:

```bash
./infra/scripts/set_github_secrets.sh
./infra/scripts/trigger_deploy.sh
```

Set GitHub Pages source to **GitHub Actions** in repository settings before running the deploy workflow.

## Notes on current fallback behaviour

If `bambu-studio` is unavailable, jobs still complete with:
- STL
- report JSON
- fallback 3MF placeholder

The report explains the fallback reason so users can slice manually in Bambu Studio.
