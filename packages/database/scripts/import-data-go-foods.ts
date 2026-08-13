import { guardedChildEnvironment, verifyDatabaseTarget } from '../src/migration-target-guard';
import { applyDataGoImportPlan, buildDataGoImportPlan } from '../src/fixtures/import-data-go-foods';

function parseArgs(args: readonly string[]) {
  let page1: string | undefined;
  let page2: string | undefined;
  let apply = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--apply') apply = true;
    else if (arg === '--page1') page1 = args[++index];
    else if (arg === '--page2') page2 = args[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!page1 || !page2) throw new Error('Usage: bun run db:import:data-go-foods -- --page1 <json> --page2 <json> [--apply]');
  return { page1, page2, apply };
}

const { page1, page2, apply } = parseArgs(Bun.argv.slice(2));
const plan = await buildDataGoImportPlan(page1, page2);
if (apply) {
  const target = await verifyDatabaseTarget();
  const childEnv = guardedChildEnvironment(target);
  await applyDataGoImportPlan(childEnv.DATABASE_URL!, plan);
}
console.log(JSON.stringify({ ...plan.report, artifacts: plan.artifacts, version: plan.manifest.version, provider: plan.manifest.provider, license: plan.manifest.license, applied: apply }, null, 2));
