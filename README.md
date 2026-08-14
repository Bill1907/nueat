# NUEAT

Korea-first AI nutrition coach for traceable meal logging, deterministic nutrition calculations, and actionable next-meal guidance. Product requirements and safety boundaries live in [`PRD.md`](./PRD.md).

## Workspace

- `apps/mobile`: Expo/React Native client
- `apps/api`: Bun/Fastify API for auth and product endpoints
- `packages/domain`: Versioned nutrition and safety policies
- `packages/database`: Drizzle schema and Neon PostgreSQL migrations

## Development

Requirements: Bun 1.3.14 and Node.js LTS for Expo tooling.

```bash
bun install
bun run api       # API watch mode
bun run mobile    # Expo development server
bun run typecheck
bun test
bun run lint
```

Local secrets belong in ignored `.env.local` files. Start from:

- `apps/api/.env.example`
- `apps/mobile/.env.example`
- `packages/database/.env.example`

Database commands connect directly to the configured Neon PostgreSQL instance:

```bash
bun run db:check
```

Review generated SQL under `packages/database/drizzle/` before an operator-approved, named migration. There is no `db:migrate` or `migrate-all` command.

## Nutrition calculation

`packages/domain/src/meal-nutrition.ts` converts sourced household servings to integer milligrams and calculates nutrients with BigInt intermediates and positive half-up rounding. Volume and household units require a matching `FoodServing`; missing nutrients remain partial and are never treated as zero.

## API

```text
GET  /health/live
GET  /health/ready
GET  /health
GET  /api/me
GET|POST /api/auth/*
GET  /api/onboarding/status
POST /api/onboarding/preview
PUT  /api/onboarding/complete
GET  /api/nutrition-targets/active
POST /api/image-assets/upload-intents
POST /api/image-assets/:assetId/complete
GET  /api/image-assets/:assetId
POST /api/image-assets/:assetId/download-intent
POST /api/meal-logs
GET|PATCH|DELETE /api/meal-logs/:mealLogId
POST /api/meal-logs/:mealLogId/items
PATCH|DELETE /api/meal-logs/:mealLogId/items/:itemId
POST /api/meal-logs/:mealLogId/items/:itemId/review
PUT  /api/meal-logs/:mealLogId/items/:itemId/decomposition
POST /api/meal-logs/:mealLogId/confirm
GET  /api/foods/search
PUT  /api/meal-logs/:mealLogId/items/:itemId/food
```

Authentication uses Better Auth email OTP only. Resend sends six-digit OTPs from `NUEAT <auth@boseong.dev>`; codes expire after five minutes and allow three attempts.

Every review or confirmation mutation requires `X-NUEAT-Meal-Confirmation-Protocol: meal-confirmation-safe-review-v1`. Missing or obsolete protocols receive `426 CLIENT_UPGRADE_REQUIRED` before request-body parsing or database work. In `maintenance_bridge` or `safe_review_maintenance`, the exact protocol receives `503 MEAL_CONFIRMATION_MAINTENANCE` with `Retry-After`; owned meal reads and readiness remain available. Item review is explicit and item-scoped; final meal confirmation is a separate mutation. Readiness exposes the active meal-confirmation cutover identity, mode, protocol, and barrier.

### Meal-confirmation cutover runbook

Follow this order exactly: bridge → operator-approved `0022_meal_confirmation_safe_review` → safe maintenance/normal → soak → separately approved `0023_remove_obsolete_meal_review`. Deploy the bridge first. An operator then reviews and runs only `bun run db:migrate:0022`; migration is never automatic. Use `safe_review_maintenance` for the protected cutover checks, return to `normal` only after those checks pass, and soak the normal path before a separate operator approval and `bun run db:migrate:0023`. Do not use a broad or nonexistent `migrate-all` command.

### Recognition-reliability expansion runbook

Migration `0024_recognition_reliability` is additive and must be applied with the guarded `bun run db:migrate:0024` target, first against an isolated Neon branch copied from migration 23. Before approval, run the rollback-only isolated fixture command exactly as `bun run --cwd packages/database db:validate:recognition-reliability`. It verifies the Neon control-plane target is an allowlisted, ready, direct, non-pooled isolated branch, then migrates and exercises fixtures in one transaction that always rolls back. Do not run this command against production.

