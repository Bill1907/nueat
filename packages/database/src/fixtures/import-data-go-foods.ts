import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import postgres from 'postgres';

export const DATA_GO_UUID_NAMESPACE = 'f5c49d53-d744-5c2e-9b4e-d477596b4d38';
export const DATA_GO_SOURCE_CODE = 'data_go_15100070_food_2026_04_29';
export const DATA_GO_COMPATIBLE_SOURCE_CODE = 'kfind_food_2025_12_29';
export const DATA_GO_DATASET_VERSION = '2026-04-29';
export const DATA_GO_SOURCE_ID = uuidV5(`source:${DATA_GO_SOURCE_CODE}`);
const REQUIRED_HEADERS = ['FOOD_CD', 'FOOD_NM', 'FOOD_LV3_NM', 'NUT_CON_SRTR_QUA', 'ENERC', 'CHOCDF', 'PROT', 'FATCE', 'FIBTG', 'SERV_SIZE', 'FOOD_SIZE'] as const;
export const DATA_GO_MANIFEST = {
  pages: [
    { sha256: '99ab7ccee24322de0913eedba0bf66c7b98ab5fbcc12026757a1287fecaac04c', byteSize: 10_232_377 },
    { sha256: 'c361d4b394e38c7b6ccf478f1f20a1b62ea8d2da8618b04de4f270426c692b99', byteSize: 9_694_734 },
  ],
  uniqueRows: 19_495,
  acceptedRows: 2_593,
  report: { missingCore: 11_162, non100g: 5_740, nullFiber: 1_477, verifiedServings: 0, estimatedFoodSizeServings: 2_577, omittedServings: 16 },
  version: DATA_GO_DATASET_VERSION,
  officialUrl: 'https://www.data.go.kr/data/15100070/standard.do',
  provider: 'MFDS',
  license: '이용허락범위 제한 없음',
} as const;

type ReportInvariants = { missingCore: number; non100g: number; nullFiber: number; verifiedServings: number; estimatedFoodSizeServings: number; omittedServings: number };
type Manifest = { pages: readonly { sha256: string; byteSize: number }[]; uniqueRows: number; acceptedRows: number; report?: ReportInvariants; version: string; officialUrl: string; provider: string; license: string };
type JsonRow = Record<string, unknown>;
export type DataGoFood = { sourceItemId: string; name: string; category: string; energyMillicalories: number; carbohydrateMg: number; proteinMg: number; fatMg: number; fiberMg: number | null; serving: { gramsMg: number; label: string; quality: 'verified' | 'estimated' } | null };
export type ImportPlan = { manifest: Manifest; artifacts: { filename: string; sha256: string; byteSize: number }[]; foods: DataGoFood[]; report: { rowCount: number; acceptedCount: number; rejectsByReason: Record<string, number>; nullFiberCount: number; servingQualityCounts: Record<string, number>; categoryCounts: Record<string, number>; reusedFoods: number; insertedOrUpserted: number } };

type PlannedRow = DataGoFood & { foodId: string; profileId: string; aliasId: string; servingId: string | null; normalizedAlias: string };
type ExistingProfile = { id: string; source_item_id: string; food_id: string; source_registry_id: string; dataset_version: string; basis_amount_mg: number; energy_millicalories: number; carbohydrate_mg: number; protein_mg: number; fat_mg: number; fiber_mg: number | null; quality_grade: string };
type ExistingFood = { id: string; canonical_name_ko: string; category: string };
type ExistingAlias = { id: string; food_id: string; alias_ko: string; normalized_alias_ko: string };
type ExistingServing = { id: string; food_id: string; unit: string; label_ko: string; amount_milliunits: number; grams_mg: number; source_registry_id: string; quality_grade: string };

