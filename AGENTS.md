# Repository Guidelines

## Project Overview

NUEAT is a Korea-first AI nutrition coach. Users photograph meals, correct recognized foods and portions, review deterministic nutrition totals from traceable data sources, and receive constrained next-meal recommendations. `PRD.md` is the product and safety source of truth.

## Architecture & Data Flow

The client is an Expo/React Native application written in TypeScript and routed with Expo Router. Application routes live in `apps/mobile/src/app/`; reusable mobile UI, hooks, and constants live under `apps/mobile/src/`. The backend runs on Bun as a Fastify service on Railway at `api-nueat.boseong.dev`, uses Better Auth with email OTP only, Drizzle for database access, and Neon PostgreSQL for persistence. Resend sends OTP mail as `NUEAT <auth@boseong.dev>`. Do not add social or password authentication.

Meal images are stored in a private Railway Bucket. The API authenticates the user, generates server-owned object keys, and issues short-lived presigned upload/download access. Persist object keys, never signed URLs. Validate upload size, MIME type, and file signatures before recognition, and delete objects with the owning meal or account.

Re-encode uploads client-side to remove EXIF/GPS, cap the long edge at 1,600px and size at 10MB, and remove local temporary files after upload. Presigned uploads expire after 5 minutes. Inference assets expire within 24 hours; only sanitized 512px thumbnails persist with meal history. Deletion must be performed through retryable `asset_deletion_job` records before account hard deletion. Never log image bytes, base64, signed URLs, object keys, EXIF, or email addresses.
Upload completion is server-authoritative: compare the stored object with the declared contract, decode it with Sharp, reject unsupported signatures, dimensions above 1,600px, GPS or non-normalized EXIF fields, then persist dimensions and SHA-256. Never trust client completion metadata.
Validated images attach to at most one MealLog. `POST /api/meal-logs` is idempotent by image asset and creates only a `draft`; mock recognition is versioned as `mock-recognition-v1`, contains labels/portions/confidence only, and MUST NOT be treated as nutrition data or confirmed intake.

Planned core flow: authenticated presigned upload → private image storage → food candidates → user confirmation → canonical food mapping → deterministic nutrition calculation → daily gap calculation → constrained recommendation ranking → AI-authored explanation. Generated models may recognize or explain food, but MUST NOT invent nutrition values. Persist source IDs, dataset versions, serving conversions, confidence, and calculation versions. The AI provider/model remains undecided and must be selected through Korean-food golden-set evaluation.
The initial canonical catalog is `packages/database/src/fixtures/core-korean-foods.ts`: exactly 20 analyzed K-FIND 음식 DB records from release `2025-12-29`. Preserve the K-FCDB food code, dataset version, integer scaling, gram-only serving evidence, and MFDS attribution/copyright reference. Do not infer ml-to-g conversions.

## Key Directories

- `apps/mobile/src/app/`: Expo Router screens and layouts.
- `apps/mobile/src/components/`: Reusable mobile UI components.
- `apps/mobile/src/hooks/`: Shared React hooks.
- `apps/mobile/src/auth/`: Better Auth client, secure session storage, and auth input rules.
- `apps/mobile/assets/`: App icons and bundled images.
- `apps/api/src/`: Fastify server, Better Auth configuration, routes, and external service adapters.
- `packages/domain/src/`: Pure versioned nutrition and safety policies shared by mobile and API.
- `packages/database/src/schema/`: Drizzle data contracts grouped by domain.
- `packages/database/drizzle/`: Generated, committed PostgreSQL migrations.
- `.gjc/`: Agent runtime state; do not edit for product changes.

## Development Commands

```bash
bun install
bun run start
bun run ios
bun run android
bun run web
bun run api
bun run api:start
bun test
bun run lint
bun run typecheck
bun run --cwd packages/database db:check
bun run --cwd packages/database db:migrate
```

## Code Conventions & Common Patterns

