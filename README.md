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
bun run db:migrate
```

Review generated SQL under `packages/database/drizzle/` before migrating.

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
GET  /api/foods/search
PUT  /api/meal-logs/:mealLogId/items/:itemId/food
```

Authentication uses Better Auth email OTP only. Resend sends six-digit OTPs from `NUEAT <auth@boseong.dev>`; codes expire after five minutes and allow three attempts.

The Expo client gates product routes behind the session, stores native auth cookies in SecureStore, restores sessions on launch, and provides email entry, six-digit OTP, 60-second resend cooldown, three-attempt UX, and logout. `EXPO_PUBLIC_API_URL` is public configuration and defaults to `https://api-nueat.boseong.dev`; never place secrets in an `EXPO_PUBLIC_*` variable.

Onboarding is an authenticated six-step flow: consent, goal, birth year/calculation sex, body metrics, activity/safety screening, and KDRI result confirmation. Completion writes current consent hashes and either a versioned nutrition profile or a terminal limited-mode status in one Neon transaction.

The home target card reads the authenticated active target endpoint and renders pending, limited, loading, retry, and versioned active-target states. Stored integer units are formatted only at the display boundary.

Image uploads use a private Railway Bucket through S3-compatible presigned URLs. The API creates opaque keys, signs five-minute PUTs, verifies ownership, declared size/type, decoded file signature, dimensions, GPS/non-normalized EXIF absence, and SHA-256 before marking an asset `validated`. Validated inference assets expire after 24 hours; rejected objects are deleted immediately or queued for retry.

The Expo home screen provides camera and library selection, re-encodes every image as JPEG, scales the long edge to 1,600px, retries compression below 10MB, uploads with native progress/cancellation, and calls server completion. One interrupted draft is stored under the app document directory for at most 24 hours and is removed after validation or explicit discard.

A validated image is attached to exactly one draft MealLog. Draft creation is idempotent by image asset, atomically claims the owned asset, persists `mock-recognition-v2` results, and returns editable items. Mock labels and confidence values are UI scaffolding only: drafts never count as consumed food and contain no invented nutrition values.

Canonical food search is source-backed. The initial 20-food Korea-first fixture uses analyzed 100g rows from the official K-FIND `음식 DB` release `2025-12-29`; nutrients retain the original food code, dataset version, source registry, and verified gram serving. Editing a mapped label clears its canonical food/profile linkage, while selecting a search result restores the mapping explicitly.
## Meal recognition V2 and golden release gate

Recognition returns only one of `recognized`, `no_food`, or `insufficient_evidence`, plus food/portion estimates and uncertainty. It never returns nutrition facts or canonical database IDs. The API creates a `draft` before the confirmation CTA; no draft becomes consumed intake automatically.

A high-confidence recognized draft presents one CTA, **Confirm meal**. Lower-confidence, no-food, and insufficient-evidence outcomes require the smallest applicable correction (food search/replacement or portion edit) before the user can explicitly confirm. Food and portion edits carry independent revisions; stale writes receive `409`, and a zero-item manual override preserves the original recognition result while recording its decision, source outcome, time, and revision-guarded transition.

Nutrition is source-backed: canonical Food, serving, and NutrientProfile versions feed deterministic calculation. Calories, carbohydrate, protein, fat, and fibre remain `partial` when any contributing value is missing; missing values are never zero-filled.

The evaluator accepts private, versioned JSON inputs and writes an aggregate-only report:

```bash
bun --cwd apps/api run evaluate:meal-recognition-golden -- \
  /secure/manifest.json /secure/ground-truth.json /secure/predictions.json /secure/report.json
```

The fixed `golden-v1` production baseline requires at least 120 consented Korean meal photos across exactly six approved food groups with at least 20 photos each, plus at least 10 `no_food` and 10 `insufficient_evidence` cases. It also requires at least 50 quick-eligible meals and 100 quick-eligible items, outcome accuracy ≥95%, food top-1 Wilson-95 lower bound ≥95%, portion-within-`max(25g, 20%)` Wilson-95 lower bound ≥90%, joint item Wilson-95 lower bound ≥90%, all-items-correct eligible-meal Wilson-95 lower bound ≥85%, eligible coverage ≥15%, valid V2 ≥99%, and zero zero-outcome quick false positives, nutrition/ID errors, untrusted conversion eligibility, or sensitive leakage.
The quick-eligible cohort is identical in runtime and evaluation: image, food, and portion confidence must each be at least 7,000 bps; a present food-candidate margin must be at least 1,000 bps; mapping must be the primary model mapping; model questions must be empty; and every non-gram conversion must resolve through a trusted signed registry.