function uuidBytes(uuid: string): Uint8Array { const hex = uuid.replace(/-/g, ''); if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error(`Invalid UUID namespace: ${uuid}`); return Uint8Array.from(hex.match(/.{2}/g)!.map((part) => Number.parseInt(part, 16))); }
export function uuidV5(name: string): string { const digest = createHash('sha1').update(uuidBytes(DATA_GO_UUID_NAMESPACE)).update(name, 'utf8').digest(); digest[6] = (digest[6]! & 0x0f) | 0x50; digest[8] = (digest[8]! & 0x3f) | 0x80; const hex = digest.subarray(0, 16).toString('hex'); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`; }
export function normalizeDataGoAlias(value: string): string { return value.normalize('NFC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, ''); }
function text(row: JsonRow, key: string): string | null { const value = row[key]; if (value === null || value === undefined) return null; const result = String(value).trim(); return result || null; }
export function scaledDecimal(value: string | null, field: string): number | null { if (value === null) return null; const match = /^(\d+)(?:\.(\d+))?$/.exec(value); if (!match) throw new Error(`Invalid ${field}: ${value}`); const fraction = match[2] ?? ''; if (fraction.length > 3 && /[1-9]/.test(fraction.slice(3))) throw new Error(`Fractional ${field} cannot be represented in milli-units: ${value}`); const scaled = BigInt(match[1]!) * 1000n + BigInt((fraction.slice(0, 3).padEnd(3, '0')) || '0'); if (scaled > 2_147_483_647n) throw new Error(`Overflow ${field}: ${value}`); return Number(scaled); }
export function exactPositiveGrams(value: string | null, field: string): number | null { if (value === null) return null; const match = /^(\d+(?:\.\d+)?)g$/i.exec(value); if (!match) return null; const grams = scaledDecimal(match[1]!, field); return grams && grams > 0 ? grams : null; }
async function artifact(path: string, expected: { sha256: string; byteSize: number }) { const file = await stat(path); if (file.size !== expected.byteSize) throw new Error(`Artifact byte size mismatch: expected ${expected.byteSize}, got ${file.size}`); const bytes = new Uint8Array(await Bun.file(path).arrayBuffer()); const sha256 = createHash('sha256').update(bytes).digest('hex'); if (sha256 !== expected.sha256) throw new Error(`Artifact SHA-256 mismatch: expected ${expected.sha256}, got ${sha256}`); let data: unknown; try { data = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error('Artifact is not valid JSON'); } if (!Array.isArray(data)) throw new Error('Artifact root must be a JSON array'); return { rows: data as JsonRow[], filename: path.split('/').pop()!, sha256, byteSize: file.size }; }

export async function buildDataGoImportPlan(page1: string, page2: string, manifest: Manifest = DATA_GO_MANIFEST): Promise<ImportPlan> {
  if (manifest.pages.length !== 2) throw new Error('Manifest must contain exactly two pages');
  const first = await artifact(page1, manifest.pages[0]!); const second = await artifact(page2, manifest.pages[1]!);
  const signatures = new Map<string, string>(); const rejectsByReason: Record<'missingCore' | 'non100g', number> = { missingCore: 0, non100g: 0 }; const foods: DataGoFood[] = [];
  for (const row of [...first.rows, ...second.rows]) {
    for (const header of REQUIRED_HEADERS) if (!(header in row)) throw new Error(`Missing required header: ${header}`);
    const code = text(row, 'FOOD_CD'); const signature = JSON.stringify(row);
    if (!code) throw new Error('Missing FOOD_CD');
    const prior = signatures.get(code); if (prior && prior !== signature) throw new Error(`Conflicting duplicate FOOD_CD: ${code}`); if (prior) continue; signatures.set(code, signature);
    if (text(row, 'NUT_CON_SRTR_QUA') !== '100g') { rejectsByReason.non100g++; continue; }
    try {
      const name = text(row, 'FOOD_NM'); const category = text(row, 'FOOD_LV3_NM'); if (!name || !category) throw new Error('Missing core');
      const energyMillicalories = scaledDecimal(text(row, 'ENERC'), 'ENERC'); const carbohydrateMg = scaledDecimal(text(row, 'CHOCDF'), 'CHOCDF'); const proteinMg = scaledDecimal(text(row, 'PROT'), 'PROT'); const fatMg = scaledDecimal(text(row, 'FATCE'), 'FATCE');
      if ([energyMillicalories, carbohydrateMg, proteinMg, fatMg].some((value) => value === null)) throw new Error('Missing core');
      const servingSize = exactPositiveGrams(text(row, 'SERV_SIZE'), 'SERV_SIZE'); const foodSize = exactPositiveGrams(text(row, 'FOOD_SIZE'), 'FOOD_SIZE');
      foods.push({ sourceItemId: code, name, category, energyMillicalories: energyMillicalories!, carbohydrateMg: carbohydrateMg!, proteinMg: proteinMg!, fatMg: fatMg!, fiberMg: scaledDecimal(text(row, 'FIBTG'), 'FIBTG'), serving: servingSize ? { gramsMg: servingSize, label: 'SERV_SIZE', quality: 'verified' } : foodSize ? { gramsMg: foodSize, label: 'FOOD_SIZE', quality: 'estimated' } : null });
    } catch { rejectsByReason.missingCore++; }
  }
  if (signatures.size !== manifest.uniqueRows) throw new Error(`Unique FOOD_CD count mismatch: expected ${manifest.uniqueRows}, got ${signatures.size}`);
  if (foods.length !== manifest.acceptedRows) throw new Error(`Accepted row count mismatch: expected ${manifest.acceptedRows}, got ${foods.length}`);
  foods.sort((a, b) => a.sourceItemId.localeCompare(b.sourceItemId)); const categoryCounts: Record<string, number> = {}; let nullFiberCount = 0; const servingQualityCounts: Record<string, number> = { verified: 0, estimated: 0, omitted: 0 };
  for (const food of foods) { categoryCounts[food.category] = (categoryCounts[food.category] ?? 0) + 1; if (food.fiberMg === null) nullFiberCount++; servingQualityCounts[food.serving?.quality ?? 'omitted']!++; }
  if (manifest.report) {
    const actual: ReportInvariants = { missingCore: rejectsByReason.missingCore, non100g: rejectsByReason.non100g, nullFiber: nullFiberCount, verifiedServings: servingQualityCounts.verified!, estimatedFoodSizeServings: servingQualityCounts.estimated!, omittedServings: servingQualityCounts.omitted! };
    for (const [key, value] of Object.entries(manifest.report) as [keyof ReportInvariants, number][]) if (actual[key] !== value) throw new Error(`Report ${key} mismatch: expected ${value}, got ${actual[key]}`);
  }
  return { manifest, artifacts: [first, second].map(({ filename, sha256, byteSize }) => ({ filename, sha256, byteSize })), foods, report: { rowCount: signatures.size, acceptedCount: foods.length, rejectsByReason, nullFiberCount, servingQualityCounts, categoryCounts, reusedFoods: 0, insertedOrUpserted: 0 } };
}

function batches<T>(values: readonly T[], size = 500): T[][] { const output: T[][] = []; for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size)); return output; }
function sameProfile(row: ExistingProfile, item: PlannedRow): boolean { return row.id === item.profileId && row.food_id === item.foodId && row.source_registry_id === DATA_GO_SOURCE_ID && row.dataset_version === DATA_GO_DATASET_VERSION && row.basis_amount_mg === 100000 && row.energy_millicalories === item.energyMillicalories && row.carbohydrate_mg === item.carbohydrateMg && row.protein_mg === item.proteinMg && row.fat_mg === item.fatMg && row.fiber_mg === item.fiberMg && row.quality_grade === 'verified'; }

type Sql = ReturnType<typeof postgres>;
export async function applyDataGoImportPlan(databaseUrl: string, plan: ImportPlan): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1 });
  const licenseReference = `${plan.manifest.provider} | ${plan.manifest.officialUrl} | ${plan.manifest.license} | criterion=${plan.manifest.version} | page1 sha256=${plan.artifacts[0]!.sha256}; bytes=${plan.artifacts[0]!.byteSize} | page2 sha256=${plan.artifacts[1]!.sha256}; bytes=${plan.artifacts[1]!.byteSize}`;
  try { await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${DATA_GO_SOURCE_CODE}))`;
    const registries = await tx<{ id: string; dataset_version: string; license_reference: string }[]>`select id, dataset_version, license_reference from source_registry where code = ${DATA_GO_SOURCE_CODE} for update`;
    if (registries.length && (registries[0]!.id !== DATA_GO_SOURCE_ID || registries[0]!.dataset_version !== DATA_GO_DATASET_VERSION || registries[0]!.license_reference !== licenseReference)) throw new Error('Data.go source registry identity/version mismatch');
    await tx`insert into source_registry (id, code, display_name, kind, dataset_version, license_reference) values (${DATA_GO_SOURCE_ID}, ${DATA_GO_SOURCE_CODE}, '식품의약품안전처 식품영양성분DB', 'public_dataset', ${DATA_GO_DATASET_VERSION}, ${licenseReference}) on conflict (code) do nothing`;
    const ids = plan.foods.map((food) => food.sourceItemId);
    const current = new Map<string, ExistingProfile>(); const reusable = new Map<string, string>();
    for (const batch of batches(ids)) {
      const profiles = await tx<ExistingProfile[]>`select id, source_item_id, food_id, source_registry_id, dataset_version, basis_amount_mg, energy_millicalories, carbohydrate_mg, protein_mg, fat_mg, fiber_mg, quality_grade from nutrient_profile where source_registry_id = ${DATA_GO_SOURCE_ID} and dataset_version = ${DATA_GO_DATASET_VERSION} and source_item_id = any(${tx.array(batch)})`;
      for (const profile of profiles) { if (current.has(profile.source_item_id)) throw new Error(`Duplicate current profile: ${profile.source_item_id}`); current.set(profile.source_item_id, profile); }
      const candidates = await tx<{ source_item_id: string; food_id: string; canonical_name_ko: string }[]>`select np.source_item_id, np.food_id, f.canonical_name_ko from nutrient_profile np join source_registry sr on sr.id = np.source_registry_id join food f on f.id = np.food_id where sr.code = ${DATA_GO_COMPATIBLE_SOURCE_CODE} and np.source_item_id = any(${tx.array(batch)})`;
      const byItem = new Map<string, Set<string>>();
      for (const candidate of candidates) { const item = plan.foods.find((food) => food.sourceItemId === candidate.source_item_id)!; if (normalizeDataGoAlias(candidate.canonical_name_ko) !== normalizeDataGoAlias(item.name)) continue; const foodIds = byItem.get(item.sourceItemId) ?? new Set<string>(); foodIds.add(candidate.food_id); byItem.set(item.sourceItemId, foodIds); }
      for (const [sourceItemId, foodIds] of byItem) { if (foodIds.size > 1) throw new Error(`Ambiguous compatible Food reuse: ${sourceItemId}`); reusable.set(sourceItemId, foodIds.values().next().value!); }
    }
    const rows: PlannedRow[] = plan.foods.map((item) => ({ ...item, foodId: current.get(item.sourceItemId)?.food_id ?? reusable.get(item.sourceItemId) ?? uuidV5(`food:${item.sourceItemId}`), profileId: uuidV5(`profile:${item.sourceItemId}`), aliasId: uuidV5(`alias:${item.sourceItemId}:${normalizeDataGoAlias(item.name)}`), servingId: item.serving ? uuidV5(`serving:${item.sourceItemId}:${item.serving.quality}:${item.serving.gramsMg}`) : null, normalizedAlias: normalizeDataGoAlias(item.name) }));
    for (const row of rows) { const profile = current.get(row.sourceItemId); if (profile && !sameProfile(profile, row)) throw new Error(`Existing profile mismatch: ${row.sourceItemId}`); }
    const foodIds = rows.map((row) => row.foodId); const profileIds = rows.map((row) => row.profileId); const servingIds = rows.flatMap((row) => row.servingId ? [row.servingId] : []);
    const foods = new Map<string, ExistingFood>(); const profilesById = new Map<string, ExistingProfile>(); const aliases = new Map<string, ExistingAlias>(); const aliasesByPair = new Map<string, ExistingAlias>(); const servings = new Map<string, ExistingServing>(); const dataGoServingsByFood = new Map<string, ExistingServing[]>();
    for (const batch of batches(foodIds)) for (const item of await tx<ExistingFood[]>`select id, canonical_name_ko, category from food where id = any(${tx.array(batch)}::uuid[])`) foods.set(item.id, item);
    for (const batch of batches(profileIds)) for (const item of await tx<ExistingProfile[]>`select id, source_item_id, food_id, source_registry_id, dataset_version, basis_amount_mg, energy_millicalories, carbohydrate_mg, protein_mg, fat_mg, fiber_mg, quality_grade from nutrient_profile where id = any(${tx.array(batch)}::uuid[])`) profilesById.set(item.id, item);
    for (const batch of batches(foodIds)) for (const item of await tx<ExistingAlias[]>`select id, food_id, alias_ko, normalized_alias_ko from food_alias where food_id = any(${tx.array(batch)}::uuid[])`) aliasesByPair.set(`${item.food_id}:${item.normalized_alias_ko}`, item);
    for (const row of rows) { const pairedAlias = aliasesByPair.get(`${row.foodId}:${row.normalizedAlias}`); if (pairedAlias) row.aliasId = pairedAlias.id; }
    const aliasIds = rows.map((row) => row.aliasId);
    for (const batch of batches(aliasIds)) for (const item of await tx<ExistingAlias[]>`select id, food_id, alias_ko, normalized_alias_ko from food_alias where id = any(${tx.array(batch)}::uuid[])`) aliases.set(item.id, item);
    for (const batch of batches(servingIds)) for (const item of await tx<ExistingServing[]>`select id, food_id, unit, label_ko, amount_milliunits, grams_mg, source_registry_id, quality_grade from food_serving where id = any(${tx.array(batch)}::uuid[])`) servings.set(item.id, item);
    for (const batch of batches(foodIds)) for (const item of await tx<ExistingServing[]>`select id, food_id, unit, label_ko, amount_milliunits, grams_mg, source_registry_id, quality_grade from food_serving where source_registry_id = ${DATA_GO_SOURCE_ID} and food_id = any(${tx.array(batch)}::uuid[])`) { const values = dataGoServingsByFood.get(item.food_id) ?? []; values.push(item); dataGoServingsByFood.set(item.food_id, values); }
    for (const row of rows) {
      const food = foods.get(row.foodId); if (food && (food.canonical_name_ko !== row.name || food.category !== row.category)) throw new Error(`Existing Food mismatch: ${row.sourceItemId}`);
      const profile = profilesById.get(row.profileId); if (profile && !sameProfile(profile, row)) throw new Error(`Profile ID ownership mismatch: ${row.sourceItemId}`);
      const alias = aliases.get(row.aliasId); if (alias && (alias.food_id !== row.foodId || alias.normalized_alias_ko !== row.normalizedAlias)) throw new Error(`Alias ID ownership mismatch: ${row.sourceItemId}`); if (current.has(row.sourceItemId) && !alias) throw new Error(`Missing required alias: ${row.sourceItemId}`);
      const sourceServings = dataGoServingsByFood.get(row.foodId) ?? [];
      if (row.servingId) {
        const serving = servings.get(row.servingId);
        if (serving && (serving.food_id !== row.foodId || serving.unit !== 'serving' || serving.label_ko !== row.serving!.label || serving.amount_milliunits !== 1000 || serving.grams_mg !== row.serving!.gramsMg || serving.source_registry_id !== DATA_GO_SOURCE_ID || serving.quality_grade !== row.serving!.quality)) throw new Error(`Serving ID ownership mismatch: ${row.sourceItemId}`);
        if (sourceServings.some((value) => value.id !== row.servingId)) throw new Error(`Serving ownership mismatch: ${row.sourceItemId}`);
        if (current.has(row.sourceItemId) && !serving) throw new Error(`Missing required serving: ${row.sourceItemId}`);
      } else if (sourceServings.length) {
        throw new Error(`Unexpected serving: ${row.sourceItemId}`);
      }
    }
    for (const batch of batches(rows)) {
      const foodData = batch.map((row) => ({ food_id: row.foodId, name: row.name, category: row.category }));
      const profileData = batch.map((row) => ({ profile_id: row.profileId, food_id: row.foodId, source_item_id: row.sourceItemId, energy_millicalories: row.energyMillicalories, carbohydrate_mg: row.carbohydrateMg, protein_mg: row.proteinMg, fat_mg: row.fatMg, fiber_mg: row.fiberMg }));
      const aliasData = batch.map((row) => ({ alias_id: row.aliasId, food_id: row.foodId, name: row.name, normalized_alias: row.normalizedAlias }));
      await tx.unsafe(`insert into food (id, canonical_name_ko, category) select food_id::uuid, name, category from jsonb_to_recordset($1::jsonb) as x(food_id text, name text, category text) on conflict (id) do nothing`, [tx.json(foodData)]);
      await tx.unsafe(`insert into nutrient_profile (id, food_id, source_registry_id, source_item_id, dataset_version, basis_amount_mg, energy_millicalories, carbohydrate_mg, protein_mg, fat_mg, fiber_mg, quality_grade) select profile_id::uuid, food_id::uuid, $2::uuid, source_item_id, $3, 100000, energy_millicalories, carbohydrate_mg, protein_mg, fat_mg, fiber_mg, 'verified' from jsonb_to_recordset($1::jsonb) as x(profile_id text, food_id text, source_item_id text, energy_millicalories int, carbohydrate_mg int, protein_mg int, fat_mg int, fiber_mg int) on conflict do nothing`, [tx.json(profileData), DATA_GO_SOURCE_ID, DATA_GO_DATASET_VERSION]);
      await tx.unsafe(`insert into food_alias (id, food_id, alias_ko, normalized_alias_ko) select alias_id::uuid, food_id::uuid, name, normalized_alias from jsonb_to_recordset($1::jsonb) as x(alias_id text, food_id text, name text, normalized_alias text) on conflict do nothing`, [tx.json(aliasData)]);
      const servingsData = batch.filter((row) => row.servingId).map((row) => ({ serving_id: row.servingId, food_id: row.foodId, serving: row.serving }));
      if (servingsData.length) await tx.unsafe(`insert into food_serving (id, food_id, unit, label_ko, amount_milliunits, grams_mg, source_registry_id, quality_grade) select serving_id::uuid, food_id::uuid, 'serving', serving->>'label', 1000, (serving->>'gramsMg')::int, $2::uuid, (serving->>'quality')::quality_grade from jsonb_to_recordset($1::jsonb) as x(serving_id text, food_id text, serving jsonb) on conflict do nothing`, [tx.json(servingsData), DATA_GO_SOURCE_ID]);
    }
    plan.report.reusedFoods = reusable.size; plan.report.insertedOrUpserted = rows.length;
  }); } finally { await sql.end(); }
}
function parseArgs(args: string[]) { let page1: string | undefined; let page2: string | undefined; let apply = false; for (let i = 0; i < args.length; i++) { const arg = args[i]!; if (arg === '--apply') apply = true; else if (arg === '--page1') page1 = args[++i]; else if (arg === '--page2') page2 = args[++i]; else throw new Error(`Unknown argument: ${arg}`); } if (!page1 || !page2) throw new Error('Usage: bun run db:import:data-go-foods -- --page1 <json> --page2 <json> [--apply]'); return { page1, page2, apply }; }
if (import.meta.main) { const { page1, page2, apply } = parseArgs(Bun.argv.slice(2)); const plan = await buildDataGoImportPlan(page1, page2); if (apply) { const url = Bun.env.DATABASE_URL; if (!url) throw new Error('DATABASE_URL is required with --apply'); await applyDataGoImportPlan(url, plan); } console.log(JSON.stringify({ ...plan.report, artifacts: plan.artifacts, version: plan.manifest.version, provider: plan.manifest.provider, license: plan.manifest.license, applied: apply }, null, 2)); }