- Use strict TypeScript and functional React components.
- Keep route files focused on composition; move reusable UI and domain logic out of `apps/mobile/src/app/`.
- Model nutrition calculations as pure, deterministic functions with fixture-based tests.
- The target engine uses the versioned 2025 KDRI policy in `packages/domain/src/nutrition-targets.ts`; never duplicate formulas or UI metadata.
- Onboarding metadata and consent documents live in `packages/domain/src/onboarding.ts`; API and mobile MUST share these values rather than copy labels, versions, hashes, or safety options.
- Represent loading, empty, error, low-confidence, draft, and confirmed states explicitly.
- Treat allergies and excluded foods as hard constraints, never ranking preferences.
- Do not treat missing nutrient values as zero or commit unconfirmed recognition as consumed food.
- Preserve raw inputs and versioned calculation references so displayed totals are reproducible.
- Store nutrient quantities in integer minimum units; `null` means unavailable and MUST remain distinct from zero.
- Treat confirmed calculation snapshots and consent events as immutable append-only records.
- Serving and nutrient arithmetic lives in `packages/domain/src/meal-nutrition.ts`: use integer milliunits/milligrams, BigInt intermediates, and positive half-up rounding. Never assume `1ml = 1g`.
- A meal nutrient total is publishable only when every item has that nutrient; preserve partial known totals and missing-item counts instead of understating intake.
- API errors use `{ error: { code, message, requestId } }`; never expose stack traces or secret-bearing upstream errors.
- Better Auth OTPs are six digits, hashed at rest, valid for five minutes, and limited to three attempts. Keep social and password login disabled.
- Native auth cookies belong in Expo SecureStore through `@better-auth/expo`; never persist session tokens in AsyncStorage or application state. Web storage is only a preview fallback.
- Onboarding completion is terminal and transactional: append all current consent decisions, update `user_profile`, and create a versioned nutrition profile only for calculated results. Limited-mode results must not create numeric targets.
- Image asset queries MUST include authenticated ownership. Return opaque asset IDs to clients; never return bucket names or object keys. Signed PUTs are five minutes and signed GETs are two minutes.

## Important Files

