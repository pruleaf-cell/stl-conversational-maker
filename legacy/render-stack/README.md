# Deprecated Render Stack

This folder contains the previous FastAPI + worker + Render deployment implementation.

It is archived for reference only and is not the production path.

Current production deployment is Vercel-only:
- Next.js frontend in `apps/web`
- Next.js API routes in `apps/web/app/api/v1`
- Deterministic STL generation in TypeScript
- Manual Bambu Studio slicing using the generated guide JSON
