import { expo } from '@better-auth/expo';
import {
  accounts,
  authRateLimits,
  sessions,
  users,
  verifications,
  type Database,
} from '@nueat/database';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { emailOTP } from 'better-auth/plugins';

import type { ApiEnvironment } from '../config/env';
import type { OtpMailer } from '../services/otp-mailer';

export function createAuth(
  database: Database,
  mailer: OtpMailer,
  environment: ApiEnvironment,
) {
  return betterAuth({
    appName: 'NUEAT',
    baseURL: environment.betterAuthUrl,
    basePath: '/api/auth',
    secret: environment.betterAuthSecret,
    trustedOrigins: environment.trustedOrigins,
    database: drizzleAdapter(database, {
      provider: 'pg',
      transaction: true,
      schema: {
        user: users,
        session: sessions,
        account: accounts,
        verification: verifications,
        rateLimit: authRateLimits,
      },
    }),
    emailAndPassword: {
      enabled: false,
    },
    account: {
      accountLinking: {
        enabled: false,
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },
    rateLimit: {
      enabled: true,
      storage: 'database',
      window: 60,
      max: 100,
    },
    advanced: {
      ipAddress: {
        ipAddressHeaders: ['x-forwarded-for', 'x-real-ip'],
      },
    },
    plugins: [
      emailOTP({
        otpLength: 6,
        expiresIn: 300,
        allowedAttempts: 3,
        resendStrategy: 'rotate',
        storeOTP: 'hashed',
        overrideDefaultEmailVerification: true,
        rateLimit: {
          window: 60,
          max: 3,
        },
        async sendVerificationOTP({ email, otp, type }) {
          await mailer.send({ email, otp, purpose: type });
        },
      }),
      expo(),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