- `PRD.md`: Requirements, safety boundaries, data model, and acceptance criteria.
- `package.json`: Runtime dependencies and development scripts.
- `apps/mobile/app.json`: Expo application configuration.
- `apps/mobile/src/app/_layout.tsx`: Root navigation layout.
- `apps/mobile/src/app/index.tsx`: Initial route.
- `apps/mobile/src/app/explore.tsx`: User-visible nutrition calculation standard and safety policy.
- `apps/mobile/src/components/auth/email-otp-screen.tsx`: Email/OTP login, resend cooldown, and client-side attempt UX.
- `apps/mobile/src/components/auth/auth-gate.tsx`: Session restoration and authenticated route gate.
- `apps/mobile/src/auth/client.ts`: Better Auth Expo client and SecureStore integration.
- `apps/mobile/src/components/onboarding/onboarding-flow.tsx`: Six-step authenticated onboarding and calculated/limited result confirmation.
- `apps/mobile/src/components/onboarding/form.ts`: Testable mobile form-to-API unit conversions and required-consent gate.
- `apps/mobile/src/components/active-nutrition-target-card.tsx`: Home target loading, error, pending, limited, and active states.
- `apps/mobile/src/components/meal-photo-upload-card.tsx`: Camera/library selection and explicit prepare/upload/validate/retry/cancel states.
- `apps/mobile/src/uploads/image-preprocessor.ts`: Re-encoding, 1,600px resize, compression attempts, and durable draft creation.
- `apps/mobile/src/uploads/image-upload-client.ts`: Signed PUT progress/cancellation and server completion.
- `apps/mobile/src/uploads/image-upload-draft.ts`: Single 24-hour local retry draft; never stores signed URLs.
- `apps/mobile/.env.example`: Public API URL configuration; `EXPO_PUBLIC_*` variables MUST NOT contain secrets.
- `apps/mobile/src/components/meal-confirmation-modal.tsx`: Draft image, mock candidates, confidence, and item add/edit/delete UI.
- `apps/mobile/src/api/meal-drafts.ts`: Authenticated MealLog draft and item mutation client.
- `apps/mobile/src/meals/meal-draft-policy.ts`: Pure meal-time inference, portion parsing, and serving-unit labels.
- `apps/mobile/src/api/foods.ts`: Authenticated source-backed canonical food search client.
- `apps/mobile/src/meals/food-selection-policy.ts`: Pure Korean label comparison and mapping-validity rules.
- `apps/api/src/server.ts`: Fastify composition, CORS, redacted logging, and error contracts.
- `apps/api/src/auth/auth.ts`: Better Auth email OTP policy.
- `apps/api/.env.example`: API and Railway environment contract.
- `apps/api/src/routes/onboarding.ts`: Authenticated status, target preview, and atomic completion endpoints.
- `apps/api/src/routes/nutrition-target.ts`: Authenticated pending/limited/active nutrition-target response for product surfaces.
- `apps/api/src/routes/image-asset.ts`: Authenticated upload intents, server validation completion, safe status, and download signing.
- `apps/api/src/routes/meal-log.ts`: Owned image attachment, idempotent draft creation, versioned mock recognition, and draft item mutations.
- `apps/api/src/routes/food.ts`: Authenticated normalized food search with preferred sourced profiles and servings.
- `apps/api/src/services/image-object-store.ts`: S3-compatible Railway Bucket adapter and sanitized storage errors.
- `apps/api/src/services/image-validator.ts`: Decoding, type/dimension/metadata validation, and SHA-256 derivation.
- `packages/domain/src/nutrition-targets.ts`: KDRI target policy, provenance constants, and limited-mode rules.
- `packages/domain/src/onboarding.ts`: Shared consent versions/hashes, Korean labels, profile contract, and target-input conversion.
- `packages/domain/src/meal-nutrition.ts`: Serving conversion, item calculation, completeness-aware aggregation, and calculation errors.
- `packages/database/src/schema/index.ts`: Database schema export.
- `packages/database/src/schema/meal.ts`: MealLog/MealItem state, recognition provenance, ownership links, and draft constraints.
- `packages/database/src/fixtures/core-korean-foods.ts`: Versioned K-FIND 20-food manifest and source attribution.
- `packages/database/drizzle.config.ts`: Migration configuration.
- `packages/database/.env.example`: Neon connection variable template; real credentials belong in ignored `.env.local` or Railway secrets.
- `Dockerfile` and `railway.json`: Railway API build, migration, readiness, and restart policy.

## Runtime/Tooling Preferences

Use Bun 1.3.14 as the workspace package manager, script runner, test runner, and Railway API runtime; `bun.lock` is the only dependency lockfile. Keep Node.js LTS installed because Expo tooling may invoke Node/npm internally. The app targets Expo SDK 57, React Native, and TypeScript; backend services target Railway with Fastify, Drizzle, Neon PostgreSQL 18, Better Auth, and private Railway Buckets. Database development and migrations run directly against Neon through the ignored `packages/database/.env.local`; do not start local PostgreSQL. Review generated SQL before `db:migrate` because it targets the shared remote database. Prefer Expo-supported client libraries and Bun-compatible server libraries. Do not introduce Cloudflare runtime APIs, switch package managers, or edit generated lockfiles manually.

## Testing & QA

Run `bun run typecheck` and `bun run lint` for code changes. Use `bun test` for domain and backend tests. Nutrition calculations require complete branch and unit coverage, including serving conversion, missing values, rounding, and date/timezone boundaries. Critical flows require device or simulator verification for permission denial, upload failure, offline draft preservation, correction, deletion, and accessibility states.