The database `.env.local` must provide `DATABASE_URL`, `NUEAT_DATABASE_ENVIRONMENT=isolated_neon_branch`, `NUEAT_NEON_PROJECT_ID`, `NUEAT_NEON_BRANCH_ID`, `NUEAT_ALLOWED_NEON_BRANCH_IDS`, `NUEAT_PRODUCTION_NEON_PROJECT_ID`, `NUEAT_PRODUCTION_NEON_BRANCH_ID`, and `NEON_API_KEY`; use the redacted names in `packages/database/.env.example`, never production credentials in docs or receipts. Verify legacy reads drain, concurrent execution/invocation ordinals, terminal immutability, and the `recognition_reliability_v2` capability/readiness marker before production approval. Production recognition remains disabled during migration and mixed-version rollout. A production guarded migration also requires approved `NUEAT_PRODUCTION_OVERRIDE_TOKEN`, `NUEAT_PRODUCTION_OVERRIDE_ACTOR`, and `NUEAT_PRODUCTION_CHANGE_REFERENCE`; retain the guard's hashed override audit receipt and approval reference, never the token.

After production migration, deploy every replica with `RECOGNITION_RELIABILITY_PROTOCOL_MODE=legacy_observe` and `RECOGNITION_RELIABILITY_SCHEMA_CAPABILITY=true`; do not claim complete receipts until Railway confirms no legacy replica remains. User recovery remains disabled while measuring the existing baseline. SDK retry behavior is owned by the selected protocol mode; there is no independent retry toggle. Promote only to `v2_one_call` after the deadline, privacy, readiness, and non-inferiority gates pass. `v2_auto_retry` requires separately recorded admission evidence and is not part of the initial repair.

Rollback order is user recovery off → `RECOGNITION_RELIABILITY_KILL_SWITCH=true` → protocol `disabled` → wait for active executions to drain/expire → compatible binary rollback. Only after the kill switch and disabled readiness receipt may an operator select `legacy_observe`; never return to a legacy writer while recognition is enabled, delete additive receipts, or reset counters. Operator receipts must contain only deployment IDs, isolated/production branch identity, migration target, capability/readiness status, approval/change reference and hashed override audit, bounded phase/code counts, aggregate latency, and rollback/drain timestamps; never include image bytes, base64, signed URLs, object keys, email, credentials, or raw provider messages.

The Expo client gates product routes behind the session, stores native auth cookies in SecureStore, restores sessions on launch, and provides email entry, six-digit OTP, 60-second resend cooldown, three-attempt UX, and logout. `EXPO_PUBLIC_API_URL` is public configuration and defaults to `https://api-nueat.boseong.dev`; never place secrets in an `EXPO_PUBLIC_*` variable.

Onboarding is an authenticated six-step flow: consent, goal, birth year/calculation sex, body metrics, activity/safety screening, and KDRI result confirmation. Completion writes current consent hashes and either a versioned nutrition profile or a terminal limited-mode status in one Neon transaction.

The home target card reads the authenticated active target endpoint and renders pending, limited, loading, retry, and versioned active-target states. Stored integer units are formatted only at the display boundary.

Image uploads use a private Railway Bucket through S3-compatible presigned URLs. The API creates opaque keys, signs five-minute PUTs, verifies ownership, declared size/type, decoded file signature, dimensions, GPS/non-normalized EXIF absence, and SHA-256 before marking an asset `validated`. Validated inference assets expire after 24 hours; rejected objects are deleted immediately or queued for retry.

The Expo home screen provides camera and library selection, re-encodes every image as JPEG, scales the long edge to 1,600px, retries compression below 10MB, uploads with native progress/cancellation, and calls server completion. One interrupted draft is stored under the app document directory for at most 24 hours and is removed after validation or explicit discard.

A validated image is attached to exactly one draft MealLog. Draft creation is idempotent by image asset, atomically claims the owned asset, persists `mock-recognition-v2` results, and returns editable items. Mock labels and confidence values are UI scaffolding only: drafts never count as consumed food and contain no invented nutrition values.

Canonical food search is source-backed. The initial 20-food Korea-first fixture uses analyzed 100g rows from the official K-FIND `음식 DB` release `2025-12-29`; nutrients retain the original food code, dataset version, source registry, and verified gram serving. Editing a mapped label clears its canonical food/profile linkage, while selecting a search result restores the mapping explicitly.
## Meal recognition V2 and golden release gate

