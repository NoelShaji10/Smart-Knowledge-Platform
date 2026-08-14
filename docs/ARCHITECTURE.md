# System Architecture — AI-Powered Real-Time Collaboration & Knowledge Platform

**Status**: Approved  
**Version**: 1.1  
**Last Updated**: August 2026  
**Scope**: v1 (Internal Alpha → Internal Beta → Limited External Beta)  
**Revision**: 1.1 — Resolved Redis durability, WebSocket auth, worker idempotency, snapshot/version separation, permission authority, and integration test specifications.

---

## Table of Contents

1. [System Architecture Overview](#1-system-architecture-overview)
2. [Technology Stack](#2-technology-stack)
3. [Service / Component Boundaries](#3-service--component-boundaries)
4. [Database Architecture](#4-database-architecture)
5. [Real-Time Collaboration Architecture](#5-real-time-collaboration-architecture)
6. [Event-Driven Architecture](#6-event-driven-architecture)
7. [Search / Indexing Pipeline](#7-search--indexing-pipeline)
8. [Permission-Aware RAG Architecture](#8-permission-aware-rag-architecture)
9. [Authentication / RBAC Architecture](#9-authentication--rbac-architecture)
10. [AI Suggestion Workflow](#10-ai-suggestion-workflow)
11. [Audit Logging Architecture](#11-audit-logging-architecture)
12. [Failure / Recovery Scenarios](#12-failure--recovery-scenarios)
13. [Scalability Concerns](#13-scalability-concerns)
14. [Security Risks](#14-security-risks)
15. [Local Development Architecture](#15-local-development-architecture)
16. [Production Deployment Architecture](#16-production-deployment-architecture)

---

## 1. System Architecture Overview

### Governing Principle

The architecture enforces a hard boundary between the **real-time collaboration path** (latency-critical, user-facing) and the **AI/indexing path** (throughput-oriented, asynchronous). These two paths share data through PostgreSQL and a job queue (pg-boss), but never share a synchronous call chain. AI latency, AI provider outages, and indexing backlogs cannot degrade editing performance.

### High-Level Component Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              CLIENTS                                    │
│                    (Browser — Tiptap + Yjs Client)                      │
└──────────┬──────────────────────┬───────────────────────┬───────────────┘
           │ WebSocket            │ HTTPS (REST API)      │ HTTPS (REST API)
           │ (Yjs sync,          │ (Search, AI Q&A,      │ (Auth, Admin,
           │  presence)           │  suggestions)          │  permissions)
           ▼                     ▼                        ▼
┌─────────────────┐   ┌─────────────────────┐   ┌─────────────────────┐
│  Collab Server   │   │     API Server       │   │    Auth Service     │
│  (WebSocket)     │   │     (REST)           │   │    (OAuth/SSO)      │
│                  │   │                      │   │                     │
│  • Yjs provider  │   │  • Search endpoint   │   │  • JWT issuance     │
│  • Doc rooms     │   │  • AI Q&A endpoint   │   │  • Session mgmt     │
│  • Presence      │   │  • CRUD endpoints    │   │  • RBAC middleware   │
│  • Snapshot emit │   │  • Suggestion mgmt   │   │                     │
└───────┬──┬───────┘   └──────────┬───────────┘   └─────────────────────┘
        │  │                      │
        │  │ pub/sub              │
        │  ▼                      │
   ┌─────────┐                    │
   │  Redis   │                   │
   │          │                   │
   │ • Fan-out│                   │
   │ • Cursor │                   │
   │   state  │                   │
   │ • Cache  │                   │
   └─────────┘                    │
        │                         │
        │                         │
        ▼                         ▼
┌──────────────────────────────────────────────────────────┐
│                      PostgreSQL                           │
│                                                           │
│  • Document metadata     • Audit log (append-only)        │
│  • User/workspace/perms  • Full-text search (tsvector)    │
│  • AI suggestions        • pg-boss job queue              │
│  • RLS policies                                           │
└──────────────────┬───────────────────────────────────────┘
                   │
                   │ pg-boss (async jobs)
                   ▼
        ┌─────────────────────┐
        │  Background Workers  │
        │                      │
        │  • Indexing worker    │──────────────┐
        │  • Embedding worker   │              │
        │  • AI suggestion wkr  │              │
        │  • Snapshot worker    │              │
        └──────────┬───────────┘              │
                   │                           │
          ┌────────┴────────┐                  │
          ▼                 ▼                  ▼
   ┌───────────┐    ┌──────────────┐   ┌───────────┐
   │   Qdrant   │    │ LiteLLM Proxy│   │   MinIO   │
   │            │    │              │   │   (S3)    │
   │ • Vectors  │    │ • OpenAI     │   │           │
   │ • Payload  │    │ • Anthropic  │   │ • CRDT    │
   │   filter   │    │ • Ollama     │   │   snaps   │
   │            │    │ • Any provider│  │ • Versions│
   └───────────┘    └──────────────┘   └───────────┘
```

### Data Flow Summary

| Path | Flow | Latency Target |
|---|---|---|
| **Edit propagation** | Client → WebSocket → Yjs Provider → Redis pub/sub → other clients | <150ms p95 |
| **Snapshot persistence** | Yjs Provider → (debounced) → MinIO + PostgreSQL metadata | Best-effort, <5s |
| **Search indexing** | Snapshot → pg-boss job → FTS update (Postgres) + embedding (Qdrant) | <5s from edit |
| **AI Q&A** | Client → API → permission check → Qdrant filtered search → LiteLLM → streamed response | <3s p95 (streamed) |
| **AI suggestion** | Snapshot → pg-boss job → LiteLLM → pending suggestion in PostgreSQL | Async, no SLA |

---

## 2. Technology Stack

| Layer | Technology | Version Guidance | Justification |
|---|---|---|---|
| CRDT | Yjs | Latest stable | Battle-tested (YATA algorithm), native Tiptap/Prosemirror bindings, sub-150ms latency proven at scale |
| Rich-text editor | Tiptap (Prosemirror) | v2.x | First-class Yjs integration via `y-prosemirror`, extensible for AI suggestion blocks and comments |
| Real-time transport | WebSocket (native) | — | Lowest latency bidirectional channel; `y-websocket` reference implementation available |
| Cross-node fan-out | Redis | 7.x | Pub/sub for WebSocket multi-instance sync, presence state, response caching |
| Primary database | PostgreSQL | 16+ | Metadata, permissions (RLS), audit log, full-text search (tsvector), pg-boss job queue |
| Job queue | pg-boss | Latest | PostgreSQL-backed, zero additional infrastructure, retry/DLQ built-in |
| Vector database | Qdrant | Latest stable | Payload filtering at query time for permission-aware RAG, hybrid sparse+dense search |
| Object storage | MinIO (S3-compatible) | Latest | CRDT binary snapshots, document version history |
| AI provider proxy | LiteLLM | Latest | Provider-agnostic abstraction: OpenAI, Anthropic, Ollama, any OpenAI-compatible API |
| Comment anchoring | Yjs `Y.RelativePosition` | (part of Yjs) | Native CRDT-aware position tracking that survives concurrent edits |
| Auth | OAuth 2.0 / OIDC + JWT | — | SSO support (FR-14), stateless session validation |
| Containerization | Docker + Docker Compose | — | All services containerized; Compose for dev through beta |

### Provider-Agnostic AI Abstraction

The AI layer uses LiteLLM as a unified proxy. No application code imports provider-specific SDKs. All calls go through a single internal interface:

```
Application Code
       │
       ▼
┌──────────────┐     Config-driven routing
│  AI Gateway   │─────────────────────────────────────┐
│  (internal)   │                                     │
└──────┬───────┘                                      │
       │                                              │
       ▼                                              ▼
┌──────────────┐   ┌──────────────┐   ┌──────────────────────┐
│   LiteLLM    │   │   LiteLLM    │   │      LiteLLM         │
│  (Hosted)    │   │  (Ollama)    │   │  (Any compatible)    │
│              │   │              │   │                      │
│ • OpenAI     │   │ • llama3     │   │ • Azure OpenAI       │
│ • Anthropic  │   │ • mistral    │   │ • Google Vertex      │
│ • Cohere     │   │ • nomic-embed│   │ • AWS Bedrock        │
└──────────────┘   └──────────────┘   └──────────────────────┘
```

Configuration specifies provider and model per task type:

```yaml
ai:
  providers:
    embedding:
      provider: "openai"           # or "ollama", "cohere", etc.
      model: "text-embedding-3-small"
      # For Ollama:
      # provider: "ollama"
      # model: "nomic-embed-text"
      # base_url: "http://ollama:11434"
    
    generation:
      qa:
        provider: "anthropic"
        model: "claude-sonnet-4-20250514"
      suggestions:
        provider: "openai"
        model: "gpt-4o-mini"       # cheaper model for low-stakes tasks
      tags:
        provider: "ollama"
        model: "llama3"            # local model for simple classification
```

Switching providers is a configuration change, not a code change.

---

## 3. Service / Component Boundaries

### Logical Services

The system is composed of 4 logical services sharing a single codebase, deployed as separate containers with different entrypoints:

```
knowledge-platform/
├── src/
│   ├── collab/          # Collab Server (WebSocket)
│   ├── api/             # API Server (REST)
│   ├── workers/         # Background Workers
│   ├── auth/            # Auth (middleware, shared across api + collab)
│   └── shared/          # Shared: DB models, permissions, AI gateway, types
```

| Service | Protocol | Stateful? | Scaling Model |
|---|---|---|---|
| **Collab Server** | WebSocket | Yes (in-memory Yjs docs per room) | Horizontal via Redis pub/sub. Sticky sessions preferred but not required — any node can load a doc from snapshot. |
| **API Server** | HTTP/REST | No | Horizontal, stateless. Any instance handles any request. |
| **Background Workers** | pg-boss consumer | No | Horizontal. pg-boss guarantees each job is consumed by exactly one worker. |
| **Auth** | (embedded middleware) | No | Shared module, not a separate deployment. JWT validation is stateless. |

### Infrastructure Services

| Service | Purpose | Shared By |
|---|---|---|
| **PostgreSQL** | Source of truth for all relational data + job queue | All services |
| **Redis** | Pub/sub fan-out, presence, caching | Collab Server, API Server |
| **Qdrant** | Vector storage + permission-filtered retrieval | Workers (write), API Server (read) |
| **MinIO** | CRDT snapshot storage | Collab Server (write), Workers (read) |
| **LiteLLM Proxy** | AI provider abstraction | Workers, API Server |

### Communication Patterns

```
Collab Server ──WebSocket──► Client (bidirectional, Yjs sync)
Collab Server ──Redis pub/sub──► Other Collab Server instances (fan-out)
Collab Server ──pg-boss enqueue──► PostgreSQL (async job creation)
Workers ──pg-boss consume──► PostgreSQL (job processing)
Workers ──HTTP──► Qdrant (vector upsert)
Workers ──HTTP──► LiteLLM Proxy (embedding + generation)
Workers ──S3 API──► MinIO (snapshot read)
API Server ──HTTP──► Qdrant (filtered vector search)
API Server ──HTTP──► LiteLLM Proxy (streamed generation)
API Server ──SQL──► PostgreSQL (FTS, CRUD, permissions)
```

No service calls another application service synchronously. All inter-service coordination is through PostgreSQL (shared state + pg-boss jobs) and Redis (pub/sub).

---

## 4. Database Architecture

### PostgreSQL Schema

#### Core Tables

```sql
-- Workspaces (tenants)
CREATE TABLE workspaces (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    slug            TEXT NOT NULL UNIQUE,
    settings        JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Users
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           TEXT NOT NULL UNIQUE,
    display_name    TEXT NOT NULL,
    avatar_url      TEXT,
    auth_provider   TEXT NOT NULL,          -- 'google', 'github', 'saml', etc.
    auth_subject    TEXT NOT NULL,          -- provider-specific user ID
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (auth_provider, auth_subject)
);

-- Workspace membership (workspace-level roles)
CREATE TABLE workspace_members (
    workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role            TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'editor', 'viewer')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, user_id)
);

-- Documents
CREATE TABLE documents (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    title           TEXT NOT NULL DEFAULT 'Untitled',
    content_text    TEXT NOT NULL DEFAULT '',          -- plaintext extraction for FTS
    content_tsv     TSVECTOR GENERATED ALWAYS AS (
                        setweight(to_tsvector('english', title), 'A') ||
                        setweight(to_tsvector('english', content_text), 'B')
                    ) STORED,
    snapshot_key    TEXT,                               -- S3/MinIO key for latest CRDT snapshot
    snapshot_version BIGINT NOT NULL DEFAULT 0,
    created_by      UUID NOT NULL REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_documents_workspace ON documents(workspace_id);
CREATE INDEX idx_documents_fts ON documents USING GIN(content_tsv);

-- Document-level permission overrides (individual-only)
CREATE TABLE document_permissions (
    document_id     UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role            TEXT NOT NULL CHECK (role IN ('editor', 'viewer', 'none')),
    granted_by      UUID NOT NULL REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (document_id, user_id)
);
```

#### CRDT Recovery Snapshots

> [!NOTE]
> **Resolved (v1.1)**: Recovery snapshots and user-visible versions are separate concepts. Recovery snapshots are high-frequency, internal, and automatically managed. User-visible versions are explicit, human-meaningful checkpoints.

```sql
-- Internal CRDT recovery snapshots (high-frequency, not user-visible)
-- These are overwritten in-place per document; only the latest is kept.
-- Historical snapshots are stored in MinIO at: snapshots/{doc_id}/latest.yjs
-- The documents table tracks the current snapshot via snapshot_key + snapshot_version.
-- No separate table needed — the documents row IS the recovery snapshot pointer.

-- User-visible version history (explicit checkpoints)
CREATE TABLE document_versions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id     UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    version_number  BIGINT NOT NULL,
    snapshot_key    TEXT NOT NULL,          -- S3/MinIO key (versions/{doc_id}/{version}.yjs)
    content_text    TEXT,                   -- plaintext at this version (for display)
    title           TEXT,                   -- document title at this version
    created_by      UUID REFERENCES users(id),
    trigger         TEXT NOT NULL CHECK (trigger IN ('manual', 'auto_interval', 'session_end')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (document_id, version_number)
);

CREATE INDEX idx_doc_versions_doc ON document_versions(document_id, version_number DESC);
```

**Two-tier snapshot strategy**:

| Tier | Purpose | Location | Frequency | Retention |
|---|---|---|---|---|
| **Recovery snapshot** | CRDT crash recovery, room initialization | `snapshots/{doc_id}/latest.yjs` in MinIO, pointer in `documents.snapshot_key` | Every ~2s of inactivity (debounced) | Overwritten in-place (only latest kept) |
| **Version checkpoint** | User-visible history, "restore to version" (FR-3) | `versions/{doc_id}/{version}.yjs` in MinIO, row in `document_versions` | On: (1) explicit user save, (2) configurable interval (e.g., every 30 minutes of active editing), (3) last editor disconnects (session end) | Retained per workspace retention policy |

#### AI Suggestions

```sql
-- Pending AI suggestions
CREATE TABLE ai_suggestions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id     UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    type            TEXT NOT NULL CHECK (type IN ('summary', 'tags', 'rewrite', 'other')),
    content         JSONB NOT NULL,         -- suggestion payload (structured by type)
    status          TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'accepted', 'rejected', 'expired')),
    model_id        TEXT NOT NULL,          -- e.g. 'gpt-4o-mini', 'claude-sonnet-4-20250514'
    provider        TEXT NOT NULL,          -- e.g. 'openai', 'anthropic', 'ollama'
    prompt_hash     TEXT,                   -- for deduplication / caching
    resolved_by     UUID REFERENCES users(id),
    resolved_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_suggestions_doc_status ON ai_suggestions(document_id, status);
CREATE INDEX idx_suggestions_workspace ON ai_suggestions(workspace_id);
```

#### Comments

```sql
-- Document comments with CRDT-aware anchoring
CREATE TABLE comments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id     UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    author_id       UUID NOT NULL REFERENCES users(id),
    content         TEXT NOT NULL,
    anchor_position BYTEA NOT NULL,         -- serialized Y.RelativePosition
    resolved        BOOLEAN NOT NULL DEFAULT false,
    parent_id       UUID REFERENCES comments(id),  -- for threaded replies
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_comments_doc ON comments(document_id) WHERE NOT resolved;
```

#### Audit Log

```sql
-- Append-only audit events (partitioned by month)
CREATE TABLE audit_events (
    id              UUID NOT NULL DEFAULT gen_random_uuid(),
    workspace_id    UUID NOT NULL,
    actor_id        UUID,                   -- NULL for system actions
    action          TEXT NOT NULL,           -- e.g. 'document.created', 'ai.suggestion.accepted'
    resource_type   TEXT NOT NULL,           -- e.g. 'document', 'ai_suggestion', 'workspace'
    resource_id     UUID NOT NULL,
    metadata        JSONB NOT NULL DEFAULT '{}',
    ip_address      INET,
    user_agent      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Create partitions (managed by a monthly cron or pg_partman)
-- Example:
-- CREATE TABLE audit_events_2026_08 PARTITION OF audit_events
--     FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');

CREATE INDEX idx_audit_workspace_time ON audit_events(workspace_id, created_at DESC);
CREATE INDEX idx_audit_resource ON audit_events(resource_type, resource_id, created_at DESC);
CREATE INDEX idx_audit_actor ON audit_events(actor_id, created_at DESC);
```

### Row-Level Security (RLS)

RLS acts as a defense-in-depth layer. Application code performs its own authorization checks; RLS is the safety net that prevents data leaks even if application logic has a bug.

```sql
-- Enable RLS on sensitive tables
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;

-- Application connects as a role that has RLS enforced
-- (not as the table owner, which bypasses RLS)

-- Documents: user must be a workspace member
CREATE POLICY documents_workspace_member ON documents
    FOR ALL
    USING (
        workspace_id IN (
            SELECT workspace_id FROM workspace_members
            WHERE user_id = current_setting('app.current_user_id')::UUID
        )
    );

-- Documents: respect document-level 'none' permission (explicit deny)
CREATE POLICY documents_not_denied ON documents
    FOR SELECT
    USING (
        NOT EXISTS (
            SELECT 1 FROM document_permissions
            WHERE document_id = documents.id
              AND user_id = current_setting('app.current_user_id')::UUID
              AND role = 'none'
        )
    );

-- Audit events: only workspace admins/owners can read
CREATE POLICY audit_admin_only ON audit_events
    FOR SELECT
    USING (
        workspace_id IN (
            SELECT workspace_id FROM workspace_members
            WHERE user_id = current_setting('app.current_user_id')::UUID
              AND role IN ('owner', 'admin')
        )
    );
```

Each request sets `app.current_user_id` via `SET LOCAL` at the start of the database transaction. This makes RLS user-aware without passing user context through every query.

### Qdrant Collections

```
Collection: document_chunks
  ├── vector: float[N]           (embedding dimension depends on model)
  ├── payload:
  │     ├── workspace_id: string
  │     ├── document_id: string
  │     ├── chunk_index: int
  │     ├── chunk_text: string
  │     ├── document_title: string
  │     ├── permitted_user_ids: string[]    ← permission filter field
  │     ├── updated_at: string (ISO 8601)
  │     └── content_hash: string            ← for dirty-chunk detection
  └── id: UUID (deterministic from document_id + chunk_index)
```

Permission filtering is enforced at query time via Qdrant's `must` filter:

```json
{
  "filter": {
    "must": [
      { "key": "workspace_id", "match": { "value": "<user's workspace>" } },
      { "key": "permitted_user_ids", "match": { "any": ["<requesting_user_id>"] } }
    ]
  }
}
```

---

## 5. Real-Time Collaboration Architecture

### WebSocket Authentication (Ticket-Based)

> [!NOTE]
> **Resolved (v1.1)**: WebSocket connections do NOT pass JWT access tokens in query parameters. Query parameters are logged by proxies, CDNs, and browser history — exposing a JWT there is a credential leak vector. Instead, we use a **short-lived opaque ticket** exchanged via an authenticated HTTP endpoint.

**Ticket flow**:

```
Client                     API Server                 PostgreSQL / Redis
  │                            │                            │
  │── POST /api/v1/ws/ticket ─►│                            │
  │   (Authorization: Bearer   │                            │
  │    <access_token>)         │                            │
  │                            │── Validate JWT             │
  │                            │── Generate opaque ticket   │
  │                            │   (crypto random, 32 bytes)│
  │                            │── Store in Redis: ─────────►
  │                            │   key: ws_ticket:{ticket}  │
  │                            │   value: { user_id,        │
  │                            │     workspace_id, doc_id } │
  │                            │   TTL: 30 seconds          │
  │◄── { ticket: "abc123" } ──│                            │
  │                            │                            │
  │── WS Connect ─────────────►│ Collab Server              │
  │   /ws/doc/{id}?ticket=abc  │                            │
  │                            │── Redis GET ───────────────►
  │                            │   ws_ticket:{ticket}       │
  │                            │◄── { user_id, ws_id, ... }─│
  │                            │── Redis DEL ───────────────►
  │                            │   (single-use: delete      │
  │                            │    ticket after validation) │
  │                            │                            │
  │◄── WS Upgrade OK ─────────│                            │
```

**Ticket properties**:
- **Single-use**: Deleted from Redis immediately after successful validation. Replay is impossible.
- **Short-lived**: 30-second TTL. If not used within 30s, it expires automatically.
- **Opaque**: Contains no user data. The ticket is a random key; all user context is stored server-side in Redis.
- **Scoped**: The ticket is bound to a specific `document_id`. It cannot be used to connect to a different document.

### Connection Lifecycle

```
Client                    Collab Server                Redis              PostgreSQL / MinIO
  │                            │                         │                      │
  │── WS Connect ────────────►│                         │                      │
  │   (?ticket=<opaque>)      │                         │                      │
  │                           │── Validate ticket (Redis GET + DEL) ───────────►
  │                           │   Extract user_id, workspace_id                │
  │                           │◄──────────────────────────────────── OK ────────│
  │                           │                         │                      │
  │                           │── Check workspace ──────────────────────────────►
  │                           │   membership (PostgreSQL)                      │
  │                           │◄──────────────────────────────────── OK ────────│
  │                           │                         │                      │
  │                           │── SUBSCRIBE doc:{id} ──►│                      │
  │                           │                         │                      │
  │                           │── Load Y.Doc ──────────────────────────────────►│
  │                           │   (from MinIO snapshot                         │
  │                           │    or create new)                              │
  │                           │◄─────────────────────────────── Y.Doc state ───│
  │                           │                         │                      │
  │◄── Sync Step 1 ──────────│  (send full state)      │                      │
  │── Sync Step 2 ───────────►│  (client sends its state)                     │
  │◄── Sync Complete ────────│                         │                      │
  │                           │                         │                      │
  │                           │── Presence: join ──────►│ (PUBLISH)            │
  │◄── Awareness update ─────│                         │                      │
  │                           │                         │                      │
  │   ┌─── EDITING LOOP ────────────────────────────┐  │                      │
  │   │                       │                     │  │                      │
  │──►│── Yjs update ────────►│                     │  │                      │
  │   │                       │── PUBLISH ──────────│─►│                      │
  │   │                       │                     │  │── relay to other ────►│
  │   │                       │                     │  │   server instances    │
  │   │                       │── Broadcast to ─────│──│──────────────────────►│
  │   │                       │   local clients     │  │   (other clients     │
  │   │                       │                     │  │    on this node)      │
  │◄──│── Yjs updates ───────│   (from other users) │  │                      │
  │   │                       │                     │  │                      │
  │   └─────────────────────────────────────────────┘  │                      │
  │                           │                         │                      │
  │                           │── Debounced recovery ───────────────────────────►
  │                           │   snapshot (every ~2s   │                      │
  │                           │    of inactivity)       │   MinIO: latest.yjs  │
  │                           │                         │   PG: metadata update │
  │                           │                         │   pg-boss: index job  │
```

### Document Room Management

Each document being actively edited has an in-memory **room** on the Collab Server:

```
Room {
    documentId: UUID
    yDoc: Y.Doc                    // in-memory CRDT state
    connections: Set<WebSocket>    // connected clients on this node
    lastEdit: Timestamp            // for snapshot debounce
    snapshotTimer: Timer           // fires after inactivity threshold
}
```

**Room lifecycle**:
- **Created** when the first client connects to a document on this server node
- **Loaded** from the latest MinIO recovery snapshot (or empty `Y.Doc` for new documents)
- **Active** as long as at least one client is connected
- **Recovery-snapshotted** on a debounce timer (e.g., 2 seconds after last edit) — overwrites `snapshots/{doc_id}/latest.yjs` in-place
- **Version-checkpointed** on session end (last editor disconnects) or configurable interval — creates a new `document_versions` row
- **Evicted** from memory after all clients disconnect and final snapshot + version checkpoint are persisted

### Multi-Node Sync via Redis

When the Collab Server scales to multiple instances:

1. Each instance subscribes to Redis channel `doc:{document_id}` for every active room.
2. When a Yjs update arrives on one instance, it is:
   - Applied to the local `Y.Doc`
   - Broadcast to local WebSocket connections
   - Published to `doc:{document_id}` on Redis
3. Other instances receive the Redis message, apply the update to their local `Y.Doc`, and broadcast to their local connections.

### Redis Outage Recovery & Anti-Divergence Protocol

> [!NOTE]
> **Resolved (v1.1)**: Redis pub/sub is not durable. Messages published during a Redis outage are lost, which can cause silent multi-node Y.Doc divergence. The following protocol prevents this.

**Problem**: If Redis goes down for 10 seconds and Node A and Node B both receive edits during that window, neither node sees the other's edits. When Redis recovers, pub/sub resumes for *new* messages, but the edits made during the outage are never relayed. The two nodes now have divergent Y.Doc state.

**Solution: Periodic state vector reconciliation**

Each Collab Server instance implements a reconciliation protocol:

```
┌──────────────────────────────────────────────────────────────────┐
│  Reconciliation Protocol (per active room, every 5 seconds)     │
│                                                                  │
│  1. Each node publishes its Y.Doc state vector to Redis:         │
│     PUBLISH doc:{id}:sv { node_id, state_vector, timestamp }    │
│                                                                  │
│  2. Each node receiving a foreign state vector compares it       │
│     against its local Y.Doc state vector.                        │
│                                                                  │
│  3. If the foreign state vector contains entries NOT in the      │
│     local state (i.e., the remote node has edits we're missing): │
│     → Request missing updates via Redis:                         │
│       PUBLISH doc:{id}:sync_request { requesting_node,           │
│                                        state_vector }            │
│                                                                  │
│  4. The node with the missing edits responds:                    │
│     → PUBLISH doc:{id}:sync_response { target_node,              │
│                                         yjs_update_binary }      │
│                                                                  │
│  5. Requesting node applies the update via Y.applyUpdate().      │
│     Yjs CRDT guarantees idempotent, conflict-free merge.         │
└──────────────────────────────────────────────────────────────────┘
```

**Why this works**:
- Yjs state vectors are compact (a map of client IDs to clocks). Comparing them is O(n) where n is the number of unique editor sessions, not document size.
- Yjs `encodeStateAsUpdate(doc, remoteStateVector)` produces only the delta — the updates the remote node is missing.
- Yjs updates are idempotent. Applying the same update twice is a no-op. There is no risk of data corruption from duplicate reconciliation.
- The 5-second interval bounds the maximum divergence window to 5 seconds, regardless of Redis outage duration.

**Redis outage scenario walkthrough**:

| Time | Event | Node A State | Node B State |
|---|---|---|---|
| T+0s | Redis goes down | Has edits X | Has edits Y |
| T+0-10s | Edits continue locally, pub/sub silent | X + X' | Y + Y' |
| T+10s | Redis recovers | X + X' | Y + Y' |
| T+10s | Next reconciliation tick fires | Publishes SV(X+X') | Publishes SV(Y+Y') |
| T+10s | Nodes detect divergence | Requests Y+Y' delta | Requests X+X' delta |
| T+10s | Delta exchange | Applies Y+Y' | Applies X+X' |
| T+10s | **Converged** | X+X'+Y+Y' | X+X'+Y+Y' |

**Fallback**: If Redis is down for longer than 30 seconds, nodes fall back to **snapshot-based reconciliation**: each node persists its Y.Doc to MinIO and broadcasts a reconciliation request when Redis recovers. Other nodes load the snapshot and merge via `Y.applyUpdate()`.

**Single-node deployment**: When running a single Collab Server instance (internal alpha), this protocol is dormant — there is no cross-node divergence risk. It activates automatically when multiple instances subscribe to the same document channel.

### Presence & Live Cursors

Yjs Awareness protocol handles presence:
- Each client broadcasts cursor position, selection range, and user info via Awareness updates
- Awareness updates are lightweight (not persisted) and flow through the same WebSocket + Redis pub/sub channel
- Presence state is stored transiently in Redis with a TTL (e.g., 30 seconds) for the API to query ("who is currently viewing this document?")

### Snapshot Persistence & Versioning

> [!NOTE]
> **Resolved (v1.1)**: Recovery snapshots (high-frequency, internal) are separated from user-visible version checkpoints. The debounced snapshot timer does NOT create a version history entry.

```
Edit occurs
    │
    ▼
Recovery snapshot debounce timer resets (2s default)
    │
    ├── Timer fires (no edits for 2s)
    │       │
    │       ▼
    │   Encode Y.Doc → binary
    │       │
    │       ├── Overwrite MinIO: snapshots/{doc_id}/latest.yjs (recovery snapshot)
    │       ├── Update PostgreSQL: documents.snapshot_key, snapshot_version++
    │       ├── Extract plaintext → update documents.content_text (triggers tsvector rebuild)
    │       ├── Enqueue pg-boss job: 'index.document' { document_id, version }
    │       └── (NO version history entry — this is a recovery snapshot only)
    │
    └── Another edit arrives → timer resets


Version checkpoint triggers (separate from recovery snapshots):
    │
    ├── User explicitly saves (Ctrl+S / "Save version" button)
    │       trigger = 'manual'
    │
    ├── Auto-interval (e.g., every 30 minutes of active editing)
    │       trigger = 'auto_interval'
    │
    └── Last editor disconnects (session end)
            trigger = 'session_end'
            │
            ▼
        Copy current Y.Doc binary → MinIO: versions/{doc_id}/{version_number}.yjs
        Insert document_versions row
        Audit: 'document.version.created'
```

### Offline-Read Support

Per PRD: offline write is v2, offline read is v1.

- On document open, the client receives the full `Y.Doc` state and can cache it in IndexedDB (`y-indexeddb`)
- If the WebSocket disconnects, the cached document remains readable
- Edits are blocked (UI shows "reconnecting..." state) until the WebSocket re-establishes
- On reconnect, Yjs sync protocol merges any state divergence automatically (handles the case where the server snapshot advanced while the client was disconnected)

---

## 6. Event-Driven Architecture

### pg-boss as the Event Bus

pg-boss uses PostgreSQL as a durable job queue. It provides:
- **Named queues** (one per job type)
- **At-least-once delivery** with configurable retry (NOT exactly-once)
- **Dead-letter queue** for failed jobs
- **Job expiration** and TTL
- **Completion callbacks**
- **Singleton jobs** (ensure only one instance of a job runs at a time per key)

> [!WARNING]
> **Resolved (v1.1)**: pg-boss provides **at-least-once** delivery, not exactly-once. A job may be delivered and processed more than once if a worker crashes after completing work but before calling `boss.complete()`, or if a job times out and is re-queued while still being processed. **All workers MUST be explicitly idempotent.**

### Worker Idempotency Design

Every worker must produce the same result whether executed once or multiple times for the same job. This table defines the idempotency key and strategy for each worker:

| Worker | Idempotency Key | Strategy | Why It's Safe to Re-Execute |
|---|---|---|---|
| **Indexing Worker** | `document_id + version` | Check `documents.snapshot_version` before processing. Skip if current version > job version (stale job). FTS update is a full overwrite (`UPDATE documents SET content_text = ...`) — running it twice with the same content is a no-op. | Overwrite semantics: the tsvector column is recomputed from content_text, which is a deterministic extraction from the snapshot. Same input → same output. |
| **Embedding Worker** | `document_id + chunk_index + content_hash` | Qdrant upsert uses a **deterministic point ID**: `UUID5(document_id + chunk_index)`. Upserting the same vector+payload to the same point ID is an idempotent overwrite. Before embedding, compare `content_hash` in job payload against Qdrant payload — skip if unchanged. | Deterministic IDs + upsert = idempotent. Re-embedding the same text produces the same vector (embeddings are deterministic for the same model). |
| **AI Suggestion Worker** | `document_id + version + type + prompt_hash` | Before inserting a suggestion, query `ai_suggestions` for an existing row with the same `document_id + prompt_hash + type` in `pending` status. If found, skip. | Deduplication check prevents duplicate suggestions. If the check fails (race condition), the worst case is a duplicate pending suggestion — low-severity, visible to user. |
| **Permission Sync Worker** | `document_id + sorted(user_ids) + action` | Read current permissions from PostgreSQL (source of truth), recompute the full `permitted_user_ids` list, and overwrite the Qdrant payload. Do NOT apply incremental grant/revoke — always recompute from source. | Full recomputation from PostgreSQL means the result is always correct regardless of how many times or in what order jobs are processed. |
| **Compaction Worker** | `document_id` | Load Y.Doc from MinIO, compact (gc), re-save. If the snapshot hasn't changed since the job was enqueued, skip. | CRDT compaction is idempotent: compacting an already-compacted document is a no-op. |

### Event / Job Types

| Queue Name | Producer | Consumer | Payload | Singleton Key |
|---|---|---|---|---|
| `index.document` | Collab Server (on snapshot) | Indexing Worker | `{ document_id, version, workspace_id }` | `document_id` (deduplicates rapid re-fires) |
| `embed.document` | Indexing Worker (after FTS update) | Embedding Worker | `{ document_id, version, chunks[{index, text, hash}] }` | `document_id` |
| `ai.suggest` | Suggestion Trigger (debounced) or API (on-demand) | AI Suggestion Worker | `{ document_id, version, type, user_id, prompt_hash }` | `document_id:type` |
| `permissions.sync` | API Server (on permission change) | Permission Sync Worker | `{ document_id, user_ids[], action }` | `document_id` |
| `snapshot.compact` | Scheduled (cron) | Compaction Worker | `{ document_id }` | `document_id` |

### Job Lifecycle

```
Enqueue                     pg-boss                        Worker
   │                          │                              │
   │── boss.send(queue, ─────►│                              │
   │   payload, options)      │                              │
   │                          │── (polling or LISTEN/NOTIFY)─►│
   │                          │                              │── Idempotency check
   │                          │                              │   (skip if already done)
   │                          │                              │── Process job
   │                          │                              │
   │                          │   ┌── On success:            │
   │                          │◄──┤   boss.complete(jobId)   │
   │                          │   │                          │
   │                          │   ├── On failure:            │
   │                          │◄──┤   boss.fail(jobId, err)  │
   │                          │   │   → retry (up to N)      │
   │                          │   │   → dead-letter after N  │
   │                          │   │                          │
   │                          │   └── On timeout:            │
   │                          │       → auto-retry           │
   │                          │       (worker must be         │
   │                          │        idempotent!)           │
   │                          │                              │
```

### Decoupling Guarantee

The Collab Server's hot path is:

```
Receive Yjs update → Apply to Y.Doc → Broadcast via Redis → Done
```

Snapshot persistence and job enqueuing happen on the **debounced snapshot timer**, not on every keystroke. Even if PostgreSQL is temporarily slow, the editing loop is unaffected — edits are held in memory and the snapshot timer simply fires later. This enforces the PRD requirement that "AI latency can never affect editing latency."

### Re-indexing Strategy

Without Kafka log replay, full re-indexing is triggered by a script that:

1. Queries `SELECT id, workspace_id FROM documents`
2. Enqueues an `index.document` job for each document
3. Workers process them through the normal pipeline (idempotent — safe to re-run)

This is an operational command, not an architectural feature. It runs in minutes for v1-scale document counts.

---

## 7. Search / Indexing Pipeline

### Dual Search Architecture

```
User Search Query
       │
       ▼
┌──────────────┐
│ Search API    │
│  Endpoint     │
└──────┬───────┘
       │
       ├── Resolve user's permitted document IDs
       │   (from workspace_members + document_permissions)
       │
       ├─────────────────────┬──────────────────────────┐
       │                     │                          │
       ▼                     ▼                          │
┌──────────────┐   ┌──────────────────┐                 │
│ PostgreSQL   │   │     Qdrant        │                │
│ FTS Query    │   │ Semantic Query    │                │
│              │   │                   │                │
│ WHERE doc_id │   │ filter:           │                │
│ IN (permitted│   │  workspace_id +   │                │
│ _ids)        │   │  permitted_user_  │                │
│              │   │  ids.any(user_id) │                │
│ ts_rank()    │   │                   │                │
└──────┬───────┘   └────────┬──────────┘                │
       │                     │                          │
       ▼                     ▼                          │
┌─────────────────────────────────────┐                 │
│         Result Merger               │                 │
│                                     │                 │
│  • Deduplicate by document_id       │                 │
│  • Combine scores (weighted)        │                 │
│  • Sort by combined relevance       │                 │
│  • Attach document metadata         │                 │
│  • Return top N                     │                 │
└─────────────────────────────────────┘
```

### Indexing Pipeline (< 5s Freshness SLA)

```
Snapshot persisted
       │
       ▼
pg-boss: index.document { document_id, version }
       │
       ▼
┌──────────────────────────────────────┐
│         Indexing Worker              │
│                                      │
│  1. Load document from PostgreSQL    │
│  2. Extract plaintext from Y.Doc    │
│     (if not already in content_text) │
│  3. UPDATE documents                 │
│     SET content_text = :plaintext    │
│     (triggers tsvector rebuild)      │
│                                      │
│  4. Chunk plaintext                  │
│     (e.g., 512-token chunks with    │
│      128-token overlap)             │
│                                      │
│  5. For each chunk:                  │
│     • Hash chunk text               │
│     • Skip if hash matches Qdrant   │
│       payload (dirty-check)         │
│                                      │
│  6. Enqueue embed.document job       │
│     with only dirty chunks           │
└──────────────────┬───────────────────┘
                   │
                   ▼
pg-boss: embed.document { document_id, chunks[] }
                   │
                   ▼
┌──────────────────────────────────────┐
│        Embedding Worker              │
│                                      │
│  1. Call LiteLLM (embedding model)   │
│     with dirty chunk texts           │
│                                      │
│  2. Resolve permitted_user_ids:      │
│     • All workspace members with     │
│       role != 'none' on this doc     │
│     • MINUS users with explicit      │
│       'none' doc permission          │
│                                      │
│  3. Upsert to Qdrant:               │
│     • vector: embedding             │
│     • payload: workspace_id,         │
│       document_id, chunk_index,      │
│       chunk_text, document_title,    │
│       permitted_user_ids,            │
│       content_hash, updated_at       │
│                                      │
│  4. Delete stale chunks              │
│     (chunk_index > new chunk count)  │
└──────────────────────────────────────┘
```

### Freshness Budget

The <5s SLA from edit to searchable is allocated as:

| Step | Budget |
|---|---|
| Snapshot debounce (time since last edit) | ~2s |
| pg-boss job pickup latency | ~100ms |
| FTS update (PostgreSQL, in-transaction) | ~50ms |
| Chunking + dirty check | ~100ms |
| Embedding API call | ~500ms–1.5s |
| Qdrant upsert | ~100ms |
| **Total** | **~3-4s typical** |

FTS is searchable after step 3 (~2.2s). Semantic search is searchable after step 6 (~3-4s). Both within the 5s SLA.

### Permission Sync on Access Change

> [!IMPORTANT]
> **Resolved (v1.1)**: PostgreSQL is the **authoritative source** for all permission decisions. Qdrant's `permitted_user_ids` payload is a performance optimization for vector search filtering, NOT the source of truth. Permission revocation MUST NOT depend solely on asynchronous Qdrant synchronization.

When a user's permissions change (added/removed from workspace, document permission changed):

1. **Synchronous (immediate)**: The permission change is written to PostgreSQL (`workspace_members` or `document_permissions`). From this moment, all application-level authorization checks (Layer 1) and PostgreSQL RLS (Layer 3) immediately reflect the new state.
2. **Asynchronous (eventual)**: API Server enqueues `permissions.sync` job to update Qdrant's `permitted_user_ids` payload.
3. Permission Sync Worker **recomputes** the full `permitted_user_ids` list from PostgreSQL (not incremental) and overwrites the Qdrant payload. This is a metadata-only update (no re-embedding).

**Critical: RAG query during Qdrant sync lag**

Between steps 1 and 3, there is a window where Qdrant's payload may be stale (e.g., a revoked user's ID is still in `permitted_user_ids`). To prevent this from leaking content:

```
RAG Query Flow (with permission verification):

  1. Query Qdrant with permitted_user_ids filter (Layer 2 — fast, pre-filter)
  2. Receive candidate chunks
  3. Extract unique document_ids from candidate chunks
  4. VERIFY against PostgreSQL: ← NEW synchronous check
     SELECT document_id FROM (
       -- documents where user has access
       SELECT d.id AS document_id
       FROM documents d
       JOIN workspace_members wm ON wm.workspace_id = d.workspace_id
       WHERE wm.user_id = :user_id
       AND NOT EXISTS (
         SELECT 1 FROM document_permissions dp
         WHERE dp.document_id = d.id
         AND dp.user_id = :user_id
         AND dp.role = 'none'
       )
     ) AS permitted
     WHERE document_id = ANY(:candidate_doc_ids)
  5. Remove any chunks whose document_id is NOT in the verified set
  6. Proceed with LLM generation using ONLY verified chunks
```

This adds ~1-5ms (a single indexed PostgreSQL query) but guarantees that **no revoked content ever reaches the LLM**, even during the Qdrant sync lag window. Qdrant's payload filter remains the primary mechanism for reducing the candidate set efficiently; the PostgreSQL verification is a lightweight confirmation pass, not a replacement for Qdrant filtering.

---

## 8. Permission-Aware RAG Architecture

### Four-Layer Permission Enforcement

> [!NOTE]
> **Resolved (v1.1)**: Upgraded from three layers to four. Added a synchronous PostgreSQL verification step between Qdrant retrieval and LLM generation to eliminate the permission revocation race window.

The PRD's security requirement — *"enforced before the chunk reaches the language model, not filtered from the output afterward"* — is implemented through four independent layers:

```
Layer 1: Application Authorization
       │
       │  API endpoint checks: is this user a member of this workspace?
       │  Does user have at least 'viewer' role?
       │  Reject request if not.
       │
       ▼
Layer 2: Qdrant Payload Filtering (Performance)
       │
       │  Vector search query includes mandatory filter:
       │    permitted_user_ids CONTAINS requesting_user_id
       │    AND workspace_id = user's workspace
       │
       │  Qdrant applies this filter DURING ANN search, not after.
       │  This is the primary mechanism for efficient retrieval.
       │  Note: permitted_user_ids may be stale during async sync.
       │
       ▼
Layer 3: PostgreSQL Permission Verification (Authority)
       │
       │  After Qdrant returns candidate chunks, verify each chunk's
       │  document_id against PostgreSQL (the authoritative permission
       │  source). Remove any chunks the user no longer has access to.
       │  This eliminates the Qdrant sync-lag race window.
       │
       ▼
Layer 4: PostgreSQL RLS (Defense-in-Depth)
       │
       │  If any supplementary data is loaded from PostgreSQL during
       │  response generation (e.g., document metadata for citations),
       │  RLS policies enforce that the user can only see rows they
       │  have access to — even if application code has a bug.
       │
       ▼
LLM receives ONLY authorized content
```

**Why four layers**: Layers 1 and 2 are fast pre-filters. Layer 3 is the correctness guarantee — it uses PostgreSQL (the single source of truth for permissions) to confirm every chunk that will reach the LLM. Layer 4 is defense-in-depth for any supplementary data loaded during prompt construction.

### RAG Query Flow

```
User asks: "What did we decide about the API versioning strategy?"
       │
       ▼
┌──────────────────────────────────────────────────────────────┐
│  API Server: /api/v1/ai/ask                                  │
│                                                               │
│  1. Authenticate (JWT)                                        │
│  2. Authorize (workspace membership check — Layer 1)          │
│  3. Embed the question via LiteLLM (embedding model)          │
│  4. Query Qdrant:                                             │
│     {                                                         │
│       "vector": <question_embedding>,                         │
│       "filter": {                                             │
│         "must": [                                             │
│           { "key": "workspace_id", "match": "<ws_id>" },     │
│           { "key": "permitted_user_ids",                      │
│             "match": { "any": ["<user_id>"] } }  ← Layer 2   │
│         ]                                                     │
│       },                                                      │
│       "limit": 10,                                            │
│       "with_payload": true                                    │
│     }                                                         │
│                                                               │
│  5. Receive top-K chunks (all permission-verified)            │
│                                                               │
│  6. Build LLM prompt:                                         │
│     System: "Answer using ONLY the provided context.          │
│              Cite sources by document title.                   │
│              If the context doesn't contain the answer,       │
│              say so."                                          │
│     Context: [chunk_1.text, chunk_2.text, ...]                │
│     Question: "What did we decide about API versioning?"      │
│                                                               │
│  7. Stream response from LiteLLM (generation model)           │
│     to client via SSE or chunked HTTP response                │
│                                                               │
│  8. Log to audit_events:                                      │
│     action: 'ai.qa.query'                                     │
│     metadata: { question, model, chunk_count,                 │
│                 document_ids_referenced }                     │
└──────────────────────────────────────────────────────────────┘
```

### What Never Happens

- Chunks are **never** retrieved without a permission filter
- The LLM **never** receives content the user couldn't see directly
- Answers are **never** post-filtered (the generation model never sees unauthorized content)
- The question embedding is **never** compared against unauthorized vectors (Qdrant applies the filter during the ANN search, not after ranking)

### Response Caching

To mitigate LLM cost (PRD §11):
- Cache key: `hash(question_embedding + sorted(permitted_document_ids) + model_id)`
- Cache in Redis with configurable TTL (e.g., 5 minutes)
- Cache is invalidated when any referenced document is re-indexed
- Cache is **per-user** (because permitted document sets differ per user) — but users with identical permission sets share cache entries

---

## 9. Authentication / RBAC Architecture

### Authentication Flow

```
┌─────────┐     ┌─────────────┐     ┌─────────────────┐     ┌──────────┐
│  Client  │     │  Auth       │     │  OAuth Provider  │     │PostgreSQL│
│          │     │  Service    │     │  (Google, GitHub, │     │          │
│          │     │             │     │   SAML IdP)      │     │          │
└────┬─────┘     └──────┬──────┘     └────────┬─────────┘     └────┬─────┘
     │                  │                      │                    │
     │── Login click ──►│                      │                    │
     │                  │── OAuth redirect ───►│                    │
     │                  │                      │                    │
     │                  │◄── Auth code ────────│                    │
     │                  │                      │                    │
     │                  │── Exchange code ────►│                    │
     │                  │◄── ID token ────────│                    │
     │                  │                      │                    │
     │                  │── Upsert user ──────────────────────────►│
     │                  │   (auth_provider +   │                    │
     │                  │    auth_subject)      │                    │
     │                  │◄─────────────────────────────── user_id ─│
     │                  │                      │                    │
     │                  │── Issue JWT ─────────│                    │
     │◄── Set cookie ──│   (short-lived,       │                    │
     │   + refresh tok  │    contains user_id,  │                    │
     │                  │    workspace_ids)     │                    │
     │                  │                      │                    │
```

### JWT Structure

```json
{
  "sub": "<user_id>",
  "email": "user@example.com",
  "workspaces": [
    { "id": "<ws_id>", "role": "editor" }
  ],
  "iat": 1724000000,
  "exp": 1724003600  // 1 hour
}
```

- **Access token**: Short-lived (1 hour), stored in memory (not localStorage)
- **Refresh token**: Longer-lived (7 days), stored in HttpOnly cookie, rotated on use
- **WebSocket auth**: Short-lived opaque ticket obtained via authenticated HTTP endpoint (see §5 — WebSocket Authentication). Ticket is single-use, 30-second TTL, scoped to a specific document. Access tokens are **never** passed in WebSocket query parameters.

### Role Hierarchy & Capabilities

```
owner > admin > editor > viewer
```

| Capability | owner | admin | editor | viewer |
|---|---|---|---|---|
| Manage workspace settings | ✅ | ✅ | ❌ | ❌ |
| Manage workspace members | ✅ | ✅ | ❌ | ❌ |
| Delete workspace | ✅ | ❌ | ❌ | ❌ |
| Set document permissions | ✅ | ✅ | ✅ (own docs) | ❌ |
| Create documents | ✅ | ✅ | ✅ | ❌ |
| Edit documents | ✅ | ✅ | ✅ | ❌ |
| View documents | ✅ | ✅ | ✅ | ✅ |
| Ask AI questions | ✅ | ✅ | ✅ | ✅ |
| Accept/reject AI suggestions | ✅ | ✅ | ✅ | ❌ |
| View audit log | ✅ | ✅ | ❌ | ❌ |
| Trigger AI suggestions (on-demand) | ✅ | ✅ | ✅ | ❌ |

### Permission Resolution

For any operation on a document, the effective role is resolved as:

```
effective_role(user, document) =
    IF document_permissions has entry for (document_id, user_id):
        IF role = 'none': DENY
        ELSE: document_permissions.role
    ELSE:
        workspace_members.role (workspace-level default)
```

Document-level permissions **override** workspace-level, they do not merge. A workspace editor can be explicitly set to 'viewer' or 'none' on a specific document.

### Middleware Stack

Every API request passes through:

```
Request
  → Rate Limiter
  → JWT Validation (signature, expiry)
  → User Context Injection (set app.current_user_id for RLS)
  → Workspace Membership Check
  → Route-specific authorization (role capability check)
  → Handler
```

---

## 10. AI Suggestion Workflow

### Trigger Model (Hybrid)

```
                    ┌─────────────────────────┐
                    │    Document Edited       │
                    └───────────┬──────────────┘
                                │
                    ┌───────────▼──────────────┐
                    │  Debounce Timer (30s)    │
                    │  Reset on each edit      │
                    └───────────┬──────────────┘
                                │ (fires after 30s of inactivity)
                                │
                    ┌───────────▼──────────────┐
                    │  Enqueue pg-boss job:    │
                    │  'ai.suggest'            │
                    │  { document_id, version, │
                    │    type: 'auto',         │
                    │    user_id: null }        │
                    └──────────────────────────┘

         OR (explicit trigger):

                    ┌─────────────────────────┐
                    │  User clicks "Suggest"  │
                    └───────────┬──────────────┘
                                │
                    ┌───────────▼──────────────┐
                    │  API: POST /suggest      │
                    │  Enqueue pg-boss job:    │
                    │  'ai.suggest'            │
                    │  { document_id, version, │
                    │    type: 'on_demand',    │
                    │    user_id: <requester>} │
                    └──────────────────────────┘
```

### Suggestion Pipeline

```
┌───────────────────────────────────────────────────────────────┐
│                AI Suggestion Worker                            │
│                                                                │
│  1. Dequeue job from 'ai.suggest'                             │
│                                                                │
│  2. Load document plaintext from PostgreSQL                    │
│     (or from latest snapshot in MinIO if more complete)        │
│                                                                │
│  3. Check: has document changed since job was enqueued?        │
│     (compare version in job payload vs current version)        │
│     If stale: skip (a newer job will be enqueued)             │
│                                                                │
│  4. Generate suggestions via LiteLLM:                          │
│                                                                │
│     ┌─── Summary ────────────────────────────────────┐         │
│     │ Prompt: "Summarize this document in 2-3        │         │
│     │         sentences."                            │         │
│     │ Model: config.ai.providers.suggestions.model   │         │
│     └────────────────────────────────────────────────┘         │
│                                                                │
│     ┌─── Tags ───────────────────────────────────────┐         │
│     │ Prompt: "Suggest 3-5 tags for this document.   │         │
│     │         Return as JSON array."                 │         │
│     │ Model: config.ai.providers.tags.model          │         │
│     │ (can use cheaper/local model)                  │         │
│     └────────────────────────────────────────────────┘         │
│                                                                │
│     ┌─── Rewrite (if doc > threshold length) ────────┐         │
│     │ Prompt: "Suggest improvements for clarity      │         │
│     │         and conciseness. Return as structured   │         │
│     │         edits."                                 │         │
│     │ Model: config.ai.providers.generation.qa.model │         │
│     └────────────────────────────────────────────────┘         │
│                                                                │
│  5. Deduplicate: hash prompt + document content.               │
│     If an identical pending suggestion exists, skip.           │
│                                                                │
│  6. Insert into ai_suggestions table:                          │
│     status = 'pending'                                         │
│     model_id = <model used>                                    │
│     provider = <provider used>                                 │
│                                                                │
│  7. Log to audit_events:                                       │
│     action = 'ai.suggestion.created'                           │
│                                                                │
│  8. Notify connected clients via Redis pub/sub:                │
│     channel: 'doc:{document_id}:suggestions'                   │
│     payload: { suggestion_id, type }                           │
└───────────────────────────────────────────────────────────────┘
```

### Accept / Reject Flow

```
User sees pending suggestion in editor sidebar
       │
       ├── Accept ──► API: PATCH /suggestions/{id} { status: 'accepted' }
       │                  │
       │                  ├── Apply suggestion content to Y.Doc
       │                  │   (as a regular Yjs update, attributed to user)
       │                  ├── Update ai_suggestions.status = 'accepted'
       │                  ├── Audit: 'ai.suggestion.accepted'
       │                  └── The Yjs update propagates to all clients normally
       │
       └── Reject ──► API: PATCH /suggestions/{id} { status: 'rejected' }
                          │
                          ├── Update ai_suggestions.status = 'rejected'
                          └── Audit: 'ai.suggestion.rejected'
```

AI suggestions **never** modify the document directly. The accept action creates a standard Yjs update attributed to the accepting user — it flows through the same collaboration pipeline as any manual edit.

### Cost Controls

| Control | Mechanism |
|---|---|
| Per-workspace token budget | Track tokens consumed per workspace per month in PostgreSQL. Reject suggestion jobs when budget exceeded. |
| Model routing by task | Config-driven: cheap/local models for tags, capable models for Q&A (PRD §11 mitigation). |
| Deduplication | Skip suggestion generation if identical prompt+content hash already has a pending suggestion. |
| Debounce | 30s inactivity threshold prevents suggestion storms during active editing. |
| Singleton jobs | pg-boss singleton key `document_id:type` ensures only one suggestion job per type per document in the queue. |

---

## 11. Audit Logging Architecture

### What Gets Logged

| Category | Actions |
|---|---|
| **Document lifecycle** | `document.created`, `document.updated` (snapshot), `document.deleted`, `document.restored` |
| **Permissions** | `permission.granted`, `permission.revoked`, `permission.changed` |
| **AI actions** | `ai.qa.query`, `ai.suggestion.created`, `ai.suggestion.accepted`, `ai.suggestion.rejected` |
| **Workspace admin** | `workspace.member.added`, `workspace.member.removed`, `workspace.member.role_changed`, `workspace.settings.updated` |
| **Auth** | `auth.login`, `auth.logout`, `auth.token.refreshed` |

### Write Path

Audit events are written by a shared utility function called from any service:

```
Any Service ──► auditLog.emit({
                    action, resourceType, resourceId,
                    metadata, workspaceId
                })
                    │
                    ▼
              INSERT INTO audit_events
              (within the existing transaction if one is active,
               or in a new transaction if not)
```

Audit writes are **synchronous** (in the same database transaction as the operation they log, where possible). This guarantees that if the operation succeeds, the audit record exists. If the transaction rolls back, the audit record rolls back too — no phantom audit entries.

For operations where transactional consistency isn't possible (e.g., audit of an external API call), the audit write is best-effort with a retry mechanism.

### Audit Log Properties

| Property | Implementation |
|---|---|
| **Append-only** | No `UPDATE` or `DELETE` grants on `audit_events` for the application role. Only `INSERT` and `SELECT`. |
| **Tamper-evident** | Application role cannot modify existing rows. DBA access is controlled by operational policy. |
| **Partitioned** | Monthly partitions via `PARTITION BY RANGE (created_at)`. Old partitions can be archived or dropped per retention policy. |
| **Queryable** | Indexed by `workspace_id + created_at`, `resource_type + resource_id`, and `actor_id`. Supports admin UI queries like "show me all AI actions in the last 7 days." |
| **Retention** | Configurable per workspace (default: 1 year). Implemented by dropping/archiving old partitions. |

### Query Patterns for Admin UI

```sql
-- Recent AI actions in a workspace
SELECT * FROM audit_events
WHERE workspace_id = :ws_id
  AND action LIKE 'ai.%'
  AND created_at > now() - interval '7 days'
ORDER BY created_at DESC
LIMIT 50;

-- All actions on a specific document
SELECT * FROM audit_events
WHERE resource_type = 'document'
  AND resource_id = :doc_id
ORDER BY created_at DESC;

-- User activity timeline
SELECT * FROM audit_events
WHERE actor_id = :user_id
  AND workspace_id = :ws_id
ORDER BY created_at DESC
LIMIT 100;
```

---

## 12. Failure / Recovery Scenarios

### WebSocket Disconnect (Client ↔ Collab Server)

| Scenario | Impact | Recovery |
|---|---|---|
| Client loses network | Client cannot send/receive edits. Other clients unaffected. | Yjs reconnect protocol: client reconnects, obtains a new WS ticket, sends its state vector, server responds with missing updates. Edits merge automatically. |
| Collab Server crashes | All clients on that instance disconnect. In-memory Y.Doc state lost. | Clients reconnect (possibly to another instance). New instance loads latest recovery snapshot from MinIO. Any edits between last recovery snapshot and crash are lost (bounded by snapshot debounce interval: max ~2s of edits). |
| Redis unavailable (single-node) | No impact — no cross-node fan-out needed. | N/A |
| Redis unavailable (multi-node) | Cross-node fan-out pauses. Nodes accumulate local edits independently. | **State vector reconciliation protocol** (§5) detects divergence within 5 seconds of Redis recovery. Nodes exchange missing updates via Yjs delta encoding. Full convergence is automatic and idempotent. Maximum divergence window = Redis outage duration + 5 seconds. See §5 for detailed protocol. |
| Redis unavailable > 30 seconds (multi-node) | Extended divergence risk. | Nodes fall back to snapshot-based reconciliation: persist Y.Doc to MinIO, load and merge on Redis recovery. |

**Mitigation for Collab Server crash**: The recovery snapshot debounce interval (2s) bounds the worst-case data loss. For critical documents with many concurrent editors, the interval can be reduced to 500ms at the cost of more MinIO writes.

### PostgreSQL Failure

| Scenario | Impact | Recovery |
|---|---|---|
| PostgreSQL down | No new jobs enqueued. No permission checks. No FTS. Audit writes fail. | **Editing continues** — Yjs sync uses WebSocket + Redis, not PostgreSQL. Search, AI Q&A, and admin operations are unavailable. |
| Slow queries | Job processing slows. API latency increases. | Connection pool limits prevent cascading failure. Circuit breaker on API endpoints returns 503. Editing unaffected. |

**Key design property**: PostgreSQL is not in the edit-propagation hot path. A PostgreSQL outage degrades search, AI, and admin features but does **not** degrade real-time editing.

### Qdrant Failure

| Scenario | Impact | Recovery |
|---|---|---|
| Qdrant down | Semantic search and AI Q&A unavailable. Embedding jobs fail and enter retry queue. | FTS (PostgreSQL) continues working. AI Q&A returns graceful error. Embedding jobs retry with backoff via pg-boss. When Qdrant recovers, backlog of embedding jobs processes automatically. |
| Qdrant data loss | Semantic search returns incomplete results. | Full re-index from PostgreSQL documents table. All embeddings are regenerable from source text. |

### AI Provider Failure (LiteLLM / Upstream API)

| Scenario | Impact | Recovery |
|---|---|---|
| Embedding API down | New document changes are not embedded. Semantic search serves stale results. | pg-boss retries with exponential backoff. FTS still works. UI shows "indexing" indicator. |
| Generation API down | AI Q&A and suggestion generation fail. | API returns graceful error ("AI features temporarily unavailable"). Editing, search, and all non-AI features continue. PRD user story: "editing keeps working even if AI features are briefly unavailable." |
| LiteLLM proxy down | All AI features unavailable. | Same as generation API down. LiteLLM is stateless and restarts quickly. |

**Fallback model routing**: LiteLLM supports fallback chains (e.g., try Claude, fall back to GPT-4o, fall back to Ollama local model). Configured in LiteLLM config, transparent to application code.

### MinIO Failure

| Scenario | Impact | Recovery |
|---|---|---|
| MinIO down | Snapshot writes fail. New rooms can't load initial state. | Active rooms continue working (state is in memory). New document opens fail. Snapshot writes queue up and retry. |
| MinIO data loss | Document history lost. Current state safe if rooms are active (in-memory Y.Doc). | Active rooms re-snapshot to rebuild. Inactive documents: latest plaintext is recoverable from PostgreSQL `content_text`. Full CRDT history is lost. |

**Mitigation**: MinIO should be configured with erasure coding or replicated storage for durability. For v1 on a single VM, regular backup of the MinIO data directory to an external location.

### pg-boss Worker Crash

| Scenario | Impact | Recovery |
|---|---|---|
| Worker process crashes mid-job | Job is not completed. | pg-boss automatically marks the job as expired after its timeout. It re-enters the queue and is picked up by another worker (or the restarted worker). |
| All workers down | Jobs accumulate in the queue. No indexing, no embedding, no AI suggestions. | Editing continues normally. When workers restart, they drain the backlog. Singleton keys ensure duplicate jobs are deduplicated. |

---

## 13. Scalability Concerns

### Current v1 Capacity Estimates

| Dimension | v1 Target | Limiting Factor |
|---|---|---|
| Concurrent editors per document | 100+ | Yjs in-memory doc size + WebSocket connections per server instance. A single Node.js instance can handle ~1,000-5,000 concurrent WebSocket connections. |
| Total concurrent WebSocket connections | ~5,000-10,000 | 2-3 Collab Server instances behind a load balancer. |
| Documents per workspace | ~10,000 | PostgreSQL FTS index size. Qdrant vector count. |
| Total documents (all workspaces) | ~100,000 | PostgreSQL + Qdrant capacity on a single VM. |
| pg-boss throughput | ~1,000-5,000 jobs/sec | PostgreSQL row insertion rate. |
| Search queries per second | ~100-500 | PostgreSQL FTS + Qdrant query capacity. |

### Scaling Bottlenecks and Upgrade Triggers

| Bottleneck | Symptom | Upgrade Path |
|---|---|---|
| WebSocket connections exceed single-node capacity | Connection refused, latency spikes | Add Collab Server instances + Redis pub/sub (already designed for this) |
| pg-boss job throughput saturated | Growing queue depth, freshness SLA breach | Migrate to Redpanda/Kafka |
| PostgreSQL FTS query latency | Search p95 > 500ms | Add Meilisearch as dedicated search engine |
| Qdrant vector count > 10M | Semantic search latency increases | Qdrant cluster mode (horizontal sharding) |
| Embedding API cost > $300/mo | Budget pressure | Self-host embedding model (BGE/GTE on GPU) |
| Docker Compose can't handle deployment complexity | Multi-node deployments, rolling updates needed | Migrate to Kubernetes |
| Individual permission management becomes painful | Workspace size > ~50 users | Add group-based permissions |

### What NOT to Optimize in v1

- **Database sharding**: PostgreSQL on a single node handles the projected v1 load comfortably.
- **CDN for document content**: Documents are not static assets; they're live CRDT state.
- **Multi-region replication**: PRD explicitly defers this to v2.
- **Microservice decomposition**: The monorepo with multiple entrypoints is the right granularity for v1.

---

## 14. Security Risks

### Risk Matrix

| Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|
| **Permission leak via RAG** | Critical | Medium | Three-layer enforcement (§8). Qdrant payload filter is mandatory — no code path exists to query without it. Dedicated security test suite validates this before GA. |
| **Prompt injection via document content** | High | High | LLM prompts use structured templates. System prompt instructs model to only use provided context. Response is streamed, not executed. Sanitize document content in prompts (strip any instruction-like patterns). |
| **Cross-tenant data leak** | Critical | Low | `workspace_id` discriminator on all tables. PostgreSQL RLS as defense-in-depth. Application middleware validates workspace membership on every request. |
| **JWT theft / session hijack** | High | Medium | Short-lived access tokens (1h). Refresh tokens in HttpOnly, Secure, SameSite=Strict cookies. Token rotation on refresh. |
| **WebSocket injection** | Medium | Medium | JWT validated on WebSocket upgrade. All Yjs messages are binary CRDT operations, not arbitrary commands. Server validates message structure. |
| **Audit log tampering** | Medium | Low | Application role has INSERT + SELECT only (no UPDATE/DELETE). DBA access controlled by operational policy. Consider adding hash chains in future for cryptographic tamper evidence. |
| **CRDT snapshot tampering in MinIO** | High | Low | MinIO bucket policy restricts write access to the application service account only. Snapshots are binary Yjs state — invalid state is rejected by `Y.applyUpdate()`. |
| **Denial of service via large documents** | Medium | Medium | Max document size limit enforced at the Collab Server (reject Yjs updates that would push doc beyond limit). Rate limiting on API endpoints. |
| **AI cost explosion** | Medium | Medium | Per-workspace token budgets. Singleton jobs prevent duplicate processing. Debounce timer prevents suggestion storms. Response caching. |
| **Dependency supply chain** | Medium | Medium | Lock file (`package-lock.json`). Dependabot / Renovate for automated vulnerability scanning. Minimal production dependencies. |

### Security-Critical Invariants & Integration Test Specifications

> [!NOTE]
> **Resolved (v1.1)**: All five security-critical invariants now have fully specified integration test scenarios that must pass before every deployment.

These must be verified by automated integration tests in the `test:security` suite:

#### Invariant 1: No Unfiltered Vector Search

**What it prevents**: A code path that queries Qdrant without permission filters, returning chunks from documents the user cannot access.

**Integration test**:
```
Test: "Qdrant queries always include permission filters"

Setup:
  1. Create Workspace W1 with User A (editor) and User B (editor)
  2. Create Document D1 in W1, authored by User A
  3. Set document_permissions: User B has role 'none' on D1
  4. Index D1 (trigger indexing pipeline, wait for Qdrant upsert)
  5. Verify D1 chunks exist in Qdrant with permitted_user_ids = [User A]

Test cases:
  a. User A queries /api/v1/ai/ask with a question matching D1 content
     → Response includes content from D1 ✓
  b. User B queries /api/v1/ai/ask with the same question
     → Response does NOT include content from D1 ✓
     → Qdrant query log shows filter included permitted_user_ids ✓
  c. User B queries /api/v1/search with keywords from D1
     → D1 does NOT appear in search results (neither FTS nor semantic) ✓
  d. [Static analysis] Grep all Qdrant client call sites in codebase.
     Assert every .search() and .query() call includes a 'filter' parameter
     with both 'workspace_id' and 'permitted_user_ids' keys.
```

#### Invariant 2: No Cross-Workspace Data Access

**What it prevents**: Tenant isolation failure — a user in Workspace 1 sees data from Workspace 2.

**Integration test**:
```
Test: "Complete workspace isolation"

Setup:
  1. Create Workspace W1 with User A (editor)
  2. Create Workspace W2 with User B (editor)
  3. Create Document D1 in W1 with content "Project Alpha secret roadmap"
  4. Create Document D2 in W2 with content "Project Beta secret roadmap"
  5. Index both documents, wait for FTS + Qdrant indexing

Test cases:
  a. User A: GET /api/v1/documents (workspace W1)
     → Returns D1 only ✓
  b. User A: GET /api/v1/documents/{D2.id}
     → Returns 403 or 404 ✓
  c. User A: GET /api/v1/search?q=secret+roadmap (workspace W1)
     → Returns D1 only, never D2 ✓
  d. User A: POST /api/v1/ai/ask { question: "What is the secret roadmap?" }
     → Answer references D1 only, never D2 ✓
  e. User A: Attempt WS connect to /ws/doc/{D2.id}
     → Connection rejected (user not a member of W2) ✓
  f. [RLS verification] Direct SQL query as User A's app role:
     SELECT * FROM documents WHERE id = D2.id
     → Returns 0 rows (RLS blocks cross-workspace access) ✓
```

#### Invariant 3: No Unauthenticated WebSocket Connections

**What it prevents**: Unauthorized access to real-time document editing.

**Integration test**:
```
Test: "WebSocket authentication enforcement"

Setup:
  1. Create Workspace W1 with User A (editor)
  2. Create Document D1 in W1

Test cases:
  a. Attempt WS connect to /ws/doc/{D1.id} with no ticket parameter
     → Connection rejected (HTTP 401 or close frame with 4001 code) ✓
  b. Attempt WS connect with ticket="invalid_random_string"
     → Connection rejected ✓
  c. Obtain valid ticket for User A, use it to connect successfully
     → Connection established ✓
  d. Attempt to reuse the same ticket for a second connection
     → Connection rejected (ticket is single-use, already consumed) ✓
  e. Obtain valid ticket, wait 35 seconds (past 30s TTL), attempt to connect
     → Connection rejected (ticket expired) ✓
  f. Obtain valid ticket scoped to D1, attempt to connect to /ws/doc/{D2.id}
     → Connection rejected (ticket scoped to wrong document) ✓
  g. User A is removed from workspace. Obtain ticket before removal.
     Attempt to connect after removal.
     → Connection rejected (workspace membership check fails) ✓
```

#### Invariant 4: No AI Suggestion Auto-Apply

**What it prevents**: AI-generated content silently modifying a document without human approval.

**Integration test**:
```
Test: "AI suggestions never auto-apply to documents"

Setup:
  1. Create Workspace W1 with User A (editor)
  2. Create Document D1 with known content "Original content unchanged"
  3. Snapshot D1 to MinIO, record Y.Doc state vector SV_before

Test cases:
  a. Trigger AI suggestion pipeline for D1 (enqueue ai.suggest job)
     Wait for suggestion worker to complete.
     → ai_suggestions table has a new row with status = 'pending' ✓
     → Load D1 Y.Doc from MinIO, compute state vector SV_after
     → SV_after == SV_before (document unchanged) ✓
     → D1 plaintext still equals "Original content unchanged" ✓

  b. Create a pending suggestion, then reject it:
     PATCH /api/v1/suggestions/{id} { status: 'rejected' }
     → D1 Y.Doc unchanged ✓

  c. Create a pending suggestion, then accept it:
     PATCH /api/v1/suggestions/{id} { status: 'accepted' }
     → D1 Y.Doc IS modified (suggestion content applied) ✓
     → The Yjs update is attributed to the accepting user, not "AI" ✓
     → audit_events contains 'ai.suggestion.accepted' with actor = User A ✓
```

#### Invariant 5: Audit Completeness

**What it prevents**: Security-relevant actions occurring without an audit trail.

**Integration test**:
```
Test: "Every security-relevant action produces an audit event"

Setup:
  1. Create Workspace W1 with User A (owner)
  2. Truncate audit_events (or record current max ID)

Test cases — for each action, verify a corresponding audit_events row exists:

  a. User A creates a document
     → audit: action='document.created', resource_type='document' ✓

  b. User A grants User B 'editor' on the document
     → audit: action='permission.granted', metadata includes user_id=B, role='editor' ✓

  c. User A revokes User B's access (sets role to 'none')
     → audit: action='permission.revoked', metadata includes user_id=B ✓

  d. User A asks an AI question
     → audit: action='ai.qa.query', metadata includes question text, model used ✓

  e. AI suggestion is generated (auto-trigger)
     → audit: action='ai.suggestion.created', metadata includes type, model ✓

  f. User A accepts the AI suggestion
     → audit: action='ai.suggestion.accepted', actor_id=A ✓

  g. User A adds User C to workspace
     → audit: action='workspace.member.added', metadata includes user_id=C, role ✓

  h. User A removes User C from workspace
     → audit: action='workspace.member.removed' ✓

  i. Verify NO audit event has a NULL actor_id for user-initiated actions
     (only system actions like auto-suggestions may have NULL actor) ✓

  j. Verify all audit events have the correct workspace_id ✓
```

#### Invariant 6: Permission Revocation Immediacy

> [!NOTE]
> **Added (v1.1)**: Verifies that permission revocation is effective immediately, even before Qdrant's `permitted_user_ids` is updated asynchronously.

**What it prevents**: A revoked user accessing content through the RAG pipeline during the Qdrant sync lag window.

**Integration test**:
```
Test: "Permission revocation takes effect immediately for RAG queries"

Setup:
  1. Create Workspace W1 with User A (editor) and User B (editor)
  2. Create Document D1 with distinctive content
  3. Index D1, wait for Qdrant sync
  4. Verify User B can query AI and get results from D1

Test cases:
  a. Revoke User B's access: set document_permissions(D1, B, 'none')
     Do NOT wait for permissions.sync job to complete (Qdrant still has B in permitted_user_ids)

  b. Immediately query /api/v1/ai/ask as User B with question matching D1
     → Response does NOT include content from D1 ✓
     → (Layer 3 PostgreSQL verification caught the stale Qdrant result)

  c. Wait for permissions.sync job to complete
     → Qdrant payload for D1 chunks no longer includes User B ✓

  d. Query /api/v1/ai/ask as User B again
     → Response does NOT include content from D1 ✓
     → (Now Layer 2 Qdrant filter also blocks it)
```

### Encryption

| Layer | Standard |
|---|---|
| In transit | TLS 1.3 (all HTTP and WebSocket connections) |
| At rest (PostgreSQL) | Transparent Data Encryption (TDE) or volume-level encryption via cloud provider / LUKS |
| At rest (MinIO) | Server-side encryption (SSE-S3) with KMS-managed keys |
| At rest (Qdrant) | Volume-level encryption (Qdrant does not natively support encryption at rest) |
| At rest (Redis) | Volume-level encryption. Redis data is transient (pub/sub, cache) — loss is acceptable. |

---

## 15. Local Development Architecture

### Docker Compose Configuration

```yaml
# docker-compose.yml (simplified structure)
services:
  # Application Services
  collab-server:
    build: .
    command: ["node", "src/collab/server.js"]
    ports: ["3001:3001"]                # WebSocket
    depends_on: [postgres, redis, minio]
    environment:
      DATABASE_URL: postgres://app:app@postgres:5432/knowledge
      REDIS_URL: redis://redis:6379
      MINIO_ENDPOINT: minio:9000
      MINIO_ACCESS_KEY: minioadmin
      MINIO_SECRET_KEY: minioadmin
    volumes:
      - ./src:/app/src                  # Hot reload

  api-server:
    build: .
    command: ["node", "src/api/server.js"]
    ports: ["3000:3000"]                # HTTP REST API
    depends_on: [postgres, redis, qdrant, litellm]
    environment:
      DATABASE_URL: postgres://app:app@postgres:5432/knowledge
      REDIS_URL: redis://redis:6379
      QDRANT_URL: http://qdrant:6333
      LITELLM_URL: http://litellm:4000
      MINIO_ENDPOINT: minio:9000

  workers:
    build: .
    command: ["node", "src/workers/main.js"]
    depends_on: [postgres, qdrant, litellm, minio]
    environment:
      DATABASE_URL: postgres://app:app@postgres:5432/knowledge
      QDRANT_URL: http://qdrant:6333
      LITELLM_URL: http://litellm:4000
      MINIO_ENDPOINT: minio:9000

  # Infrastructure Services
  postgres:
    image: postgres:16
    ports: ["5432:5432"]
    environment:
      POSTGRES_DB: knowledge
      POSTGRES_USER: app
      POSTGRES_PASSWORD: app
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./db/init.sql:/docker-entrypoint-initdb.d/init.sql

  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]

  qdrant:
    image: qdrant/qdrant:latest
    ports: ["6333:6333"]
    volumes:
      - qdrantdata:/qdrant/storage

  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    ports:
      - "9000:9000"                     # S3 API
      - "9001:9001"                     # Console UI
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    volumes:
      - miniodata:/data

  litellm:
    image: ghcr.io/berriai/litellm:latest
    ports: ["4000:4000"]
    volumes:
      - ./config/litellm_config.yaml:/app/config.yaml
    command: ["--config", "/app/config.yaml"]
    # For Ollama integration in dev:
    # extra_hosts: ["host.docker.internal:host-gateway"]

volumes:
  pgdata:
  qdrantdata:
  miniodata:
```

### Local Development with Ollama

For developers who want to run AI features without cloud API keys:

```yaml
# config/litellm_config.yaml (local dev with Ollama)
model_list:
  - model_name: "embedding-model"
    litellm_params:
      model: "ollama/nomic-embed-text"
      api_base: "http://host.docker.internal:11434"

  - model_name: "generation-model"
    litellm_params:
      model: "ollama/llama3"
      api_base: "http://host.docker.internal:11434"

  - model_name: "suggestion-model"
    litellm_params:
      model: "ollama/llama3"
      api_base: "http://host.docker.internal:11434"
```

Developers run Ollama on their host machine. LiteLLM proxies to it via `host.docker.internal`. No API keys needed for local development.

### Development Workflow

```bash
# First time setup
docker compose up -d postgres redis qdrant minio litellm
npm install
npm run db:migrate          # Run PostgreSQL migrations
npm run db:seed             # Seed test data

# Development (with hot reload)
docker compose up            # All services
# OR run app services locally:
npm run dev:collab           # Collab server with nodemon
npm run dev:api              # API server with nodemon
npm run dev:workers          # Workers with nodemon

# Testing
npm run test                 # Unit tests
npm run test:integration     # Integration tests (uses Docker services)
npm run test:security        # Security invariant tests
```

### Seed Data

Development seed includes:
- 2 workspaces with 5 users each
- 20 documents with realistic content (varying lengths)
- Pre-computed embeddings in Qdrant
- Sample AI suggestions in various states (pending, accepted, rejected)
- Audit log entries

---

## 16. Production Deployment Architecture

### v1 Target: Docker Compose on VM(s)

```
┌──────────────────────────────────────────────────────────────────────┐
│                        Load Balancer / Reverse Proxy                 │
│                        (nginx or Caddy)                              │
│                                                                      │
│  • TLS 1.3 termination                                               │
│  • WebSocket upgrade routing (/ws/* → collab-server)                 │
│  • API routing (/api/* → api-server)                                 │
│  • Static asset serving (/assets/* → CDN or local)                   │
│  • Rate limiting                                                     │
└──────────┬──────────────────────┬────────────────────────────────────┘
           │                      │
           ▼                      ▼
┌─────────────────┐    ┌─────────────────┐
│  Collab Server   │    │   API Server    │
│  (1-2 instances) │    │  (1-2 instances)│
└────────┬─────────┘    └────────┬────────┘
         │                       │
         └───────────┬───────────┘
                     │
    ┌────────────────┼────────────────────────────┐
    │                │                             │
    ▼                ▼                             ▼
┌────────┐    ┌───────────┐    ┌───────┐    ┌──────────┐
│ Redis  │    │PostgreSQL │    │Qdrant │    │  MinIO   │
│        │    │           │    │       │    │          │
└────────┘    └───────────┘    └───────┘    └──────────┘
                                                  │
                     ┌────────────────┐            │
                     │   Workers      │            │
                     │ (1-2 instances)│            │
                     └────────┬───────┘            │
                              │                    │
                              ▼                    │
                     ┌────────────────┐            │
                     │  LiteLLM Proxy │            │
                     └────────────────┘            │
```

### Deployment Phases

| Phase | Infrastructure | Scale |
|---|---|---|
| **Internal Alpha** | Single VM (8 CPU, 32GB RAM). All services in Docker Compose. | ~10 users, ~100 docs. No AI features. |
| **Internal Beta** | Same VM or upgrade to 16 CPU, 64GB RAM. Add LiteLLM + Qdrant. | ~50 users, ~1,000 docs. AI features enabled. |
| **Limited External Beta** | 2 VMs: App VM (collab + API + workers + Redis + LiteLLM) + Data VM (PostgreSQL + Qdrant + MinIO). Or managed PostgreSQL (RDS/Cloud SQL). | ~200 users, ~5,000 docs. |
| **GA** | Migrate to Kubernetes. Managed PostgreSQL, managed Redis, Qdrant cluster. Horizontal auto-scaling for app services. | ~1,000+ users. |

### Backup Strategy

| Component | Strategy | Frequency | Retention |
|---|---|---|---|
| PostgreSQL | `pg_dump` to S3/external storage | Daily full + continuous WAL archiving | 30 days |
| Qdrant | Qdrant snapshot API → S3/external storage | Daily | 7 days (rebuildable from PostgreSQL) |
| MinIO | Bucket replication to external S3, or filesystem backup | Daily | 30 days |
| Redis | Not backed up (transient data only) | — | — |
| LiteLLM config | Version controlled in git | On every change | Git history |

### Monitoring & Observability

| Signal | Tool | What to Watch |
|---|---|---|
| **Metrics** | Prometheus + Grafana (or hosted equivalent) | p95 edit latency, WebSocket connection count, pg-boss queue depth, Qdrant query latency, AI provider latency, error rates |
| **Logs** | Structured JSON logs → stdout → collected by Docker log driver | Error logs, slow query logs, AI provider errors |
| **Traces** | OpenTelemetry (optional for v1, recommended for beta) | End-to-end request traces for AI Q&A flow |
| **Alerts** | Grafana alerting or PagerDuty | Edit latency p95 > 150ms, pg-boss queue depth > 1000, error rate > 1%, disk usage > 80% |

### Key SLA Monitoring Dashboards

1. **Edit Propagation Latency** (target: <150ms p95)
   - Measured: timestamp when client sends Yjs update → timestamp when other clients receive it
   - Instrumented at the client (round-trip) and server (processing time)

2. **Search Freshness** (target: <5s)
   - Measured: timestamp of snapshot persistence → timestamp when document appears in FTS and Qdrant search results
   - Instrumented by a synthetic test that edits a document and polls search

3. **AI Answer Latency** (target: <3s p95, streamed)
   - Measured: time from API request to first streamed token
   - Instrumented at the API server

4. **pg-boss Queue Health**
   - Queue depth by job type (should stay near zero under normal operation)
   - Job failure rate
   - Dead-letter queue size (should be zero — any entries need investigation)

### Path to Kubernetes (GA)

The Docker Compose configuration is designed to map 1:1 to Kubernetes manifests:

| Docker Compose | Kubernetes |
|---|---|
| `services.collab-server` | Deployment + Service + HPA |
| `services.api-server` | Deployment + Service + HPA |
| `services.workers` | Deployment (no HPA — scale manually based on queue depth) |
| `services.litellm` | Deployment + Service |
| `services.postgres` | Managed service (RDS / Cloud SQL) |
| `services.redis` | Managed service (ElastiCache / Memorystore) |
| `services.qdrant` | StatefulSet or managed Qdrant Cloud |
| `services.minio` | Replaced by cloud S3 |
| Load balancer (nginx) | Ingress controller (nginx-ingress or cloud ALB) |

No application code changes are needed for the K8s migration. Only deployment configuration changes.

---

## Appendix A: API Surface (Summary)

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/v1/ws/ticket` | POST | Obtain single-use WebSocket authentication ticket |
| `/ws/doc/{id}` | WebSocket | Yjs sync + presence (requires `?ticket=` param) |
| `/api/v1/auth/login` | POST | Initiate OAuth flow |
| `/api/v1/auth/callback` | GET | OAuth callback |
| `/api/v1/auth/refresh` | POST | Refresh access token |
| `/api/v1/workspaces` | GET, POST | List/create workspaces |
| `/api/v1/workspaces/{id}/members` | GET, POST, PATCH, DELETE | Manage workspace members |
| `/api/v1/documents` | GET, POST | List/create documents |
| `/api/v1/documents/{id}` | GET, PATCH, DELETE | Document CRUD |
| `/api/v1/documents/{id}/permissions` | GET, POST, DELETE | Manage document permissions |
| `/api/v1/documents/{id}/versions` | GET | List version history |
| `/api/v1/documents/{id}/versions/{v}` | GET | Get specific version |
| `/api/v1/documents/{id}/comments` | GET, POST | List/create comments |
| `/api/v1/documents/{id}/suggestions` | GET, POST | List suggestions / trigger on-demand |
| `/api/v1/suggestions/{id}` | PATCH | Accept/reject suggestion |
| `/api/v1/search` | GET | Full-text + semantic search |
| `/api/v1/ai/ask` | POST | RAG question-answering (streamed response) |
| `/api/v1/audit` | GET | Query audit log (admin only) |

## Appendix B: Event / Job Catalog

| Queue | Payload | Producer | Consumer | Retry | Singleton Key |
|---|---|---|---|---|---|
| `index.document` | `{ document_id, version, workspace_id }` | Collab Server | Indexing Worker | 3 retries, exponential backoff | `document_id` |
| `embed.document` | `{ document_id, version, chunks[] }` | Indexing Worker | Embedding Worker | 5 retries, exponential backoff | `document_id` |
| `ai.suggest` | `{ document_id, version, type, user_id }` | Collab Server / API | AI Suggestion Worker | 2 retries | `document_id:type` |
| `permissions.sync` | `{ document_id, user_ids[], action }` | API Server | Permission Sync Worker | 5 retries | `document_id` |
| `snapshot.compact` | `{ document_id }` | Scheduled cron | Compaction Worker | 3 retries | `document_id` |
