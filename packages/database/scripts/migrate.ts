import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  guardedChildEnvironment,
  verifyDatabaseTarget,
  type VerifiedDatabaseTarget,
} from '../src/migration-target-guard';

type Spawn = typeof spawn;
type VerifyTarget = (env: Record<string, string | undefined>) => Promise<VerifiedDatabaseTarget>;

export async function runMigration(
  targetName: 'bridge' | '0022' | '0023',
  env: Record<string, string | undefined> = process.env,
  spawnChild: Spawn = spawn,
  verifyTarget: VerifyTarget = verifyDatabaseTarget,
): Promise<void> {
  const target = await verifyTarget(env);
  const migrationsDirectory = await createTargetedMigrations(targetName);
  try {
    const childEnv = {
      ...guardedChildEnvironment(target, env),
      NUEAT_DRIZZLE_OUT: migrationsDirectory,
    };
    await new Promise<void>((resolve, reject) => {
      const child = spawnChild('bunx', ['drizzle-kit', 'migrate'], {
        env: childEnv,
        stdio: 'inherit',
      });
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(`Drizzle migration failed (${signal ?? code ?? 'unknown'})`));
      });
    });
  } finally {
    await rm(migrationsDirectory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [targetName] = process.argv.slice(2);
  if (targetName !== 'bridge' && targetName !== '0022' && targetName !== '0023') {
    console.error('Migration target must be one of: bridge, 0022, 0023');
    process.exitCode = 1;
  } else runMigration(targetName).catch(() => {
    console.error('Database target verification or migration failed');
    process.exitCode = 1;
  });
}

const MIGRATION_TARGET_INDEX = {
  bridge: 21,
  '0022': 22,
  '0023': 23,
} as const;

async function createTargetedMigrations(targetName: keyof typeof MIGRATION_TARGET_INDEX) {
  const sourceDirectory = join(import.meta.dir, '..', 'drizzle');
  const targetDirectory = await mkdtemp(join(tmpdir(), 'nueat-drizzle-'));
  const metaDirectory = join(targetDirectory, 'meta');
  await mkdir(metaDirectory);
  const journalPath = join(sourceDirectory, 'meta', '_journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  const entries = journal.entries.filter((entry) => entry.idx <= MIGRATION_TARGET_INDEX[targetName]);
  await Promise.all(entries.map((entry) =>
    copyFile(join(sourceDirectory, `${entry.tag}.sql`), join(targetDirectory, `${entry.tag}.sql`)),
  ));
  await writeFile(
    join(metaDirectory, '_journal.json'),
    `${JSON.stringify({ ...journal, entries }, null, 2)}\n`,
  );
  return targetDirectory;
}
