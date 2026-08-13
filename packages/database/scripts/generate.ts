import { spawn } from 'node:child_process';

const child = spawn('bunx', ['drizzle-kit', 'generate'], {
  env: { ...process.env, NUEAT_DATABASE_SCHEMA_ONLY: '1' },
  stdio: 'inherit',
});

child.once('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once('exit', (code) => {
  if (code !== 0) process.exitCode = 1;
});
