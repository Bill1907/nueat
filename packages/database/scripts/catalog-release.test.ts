import { expect, test } from 'bun:test';

test('catalog commands refuse database access without explicit apply', async () => {
  const process = Bun.spawn(['bun', 'run', 'scripts/catalog-release.ts', '--action', 'backfill'], { cwd: import.meta.dir + '/..', stdout: 'pipe', stderr: 'pipe' });
  const output = await new Response(process.stderr).text();
  expect(await process.exited).not.toBe(0);
  expect(output).toContain('require --apply');
});

test('activation requires complete receipt metadata before database access', async () => {
  const process = Bun.spawn(['bun', 'run', 'scripts/catalog-release.ts', '--apply', '--action', 'publish'], { cwd: import.meta.dir + '/..', stdout: 'pipe', stderr: 'pipe' });
  const output = await new Response(process.stderr).text();
  expect(await process.exited).not.toBe(0);
  expect(output).toContain('Publish requires');
});
