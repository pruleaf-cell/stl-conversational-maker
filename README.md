# STL Conversational Maker

Vercel-only web app that turns natural-language requests into downloadable STL files, plus a JSON slicing guide for manual Bambu Studio slicing.

## Current production architecture

- `apps/web`: Next.js App Router frontend and API routes.
- `packages/contracts`: shared TypeScript request/response contracts.
- `legacy/render-stack`: deprecated FastAPI/worker/Render implementation (archived, not used in production).

## User flow

1. **Create**: user enters a natural-language request.
2. **Questions**: app asks up to 4 clarification questions.
3. **Refine**: user adjusts dimensions and printer profile.
4. **Build**: app generates STL via deterministic TypeScript geometry.
5. **Results**: user downloads STL + slicing guide JSON.

All UI copy and summaries use British English.

## API routes (Next.js)

- `POST /api/v1/interpret`
- `POST /api/v1/generate`

### `POST /api/v1/interpret`

Request:

```json
{
  "prompt": "I want a 2mm deep earring, in the shape of a heart.",
  "answers": {},
  "draftSpec": null
}
```

Response:

```json
{
  "summary": "...",
  "questions": [],
  "modelSpec": {
    "objectClass": "earring",
    "shape": "heart",
    "dimensionsMm": {},
    "featureFlags": {},
    "printerProfile": "A1_PLA_0.4"
  },
  "adjustments": []
}
```

### `POST /api/v1/generate`

Request:

```json
{
  "modelSpec": {
    "objectClass": "earring",
    "shape": "heart",
    "dimensionsMm": {
      "width": 20,
      "height": 20,
      "thickness": 2,
      "hole_diameter": 2
    },
    "featureFlags": {
      "rounded_edges": true
    },
    "printerProfile": "A1_PLA_0.4"
  },
  "printerProfile": "A1_PLA_0.4"
}
```

Response:

```json
{
  "stlFileName": "earring-heart.stl",
  "stlBase64": "...",
  "slicingGuide": {
    "profile": "A1_PLA_0.4",
    "notes": ["..."],
    "recommendedSteps": ["..."]
  }
}
```

## Local development

```bash
npm install
cp apps/web/.env.example apps/web/.env.local
npm run dev:web
```

Open <http://localhost:3000>.

## Environment variables

Set in Vercel project settings:

- `OPENAI_API_KEY` (required for live specialist agents; heuristic fallback works without it)
- `OPENAI_SPECIALIST_MODEL` (default: `gpt-5-mini`)
- `OPENAI_MERGE_MODEL` (default: `gpt-5`)

## Deployment

- Connect repository to Vercel.
- Set project root to `apps/web`.
- Deploy from `main` using Vercel Git integration.

GitHub Actions now runs checks only (`lint`, `typecheck`, `test`) and does not deploy.
