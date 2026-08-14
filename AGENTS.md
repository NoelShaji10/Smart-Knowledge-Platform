# Project Governance & Rules for AI Coding Assistants (`AGENTS.md`)

This repository implements the **AI-Powered Real-Time Collaboration & Knowledge Platform**.
All AI coding assistants operating in this codebase must strictly observe the following rules:

---

## Rule 1: Authoritative Documents & Architecture Supremacy
- `docs/ARCHITECTURE.md` (v1.1) and `PRD.md` are the single source of truth.
- Do NOT introduce infrastructure, architectural patterns, ORMs, or services not explicitly specified in `docs/ARCHITECTURE.md`.
- Flag any architectural ambiguities for explicit user review before taking action.

## Rule 2: Security & Isolation Invariants
- **Qdrant Vector Queries**: EVERY vector search query MUST include mandatory payload filters for both `workspace_id` AND `permitted_user_ids`. Never issue an unfiltered vector search.
- **WebSocket Auth**: WebSocket connections MUST NOT pass JWT tokens in query parameters. Auth is performed via short-lived single-use tickets (`POST /api/v1/ws/ticket`) validated and rejected at the HTTP upgrade handshake level.
- **Permission Verification**: Always perform Layer 3 PostgreSQL permission verification for candidate chunks retrieved during RAG queries before sending content to the LLM.
- **Tenant Isolation**: PostgreSQL Row Level Security (RLS) is active on sensitive tables. Requests must set `app.current_user_id` session context.

## Rule 3: Worker Idempotency
- All background workers consumed via `pg-boss` MUST be strictly idempotent.
- Idempotency keys must follow the definitions in `docs/ARCHITECTURE.md` §6:
  - `index.document`: `document_id + version`
  - `embed.document`: `document_id + chunk_index + content_hash`
  - `ai.suggest`: `document_id + version + type + prompt_hash`
  - `permissions.sync`: `document_id + sorted(user_ids) + action`
  - `snapshot.compact`: `document_id`

## Rule 4: Surgical Modifications & Zero Unnecessary Dependencies
- Do NOT modify unrelated files without explicit explanation.
- Do NOT introduce dependencies without verifying they are required by the approved architecture.
- Use `Kysely` for typed PostgreSQL queries with SQL-based migrations. Do not introduce Prisma, TypeORM, or Drizzle.

## Rule 5: Phase Isolation
- Work incrementally and execute tasks strictly in accordance with approved implementation plans.
- Never write Phase 1 feature code during Phase 0 foundation setup.

---

## Verification Commands
- Monorepo Typecheck: `pnpm typecheck`
- Unit Tests: `pnpm test`
- Security Invariant Tests: `pnpm test:security`
- Run Migrations: `pnpm db:migrate`