The report includes only aggregate counts/metrics, threshold failures, deterministic `inputSha256`/`reportSha256`, independent adjudication and registry hashes, and the evaluated provider/model/prompt/schema/resolver/review-policy identities; it never copies images, case IDs, food labels, or raw annotations. Prediction inputs are strict and reject duplicate food IDs, nutrition/official-ID fields, unsupported leakage fields, and converted non-gram portions without a source-registry ID; conversion trust is derived from the signed manifest's trusted registry IDs. The private dataset is not committed. Evaluation is `review_only` by default. After independent approval, the authority signs the lowercase `reportSha256` bytes with Ed25519 and appends `{ keyId, signatureBase64 }` as `approval`; rollback selects the previous signed approved SHA.

## Railway

The root `Dockerfile` builds only the API and its workspace dependencies. `railway.json` runs database migrations before deployment and checks `/health/ready`.

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
MEAL_RECOGNITION_MODE=openai
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5.4-mini-2026-03-17
MEAL_RECOGNITION_DEADLINE_MS=20000
MEAL_RECOGNITION_MAX_OUTPUT_TOKENS=2000
MEAL_RECOGNITION_MAX_ATTEMPTS=2
MEAL_RECOGNITION_DAILY_ATTEMPT_QUOTA=20
MEAL_RECOGNITION_REVIEW_POLICY=review_only
MEAL_RECOGNITION_APPROVED_REPORT_SHA256=
MEAL_RECOGNITION_ACTIVE_REPORT_SHA256=
MEAL_RECOGNITION_APPROVED_REPORT_VERSION=
MEAL_RECOGNITION_APPROVED_REPORT_JSON=
MEAL_RECOGNITION_APPROVAL_KEY_ID=
MEAL_RECOGNITION_APPROVAL_PUBLIC_KEY=
MEAL_RECOGNITION_CATALOG_REGISTRY_VERSION=
MEAL_RECOGNITION_CATALOG_REGISTRY_SHA256=
```

Map Railway Bucket `ENDPOINT`, `REGION`, `BUCKET`, `ACCESS_KEY_ID`, and `SECRET_ACCESS_KEY` into the corresponding `S3_*` service variables. Use Railway's globally unique `BUCKET` value, not `RAILWAY_BUCKET_NAME`. Until all four required S3 connection values are configured together, existing API features remain available and image mutation endpoints return `503 IMAGE_STORAGE_UNAVAILABLE`.
The production project uses the private `nueat-images` bucket in Railway's `sin` region. Its service variables are linked by Railway references rather than copied credentials.
Live recognition reads private bucket bytes on the API server, rechecks size/content type/SHA-256, and calls OpenAI outside database transactions. `mock` mode is explicit; OpenAI failures never fall back to mock or generate nutrition values.
Production `quick_confirm` is fail-closed: use `MEAL_RECOGNITION_MODE=openai`, set `MEAL_RECOGNITION_REVIEW_POLICY=quick_confirm`, provide identical approved and active lowercase SHA-256 report digests, configure the deployed catalog registry version/SHA, set `MEAL_RECOGNITION_APPROVED_REPORT_VERSION=meal-recognition-golden-report-v2`, provide the authority-signed evaluator receipt as `MEAL_RECOGNITION_APPROVED_REPORT_JSON`, and configure its Ed25519 key ID and base64 SPKI public key. The API verifies the signature, recomputes the canonical report hash, validates every fixed floor, requires the receipt's provider/model/prompt/schema/resolver/review-policy and catalog-registry identities to equal the deployed stack, and recomputes the canonical digest of deployed source registries, foods, aliases, nutrient profiles, and servings before startup succeeds. Clearing those values and returning the policy to `review_only` is the immediate rollback path.

Attach the Railway custom domain `api-nueat.boseong.dev` after the first successful deployment. Never commit `.env.local`, OTP values, database credentials, signed URLs, or image object keys.
