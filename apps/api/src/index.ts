import { createDatabase } from '@nueat/database';

import { createAuth } from './auth/auth';
import { parseEnvironment } from './config/env';
import { buildServer } from './server';
import { createResendOtpMailer } from './services/otp-mailer';
import {
  recognitionEventLogFields,
} from './services/recognition-observability';

const environment = parseEnvironment(process.env);
const database = createDatabase(environment.databaseUrl);
const mailer = createResendOtpMailer(environment.resendApiKey, environment.authEmailFrom);
const auth = createAuth(database, mailer, environment);
let app: Awaited<ReturnType<typeof buildServer>>;
app = await buildServer({
  environment,
  database,
  auth,
  recognitionEventSink(event) {
    app?.log.info(
      recognitionEventLogFields(event),
      'Recognition execution event',
    );
  },
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'Shutting down API');

  try {
    await app.close();
    await database.$client.close({ timeout: 5 });
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error }, 'Graceful shutdown failed');
    process.exit(1);
  }
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: environment.host, port: environment.port });
} catch (error) {
  app.log.fatal({ err: error }, 'API startup failed');
  await database.$client.close({ timeout: 1 });
  process.exit(1);
}
