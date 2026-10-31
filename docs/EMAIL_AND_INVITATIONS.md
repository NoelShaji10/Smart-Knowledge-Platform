# Email Delivery & Workspace Invitation System

This document outlines the architecture, security invariants, worker lifecycle, configuration, and verification procedures for the Phase 5 Email Delivery and Workspace Invitation system in the Smart Knowledge Platform.

---

## 1. Architecture & Security Invariants

### 1.1 Email Verification Lifecycle

1. **User Registration / Request**:
   - When a user registers or requests an email verification challenge, an unverified user record exists in PostgreSQL (`email_verified = false`).
   - A cryptographically secure 256-bit (32-byte) raw token is generated via `crypto.randomBytes(32).toString('hex')`.
   - Only the SHA-256 hash of this raw token is stored in `email_verification_challenges.token_hash`. The raw token is NEVER persisted to the database.
   - Only one challenge is `active` per user at any time. When generating a new challenge, previous active challenges are superseded (`superseded_at = NOW()`).
2. **Delivery & Safe Resend**:
   - The raw token is delivered strictly via the configured `EmailTransport`.
   - If email transport delivery fails during a resend request, the transaction rolls back cleanly, ensuring that any previously delivered valid challenge remains uncorrupted and usable.
3. **Consumption & Authoritative State**:
   - The recipient clicks the verification link (`/verify-email?token=<rawToken>`).
   - The backend validates the challenge atomically:
     - Canonical lock ordering: Acquires an exclusive row lock on `users` (`FOR UPDATE`) FIRST, followed by row lock on the challenge record. This eliminates lock-order inversion and deadlocks.
     - Checks expiry (`expires_at > NOW()`), single-use (`consumed_at IS NULL`), and user status (`deleted_at IS NULL`).
     - Atomically marks `consumed_at = NOW()` and updates `users.email_verified = true`.
   - Authoritative verification: All security-critical authorization boundaries (such as workspace invitation acceptance) verify `users.email_verified` directly against PostgreSQL or authoritative session context, rather than relying on stale JWT claims. Refresh token rotation regenerates the access token with the updated `email_verified` claim.

---

### 1.2 Workspace Invitation Lifecycle

1. **Invitation Creation**:
   - Workspace owners and admins create invitations via `POST /api/v1/workspaces/:workspaceId/invitations`.
   - Privilege escalation defense: Admins cannot create invitations for `admin` or `owner` roles; owners can invite any allowed role.
   - Shareable link invitations (`invitee_email = null`) require no email delivery (`email_delivery_status = 'not_requested'`).
   - Email-bound invitations (`invitee_email` provided) generate a 256-bit raw token and store its SHA-256 hash in `workspace_invitations.token_hash`.
   - The raw token is encrypted using AES-256-GCM with Associated Authenticated Data (AAD) bound to the `invitation_id` and stored in `workspace_invitations.encrypted_token`.
2. **Transactional Outbox & Job Enqueue**:
   - The database transaction commits first.
   - Upon successful commit, a background job is enqueued to `pg-boss` on queue `email.invitation`.
   - If the API server crashes between database commit and job enqueue, the background reconciliation worker (`reconcilePendingInvitationEmails`) scans for stranded pending invitations with `email_queued_at < NOW() - 30s` and re-enqueues them automatically without plaintext secrets.
3. **Worker Claim & Database Lease**:
   - Background worker acquires an atomic database lease:
     - Updates `worker_lease_id = <workerUuid>`, `worker_lease_expires_at = NOW() + 60s`, `email_delivery_status = 'processing'`.
     - Uses conditional fencing: Only claims if `worker_lease_expires_at IS NULL OR worker_lease_expires_at < NOW()`.
   - Decrypts the token using the system `EMAIL_ENCRYPTION_KEY` and verifies AAD.
   - Sends the email using `EmailTransport`.
   - Once accepted by the provider:
     - Updates status to `accepted_by_provider`.
     - Purges `encrypted_token = NULL` to ensure token ciphertext is removed from the database immediately.
     - Clears the worker lease.
4. **Invitation Acceptance**:
   - Recipient navigates to `/invitations/:token`.
   - Token is resolved publicly without leaking secret metadata.
   - When accepting (`POST /api/v1/invitations/:token/accept`), the user must be authenticated and email-verified.
   - If the invitation is email-bound, the user's primary verified email must match the invitation's `invitee_email` (case-insensitive).
   - If the invitation is a shareable link, any verified user may accept.
   - The acceptance transaction locks the invitation row (`FOR UPDATE`), validates expiration, adds membership to `workspace_members` with the exact invited role (clients cannot override the role), and marks the invitation `status = 'accepted'`.
   - Repeated acceptance returns HTTP 409 `INVITATION_ALREADY_ACCEPTED`.

---

## 2. Worker Reliability, Retries & Dead-Letter Handling