Recognition returns only one of `recognized`, `no_food`, or `insufficient_evidence`, plus food/portion estimates and uncertainty. It never returns nutrition facts or canonical database IDs. The API creates a `draft` before the confirmation CTA; no draft becomes consumed intake automatically.

A draft presents one CTA, **Confirm meal**, after its required item reviews are complete. Lower-confidence, no-food, and insufficient-evidence outcomes require the smallest applicable correction (food search/replacement or portion edit) before the user can explicitly confirm. Food and portion edits carry independent revisions; stale writes receive `409`, and a zero-item manual override preserves the original recognition result while recording its decision, source outcome, time, and revision-guarded transition.

Nutrition is source-backed: canonical Food, serving, and NutrientProfile versions feed deterministic calculation. Calories, carbohydrate, protein, fat, and fibre remain `partial` when any contributing value is missing; missing values are never zero-filled.

The evaluator accepts private, versioned JSON inputs and writes an aggregate-only report:

```bash
bun --cwd apps/api run evaluate:meal-recognition-golden -- \
  /secure/manifest.json /secure/ground-truth.json /secure/predictions.json /secure/report.json
```

The fixed `golden-v1` production baseline requires at least 500 consented Korean meal photos across exactly six approved food groups with at least 50 photos each, plus at least 10 `no_food` and 10 `insufficient_evidence` cases. `hybrid_auto` additionally requires at least 381 eligible non-exact automatic decisions, all correct, food top-1 Wilson-95 lower bound ≥99%, zero forbidden or untrusted selections, and measured category, preparation, composite, abstention/coverage, latency, correction, block, privacy, and soak evidence.
The quick-eligible cohort is identical in runtime and evaluation: image, food, and portion confidence must each be at least 7,000 bps; a present food-candidate margin must be at least 1,000 bps; mapping must be the primary model mapping; model questions must be empty; and every non-gram conversion must resolve through a trusted signed registry.

The report includes only aggregate counts/metrics, threshold failures, deterministic `inputSha256`/`reportSha256`, independent adjudication and registry hashes, and the evaluated provider/model/prompt/schema/resolver/review-policy identities; it never copies images, case IDs, food labels, or raw annotations. Prediction inputs are strict and reject duplicate food IDs, nutrition/official-ID fields, unsupported leakage fields, and converted non-gram portions without a source-registry ID; conversion trust is derived from the signed manifest's trusted registry IDs. The private dataset is not committed. Evaluation is `review_only` by default. `hybrid_auto` accepts only a signed `meal-stack-golden-report-v3`, never a V2 receipt; the authority signs lowercase `reportSha256` bytes with Ed25519 and appends `{ keyId, signatureBase64 }` as `approval`. Rollback selects a prior signed receipt and only downgrades automatic operation.

## Railway

The root `Dockerfile` builds only the API and its workspace dependencies. `railway.json` starts the API and checks `/health/ready`; it does not run migrations.

Required Railway variables:

