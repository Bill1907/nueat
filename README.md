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
```

Authentication uses Better Auth email OTP only. Resend sends six-digit OTPs from `NUEAT <auth@boseong.dev>`; codes expire after five minutes and allow three attempts.

The Expo client gates product routes behind the session, stores native auth cookies in SecureStore, restores sessions on launch, and provides email entry, six-digit OTP, 60-second resend cooldown, three-attempt UX, and logout. `EXPO_PUBLIC_API_URL` is public configuration and defaults to `https://api-nueat.boseong.dev`; never place secrets in an `EXPO_PUBLIC_*` variable.

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
```

Attach the Railway custom domain `api-nueat.boseong.dev` after the first successful deployment. Never commit `.env.local`, OTP values, database credentials, signed URLs, or image object keys.