### 2.1 Error Classification
The worker classifies delivery errors using `packages/email/src/errors.ts`:
- **Transient / Retryable Errors (`isRetryable: true`)**:
  - Network drops, connection timeouts (`ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`).
  - SMTP 4xx temporary service rejections (e.g. `421 Service not available`, `450 Mailbox busy`).
  - Worker action: Increments `email_delivery_attempts`, sets `email_delivery_status = 'failed'`, records `email_failure_reason`, releases lease, and re-throws the error to let `pg-boss` perform exponential backoff retries.
  - Max retry limit: 5 attempts. Once exceeded, pg-boss moves the job to the dead-letter queue.
- **Permanent Errors (`isRetryable: false`)**:
  - SMTP 5xx rejections (e.g. `550 Mailbox unavailable / User not found`, `554 Transaction failed`).
  - SMTP authentication failures (`EAUTH`).
  - Corrupt or invalid recipient address.
  - Worker action: Sets `email_delivery_status = 'permanently_failed'`, records `email_failure_reason`, releases lease, and terminates the job without rethrowing.

### 2.2 Stale Worker Fencing & Resend Invalidation
- When an administrator resends an invitation:
  - The previous invitation row is updated to `status = 'revoked'`.
  - A new replacement invitation row is created with a new UUID and new token hash.
  - If a stale background worker was in-flight for the superseded invitation, it checks `invitation.status === 'pending'` under its lease. Detecting the revoked state, it halts with `INVITATION_REVOKED` and skips sending, avoiding duplicate emails.

---

## 3. Environment Variables & Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `EMAIL_PROVIDER` | No | `mock` | Transport to use: `mock` (in-memory for tests/dev) or `smtp` (real SMTP delivery). |
| `EMAIL_FROM` | Yes | `no-reply@knowledgeplatform.local` | Authoritative "From" sender email address (must match verified domain). |
| `WEB_APP_URL` | Yes | `http://localhost:3000` | Base URL used to construct verification and invitation links. |
| `SMTP_HOST` | Production | — | Hostname of the SMTP server (e.g. `smtp.resend.com`, `email-smtp.us-east-1.amazonaws.com`). |
| `SMTP_PORT` | Production | `587` | Port for SMTP (typically `587` for STARTTLS, `465` for SSL/TLS). |
| `SMTP_USER` | Production | — | SMTP username / API key identifier. |
| `SMTP_PASS` | Production | — | SMTP password / API token secret. |
| `SMTP_SECURE` | No | `false` | Set to `true` for TLS port 465; `false` for STARTTLS port 587. |
| `EMAIL_ENCRYPTION_KEY` | Production | — | 32-byte AES key (Base64-encoded) for encrypting invitation tokens in background jobs. |

### 3.1 Generating the Token Encryption Key
For production or staging environments:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

---

## 4. Local Development vs. Production SMTP Setup

### 4.1 Local Development (Default)
In local development, the platform defaults to the mock transport:
```env
EMAIL_PROVIDER=mock
EMAIL_FROM=dev@knowledgeplatform.local
WEB_APP_URL=http://localhost:3000
```
- No emails are sent over the network.
- Verification and invitation links are logged to worker stdout.

### 4.2 Production Provider Setup (e.g., Resend, AWS SES, Postmark)
When configuring an external SMTP provider (such as Resend):
1. **Domain Verification**:
   - Register your custom domain in the provider's dashboard (e.g., `resend.com/domains`).
   - Add the required DNS records:
     - **SPF** (TXT record): Authorizes provider to send on behalf of domain.
     - **DKIM** (CNAME / TXT records): Cryptographic signature proving authenticity.
     - **DMARC** (TXT record: `_dmarc.yourdomain.com` -> `v=DMARC1; p=quarantine;`): Enforces policy.
2. **Environment Configuration**:
   ```env
   EMAIL_PROVIDER=smtp
   EMAIL_FROM=onboarding@yourdomain.com
   WEB_APP_URL=https://app.yourdomain.com
   SMTP_HOST=smtp.resend.com
   SMTP_PORT=587
   SMTP_USER=resend
   SMTP_PASS=re_your_api_key
   SMTP_SECURE=false
   EMAIL_ENCRYPTION_KEY=<base64-32-byte-key>
   ```

> [!WARNING]
> Test inbox delivery with unverified domains is restricted by providers. In Resend, using `onboarding@resend.dev` only permits sending to the account owner's registration email. A verified custom domain is required to send invitations to arbitrary users.

---

## 5. Verification Commands & Automated Tests

### 5.1 Running Email & Invitation Test Suites
```bash
# Run complete Phase 5 End-to-End test suite (8 groups, 19 tests)
pnpm vitest run tests/integration/phase5-e2e.test.ts

# Run email verification lifecycle tests (34 tests)
pnpm vitest run tests/integration/email-verification.test.ts

# Run workspace invitation API tests (35 tests)
pnpm vitest run tests/integration/invitation-api.test.ts

# Run workspace invitations end-to-end integration tests (28 tests)
pnpm vitest run tests/integration/workspace-invitations.test.ts
```

### 5.2 Running Full Repository Validation
```bash
# Monorepo typecheck
pnpm turbo run typecheck --force

# Security invariants test suite
pnpm test:security

# Full unit and integration test suite
pnpm test

# Production build
pnpm build
```
