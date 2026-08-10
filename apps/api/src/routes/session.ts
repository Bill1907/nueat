import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyPluginAsync } from 'fastify';

import type { Auth } from '../auth/auth';

export const sessionRoutes: FastifyPluginAsync<{ auth: Auth }> = async (app, options) => {
  app.get('/api/me', async (request, reply) => {
    const result = await options.auth.api.getSession({
      headers: fromNodeHeaders(request.headers),
    });

    if (!result) {
      return reply.status(401).send({
        error: {
          code: 'UNAUTHORIZED',
          message: '로그인이 필요합니다.',
          requestId: request.id,
        },
      });
    }

    return {
      user: {
        id: result.user.id,
        email: result.user.email,
        name: result.user.name,
        emailVerified: result.user.emailVerified,
      },
      session: {
        expiresAt: result.session.expiresAt,
      },
    };
  });
};