```env
NODE_ENV=production
HOST=0.0.0.0
PORT=3000
DATABASE_URL=postgresql://...
BETTER_AUTH_SECRET=...
BETTER_AUTH_URL=https://api-nueat.boseong.dev
RESEND_API_KEY=...
AUTH_EMAIL_FROM=NUEAT <auth@boseong.dev>
TRUSTED_ORIGINS=nueat://,https://your-web-origin.example
LOG_LEVEL=info
HEALTH_DB_TIMEOUT_MS=2000
S3_ENDPOINT=https://storage.railway.app
S3_REGION=auto
S3_BUCKET=...
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_URL_STYLE=virtual
IMAGE_UPLOAD_URL_TTL_SECONDS=300
IMAGE_DOWNLOAD_URL_TTL_SECONDS=120
IMAGE_MAX_BYTES=10000000
VECTOR_SHADOW_MODE=off
MEAL_RECOGNITION_MODE=openai
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5.4-mini-2026-03-17
MEAL_RECOGNITION_DEADLINE_MS=20000
RECOGNITION_RELIABILITY_PROTOCOL_MODE=disabled
RECOGNITION_RELIABILITY_KILL_SWITCH=false
RECOGNITION_RELIABILITY_SCHEMA_CAPABILITY=false
RECOGNITION_RELIABILITY_V2_ONE_CALL_ADMISSION_EVIDENCE=
RECOGNITION_RELIABILITY_AUTO_RETRY_ADMISSION_EVIDENCE=
RECOGNITION_RELIABILITY_COHORT_PERCENT=0
RECOGNITION_RECOVERY_ENABLED=false
MEAL_RECOGNITION_FINALIZATION_RESERVE_MS=2000
MEAL_RECOGNITION_RESPONSE_RESERVE_MS=2000
MEAL_RECOGNITION_PROVIDER_CALL_MAX_MS=15000
MEAL_RECOGNITION_PROVIDER_CALL_MIN_MS=1000
MEAL_RECOGNITION_DB_LOCK_CAP_MS=1000
MEAL_RECOGNITION_DB_STATEMENT_CAP_MS=1500
MEAL_RECOGNITION_LEASE_MARGIN_MS=1000
MEAL_RECOGNITION_MAX_OUTPUT_TOKENS=2000
MEAL_RECOGNITION_MAX_ATTEMPTS=2
MEAL_RECOGNITION_DAILY_ATTEMPT_QUOTA=20
MEAL_RECOGNITION_MAPPING_MODE=exact_review
MEAL_RECOGNITION_EMERGENCY_OVERRIDE=none
MEAL_RECOGNITION_ACTIVATION_IDENTITY_JSON=
MEAL_RECOGNITION_APPROVED_REPORT_SHA256=
MEAL_RECOGNITION_ACTIVE_REPORT_SHA256=
MEAL_RECOGNITION_APPROVED_REPORT_VERSION=
MEAL_RECOGNITION_APPROVED_REPORT_JSON=
MEAL_RECOGNITION_APPROVAL_KEY_ID=
MEAL_RECOGNITION_APPROVAL_PUBLIC_KEY=
MEAL_RECOGNITION_CATALOG_REGISTRY_VERSION=
MEAL_RECOGNITION_CATALOG_REGISTRY_SHA256=
MEAL_CONFIRMATION_CUTOVER_MODE=normal
MEAL_CONFIRMATION_MAINTENANCE_RETRY_AFTER_SECONDS=60
```

Map Railway Bucket `ENDPOINT`, `REGION`, `BUCKET`, `ACCESS_KEY_ID`, and `SECRET_ACCESS_KEY` into the corresponding `S3_*` service variables. Use Railway's globally unique `BUCKET` value, not `RAILWAY_BUCKET_NAME`. Until all four required S3 connection values are configured together, existing API features remain available and image mutation endpoints return `503 IMAGE_STORAGE_UNAVAILABLE`.
The production project uses the private `nueat-images` bucket in Railway's `sin` region. Its service variables are linked by Railway references rather than copied credentials.
Live recognition reads private bucket bytes on the API server, rechecks size/content type/SHA-256, and calls OpenAI outside database transactions. `mock` mode is explicit; OpenAI failures never fall back to mock or generate nutrition values.
Mapping modes are `exact_review` (default), `hybrid_review`, and `hybrid_auto`. Vector shadow is unavailable: startup rejects either vector-shadow configuration until the pinned local ONNX encoder artifact is deployed. Review modes never decide product state. Production `hybrid_auto` is fail-closed: its authority-signed receipt must bind the observation schema, prompt/model, resolver/policy, normalizer/taxonomy/search weights/thresholds, catalog releases/hashes, and mapping mode to the deployed stack. Every release or threshold change requires a new signed receipt. Emergency override may only downgrade to a review or disabled mode; rollback clears auto activation and selects a prior signed receipt. Reports and logs contain aggregate, non-sensitive evidence only: never log images, case IDs, labels, annotations, prompts containing user data, or embeddings.

Composite confirmation currently enables finished profiles and reviewed per-meal decompositions. Importer-owned source recipes remain dark and unavailable to product routes until recipe membership is added to the immutable catalog release and its end-to-end selector/confirmation contract is activated; the API never silently substitutes a finished profile for a source recipe.

Attach the Railway custom domain `api-nueat.boseong.dev` after the first successful deployment. Never commit `.env.local`, OTP values, database credentials, signed URLs, or image object keys.
