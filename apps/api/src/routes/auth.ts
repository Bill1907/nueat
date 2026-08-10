import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyPluginAsync } from 'fastify';

import type { Auth } from '../auth/auth';
import type { ApiEnvironment } from '../config/env';

interface AuthRouteOptions {
  auth: Auth;
  environment: ApiEnvironment;
}

export const authRoutes: FastifyPluginAsync<AuthRouteOptions> = async (app, options) => {
  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    async handler(request, reply) {
      try {
        const url = new URL(request.url, options.environment.betterAuthUrl);
        const body = getRequestBody(request.method, request.body);
        const authRequest = new Request(url, {
          method: request.method,
          headers: fromNodeHeaders(request.headers),
          ...(body === undefined ? {} : { body }),
        });
        const response = await options.auth.handler(authRequest);

        reply.status(response.status);
        const setCookies = response.headers.getSetCookie();
        response.headers.forEach((value, key) => {
          if (key !== 'set-cookie') reply.header(key, value);
        });
        if (setCookies.length > 0) reply.header('set-cookie', setCookies);

        return reply.send(response.body ? await response.text() : null);
      } catch (error) {
        request.log.error({ err: error }, 'Authentication request failed');
        return reply.status(500).send({
          error: {
            code: 'AUTH_FAILURE',
            message: '인증 요청을 처리하지 못했습니다.',
            requestId: request.id,
          },
        });
      }
    },
  });
};

function getRequestBody(method: string, body: unknown) {
  if (method === 'GET' || method === 'HEAD' || body === undefined || body === null) {
    return undefined;
  }
  return typeof body === 'string' ? body : JSON.stringify(body);
}
