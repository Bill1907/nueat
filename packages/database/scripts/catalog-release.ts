import postgres from 'postgres';
import { guardedChildEnvironment, verifyDatabaseTarget } from '../src/migration-target-guard';
import { assertExactCatalogTaxonomyLiterals, buildCatalogDocuments, buildCatalogManifest, CATALOG_POLICY_SHA256, CATALOG_POLICY_VERSION, CATALOG_RELEASE_VERSION, CATALOG_TAXONOMY_SHA256, sha256 } from '../src/catalog-release';
import { FOOD_NORMALIZER_VERSION } from '../src/catalog-normalization';

type Action = 'backfill' | 'validate' | 'publish' | 'index';
type Args = { action: Action; release: string; apply: boolean; actor?: string; reason?: string; receiptVersion?: string; receiptSha256?: string };
type Release = { id: string; status: 'draft' | 'published' | 'revoked'; manifest_sha256: string };
type Source = { id: string; code: string; manifest_sha256: string };
type Food = { id: string; canonical_name_ko: string; category: string; preparation: string | null };
type Alias = { id: string; food_id: string; alias_ko: string };
type AuthoritySource = {
  source_release_id: string;
  priority: number;
  allowed_artifact_kinds: string[];
  eligibility_manifest_sha256: string;
};
type Counts = { foods: number; aliases: number; documents: number; profiles: number; servings: number; sources: number };
type Checkpoint = { last_id: string | null; row_count: number; rolling_sha256: string; status: 'running' | 'complete' };

const BATCH_SIZE = 500;
const JOB = 'catalog-release-backfill-v2';
const EMPTY_SHA256 = sha256('');

function args(values: readonly string[]): Args {
  const result: Args = { action: 'backfill', release: CATALOG_RELEASE_VERSION, apply: false };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    if (value === '--apply') result.apply = true;
    else if (value === '--action') result.action = values[++index] as Action;
    else if (value === '--release') result.release = values[++index]!;
    else if (value === '--actor') result.actor = values[++index];
    else if (value === '--reason') result.reason = values[++index];
    else if (value === '--receipt-version') result.receiptVersion = values[++index];
    else if (value === '--receipt-sha256') result.receiptSha256 = values[++index];
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!['backfill', 'validate', 'publish', 'index'].includes(result.action)) throw new Error('Action must be backfill, validate, publish, or index.');
  if (!result.apply) throw new Error('Database catalog commands require --apply.');
  if (result.action === 'publish' && (!result.actor || !result.reason || !result.receiptVersion || !/^[0-9a-f]{64}$/.test(result.receiptSha256 ?? ''))) throw new Error('Publish requires --actor, --reason, --receipt-version, and a lowercase SHA-256 --receipt-sha256.');
  return result;
}

const options = args(Bun.argv.slice(2));
const target = await verifyDatabaseTarget();
const sql = postgres(guardedChildEnvironment(target).DATABASE_URL!, { max: 1 });

async function counts(tx: postgres.TransactionSql, releaseId: string): Promise<Counts> {
  const rows = await tx<Counts[]>`select
    (select count(*)::int from catalog_release_food where catalog_release_id = ${releaseId}) as foods,
    (select count(*)::int from catalog_release_food_alias where catalog_release_id = ${releaseId}) as aliases,
    (select count(*)::int from catalog_release_search_document where catalog_release_id = ${releaseId}) as documents,
    (select count(*)::int from catalog_release_nutrient_profile where catalog_release_id = ${releaseId}) as profiles,
    (select count(*)::int from catalog_release_food_serving where catalog_release_id = ${releaseId}) as servings,
    (select count(*)::int from catalog_release_source where catalog_release_id = ${releaseId}) as sources`;
  return rows[0]!;
}

async function authorityMembership(
  tx: postgres.TransactionSql,
  releaseId: string,
) {
  const [profiles, servings, sources] = await Promise.all([
    tx<{ id: string }[]>`select nutrient_profile_id as id from catalog_release_nutrient_profile where catalog_release_id = ${releaseId} order by nutrient_profile_id`,
    tx<{ id: string }[]>`select food_serving_id as id from catalog_release_food_serving where catalog_release_id = ${releaseId} order by food_serving_id`,
    tx<AuthoritySource[]>`select source_release_id, priority, allowed_artifact_kinds, eligibility_manifest_sha256 from catalog_release_source where catalog_release_id = ${releaseId} order by priority, source_release_id`,
  ]);
  return {
    nutrientProfileIds: profiles.map((row) => row.id),
    foodServingIds: servings.map((row) => row.id),
    sources: sources.map((source) => ({
      sourceReleaseId: source.source_release_id,
      priority: source.priority,
      allowedArtifactKinds: source.allowed_artifact_kinds,
      eligibilityManifestSha256: source.eligibility_manifest_sha256,
    })),
  };
}

async function releaseForUpdate(tx: postgres.TransactionSql): Promise<Release> {
  const rows = await tx<Release[]>`select id, status, manifest_sha256 from catalog_release where version = ${options.release} for update`;
  if (rows.length !== 1 || rows[0]!.status !== 'draft') throw new Error(`Catalog release ${options.release} is not a draft.`);
  return rows[0]!;
}

async function checkpoint(tx: postgres.TransactionSql, releaseId: string, phase: string): Promise<Checkpoint> {
  await tx`insert into catalog_backfill_checkpoint (job_name, catalog_release_id, phase, last_id, row_count, rolling_sha256, status) values (${JOB}, ${releaseId}, ${phase}, null, 0, ${EMPTY_SHA256}, 'running') on conflict (job_name, catalog_release_id, phase) do nothing`;
  const rows = await tx<Checkpoint[]>`select last_id, row_count, rolling_sha256, status from catalog_backfill_checkpoint where job_name = ${JOB} and catalog_release_id = ${releaseId} and phase = ${phase} for update`;
  if (rows.length !== 1) throw new Error(`Checkpoint is unavailable for ${phase}.`);
  return rows[0]!;
}

async function bindLegacy(tx: postgres.TransactionSql, release: Release): Promise<void> {
  const mismatch = await tx<{ count: number }[]>`select count(*)::int as count
    from nutrient_profile profile
    join catalog_release_source member on member.catalog_release_id = ${release.id}
    join source_release source on source.id = member.source_release_id
    where profile.source_registry_id = source.source_registry_id
      and profile.dataset_version = source.version
      and profile.source_release_id is not null
      and profile.source_release_id <> source.id`;
  if (mismatch[0]!.count) throw new Error('Nutrient profile source release mismatch.');
  const ambiguousProfiles = await tx<{ count: number }[]>`select count(*)::int as count from (
    select profile.id from nutrient_profile profile join catalog_release_source member on member.catalog_release_id = ${release.id} join source_release source on source.id = member.source_release_id
    where profile.source_release_id is null and profile.source_registry_id = source.source_registry_id and profile.dataset_version = source.version
    group by profile.id having count(*) <> 1
  ) ambiguous`;
  if (ambiguousProfiles[0]!.count) throw new Error('Nutrient profile source release binding is ambiguous or absent.');
  await tx`update nutrient_profile profile set source_release_id = source.id from catalog_release_source member join source_release source on source.id = member.source_release_id where member.catalog_release_id = ${release.id} and profile.source_release_id is null and profile.source_registry_id = source.source_registry_id and profile.dataset_version = source.version`;
  const servingMismatch = await tx<{ count: number }[]>`select count(*)::int as count from food_serving serving join catalog_release_source member on member.catalog_release_id = ${release.id} join source_release source on source.id = member.source_release_id where serving.source_registry_id = source.source_registry_id and serving.source_release_id is not null and serving.source_release_id <> source.id`;
  if (servingMismatch[0]!.count) throw new Error('Food serving source release mismatch.');
  const ambiguousServings = await tx<{ count: number }[]>`select count(*)::int as count from (
    select serving.id from food_serving serving join catalog_release_source member on member.catalog_release_id = ${release.id} join source_release source on source.id = member.source_release_id
    where serving.source_release_id is null and serving.source_registry_id = source.source_registry_id
    group by serving.id having count(*) <> 1
  ) ambiguous`;
  if (ambiguousServings[0]!.count) throw new Error('Food serving source release binding is ambiguous or absent.');
  await tx`update food_serving serving set source_release_id = source.id from catalog_release_source member join source_release source on source.id = member.source_release_id where member.catalog_release_id = ${release.id} and serving.source_release_id is null and serving.source_registry_id = source.source_registry_id`;
}

async function runPhase(phase: string, mutate: (tx: postgres.TransactionSql, release: Release, lastId: string | null) => Promise<string[]>): Promise<void> {
  for (;;) {
    const done = await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${'nueat.catalog-release:' + options.release}))`;
      const release = await releaseForUpdate(tx);
      const state = await checkpoint(tx, release.id, phase);
      if (state.status === 'complete') return true;
      const ids = await mutate(tx, release, state.last_id);
      if (!ids.length) {
        await tx`update catalog_backfill_checkpoint set status = 'complete', completed_at = now(), updated_at = now() where job_name = ${JOB} and catalog_release_id = ${release.id} and phase = ${phase}`;
        return true;
      }
      const rolling = sha256(`${state.rolling_sha256}:${ids.join(':')}`);
      await tx`update catalog_backfill_checkpoint set last_id = ${ids.at(-1)!}, row_count = ${state.row_count + ids.length}, rolling_sha256 = ${rolling}, updated_at = now() where job_name = ${JOB} and catalog_release_id = ${release.id} and phase = ${phase}`;
      return false;
    });
    if (done) return;
  }
}

async function validate(tx: postgres.TransactionSql, release: Release): Promise<{ manifestSha256: string; documentCount: number }> {
  const sourceManifests = buildCatalogManifest().sourceManifests;
  const sources = await tx<Source[]>`select source.id, registry.code, source.manifest_sha256 from catalog_release_source member join source_release source on source.id = member.source_release_id join source_registry registry on registry.id = source.source_registry_id where member.catalog_release_id = ${release.id} order by member.priority`;
  if (sources.length !== sourceManifests.length || sources.some((source, i) => source.code !== sourceManifests[i]?.code || source.manifest_sha256 !== sourceManifests[i]?.manifestSha256)) throw new Error('Catalog release source membership is incomplete or mismatched.');
  const bound = await tx<{ count: number }[]>`select count(*)::int as count from nutrient_profile profile join catalog_release_source member on member.catalog_release_id = ${release.id} join source_release source on source.id = member.source_release_id where profile.source_registry_id = source.source_registry_id and (profile.source_release_id <> source.id or profile.dataset_version <> source.version) union all select count(*)::int as count from food_serving serving join catalog_release_source member on member.catalog_release_id = ${release.id} join source_release source on source.id = member.source_release_id where serving.source_registry_id = source.source_registry_id and serving.source_release_id <> source.id`;
  if (bound.some((row) => row.count)) throw new Error('Catalog member source release identity mismatch.');
  const foods = await tx<Food[]>`select food.id, food.canonical_name_ko, food.category, food.preparation from catalog_release_food member join food on food.id = member.food_id where member.catalog_release_id = ${release.id} order by food.id`;
  if (!foods.length) throw new Error('Catalog release has no food membership.');
  assertExactCatalogTaxonomyLiterals(foods.map((food) => food.category), foods.flatMap((food) => food.preparation ? [food.preparation] : []));
  const aliases = await tx<Alias[]>`select alias.id, alias.food_id, alias.alias_ko from catalog_release_food_alias member join food_alias alias on alias.id = member.food_alias_id where member.catalog_release_id = ${release.id} order by alias.food_id, alias.id`;
  const documents = buildCatalogDocuments([...foods.map((food) => ({ foodId: food.id, sourceAliasId: null, displayTextKo: food.canonical_name_ko })), ...aliases.map((alias) => ({ foodId: alias.food_id, sourceAliasId: alias.id, displayTextKo: alias.alias_ko }))]);
  const actual = await counts(tx, release.id);
  const declared = await tx<Counts[]>`select food_member_count as foods, food_alias_member_count as aliases, search_document_count as documents, nutrient_profile_member_count as profiles, food_serving_member_count as servings, source_release_member_count as sources from catalog_release where id = ${release.id}`;
  if (!declared[0] || Object.keys(actual).some((key) => actual[key as keyof Counts] !== declared[0]![key as keyof Counts])) throw new Error('Catalog release count validation failed.');
  const checkpoints = await tx<Checkpoint[]>`select last_id, row_count, rolling_sha256, status from catalog_backfill_checkpoint where job_name = ${JOB} and catalog_release_id = ${release.id}`;
  if (checkpoints.length !== 5 || checkpoints.some((state) => state.status !== 'complete' || !/^[0-9a-f]{64}$/.test(state.rolling_sha256))) throw new Error('Catalog backfill checkpoint validation failed.');
  const manifest = buildCatalogManifest(
    documents,
    await authorityMembership(tx, release.id),
  );
  if (manifest.manifestSha256 !== release.manifest_sha256) throw new Error('Catalog release manifest mismatch.');
  return { manifestSha256: manifest.manifestSha256, documentCount: documents.length };
}

async function ensureIndex(name: string, definition: string): Promise<void> {
  const current = await sql<{ indisvalid: boolean; indisready: boolean; method: string; table_name: string; definition: string }[]>`select index.indisvalid, index.indisready, method.amname as method, table_ref.relname as table_name, pg_get_indexdef(index.indexrelid) as definition from pg_index index join pg_class class on class.oid = index.indexrelid join pg_class table_ref on table_ref.oid = index.indrelid join pg_am method on method.oid = class.relam where class.relname = ${name}`;
  if (current.length && (!current[0]!.indisvalid || !current[0]!.indisready || current[0]!.method !== 'gin' || current[0]!.table_name !== 'catalog_release_search_document' || current[0]!.definition !== definition)) await sql.unsafe(`drop index concurrently ${name}`);
  if (!current.length || current[0]!.definition !== definition || !current[0]!.indisvalid || !current[0]!.indisready) await sql.unsafe(definition.replace(/^CREATE INDEX /, 'CREATE INDEX CONCURRENTLY '));
  const verified = await sql<{ indisvalid: boolean; indisready: boolean; method: string; table_name: string; definition: string }[]>`select index.indisvalid, index.indisready, method.amname as method, table_ref.relname as table_name, pg_get_indexdef(index.indexrelid) as definition from pg_index index join pg_class class on class.oid = index.indexrelid join pg_class table_ref on table_ref.oid = index.indrelid join pg_am method on method.oid = class.relam where class.relname = ${name}`;
  if (verified.length !== 1 || !verified[0]!.indisvalid || !verified[0]!.indisready || verified[0]!.method !== 'gin' || verified[0]!.table_name !== 'catalog_release_search_document' || verified[0]!.definition !== definition) throw new Error(`Concurrent index ${name} verification failed.`);
}

try {
  if (options.action === 'index') {
    await sql`set lock_timeout = '2s'`;
    await sql`set statement_timeout = '15min'`;
    await ensureIndex('catalog_release_search_document_trigrams_gin_idx', 'CREATE INDEX catalog_release_search_document_trigrams_gin_idx ON public.catalog_release_search_document USING gin (ordered_trigrams)');
    await ensureIndex('catalog_release_search_document_tokens_gin_idx', 'CREATE INDEX catalog_release_search_document_tokens_gin_idx ON public.catalog_release_search_document USING gin (ordered_tokens)');
    console.log(JSON.stringify({ action: options.action, release: options.release, valid: true }, null, 2));
  } else if (options.action === 'backfill') {
    const sourceManifests = buildCatalogManifest().sourceManifests;
    const setup = await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${'nueat.catalog-release:' + options.release}))`;
      for (const manifest of sourceManifests) {
        const registries = await tx<{ id: string }[]>`select id from source_registry where code = ${manifest.code} and dataset_version = ${manifest.version} for update`;
        if (registries.length !== 1) throw new Error(`Required source registry is absent or version-mismatched: ${manifest.code}.`);
        await tx`insert into source_identity (publisher, dataset, kind) values (${manifest.publisher}, ${manifest.dataset}, 'public_dataset') on conflict (publisher, dataset) do nothing`;
        await tx`insert into source_release (source_identity_id, source_registry_id, version, license_reference, license_sha256, artifact_sha256, manifest_sha256, artifact_kind) select id, ${registries[0]!.id}, ${manifest.version}, ${manifest.licenseReference}, ${manifest.licenseSha256}, ${manifest.artifactSha256}, ${manifest.manifestSha256}, ${manifest.artifactKind} from source_identity where publisher = ${manifest.publisher} and dataset = ${manifest.dataset} on conflict (source_identity_id, version) do nothing`;
      }
      await tx`insert into catalog_release (version, normalizer_version, normalizer_sha256, taxonomy_sha256, manifest_sha256, food_member_count, food_alias_member_count, search_document_count, nutrient_profile_member_count, food_serving_member_count, source_release_member_count) values (${options.release}, ${FOOD_NORMALIZER_VERSION}, ${sha256(FOOD_NORMALIZER_VERSION)}, ${CATALOG_TAXONOMY_SHA256}, ${buildCatalogManifest().manifestSha256}, 0, 0, 0, 0, 0, 0) on conflict (version) do nothing`;
      const release = await releaseForUpdate(tx);
      for (const [index, manifest] of sourceManifests.entries()) {
        const sources = await tx<Source[]>`select source.id, registry.code, source.manifest_sha256 from source_release source join source_identity identity on identity.id = source.source_identity_id join source_registry registry on registry.id = source.source_registry_id where registry.code = ${manifest.code} and registry.dataset_version = ${manifest.version} and identity.publisher = ${manifest.publisher} and identity.dataset = ${manifest.dataset} and source.version = ${manifest.version} and source.manifest_sha256 = ${manifest.manifestSha256} for update`;
        if (sources.length !== 1) throw new Error(`Frozen source release mismatch: ${manifest.code}@${manifest.version}.`);
        await tx`insert into catalog_release_source (catalog_release_id, source_release_id, priority, allowed_artifact_kinds, eligibility_manifest_sha256) values (${release.id}, ${sources[0]!.id}, ${100 + index}, ${[manifest.artifactKind]}, ${manifest.manifestSha256}) on conflict (catalog_release_id, source_release_id) do nothing`;
      }
      await bindLegacy(tx, release);
      return release;
    });
    await runPhase('food', async (tx, release, lastId) => (await tx<{ id: string }[]>`with batch as (select food.id from food join nutrient_profile profile on profile.food_id = food.id join catalog_release_source member on member.catalog_release_id = ${release.id} join source_release source on source.id = member.source_release_id and source.id = profile.source_release_id where food.id > coalesce(${lastId}::uuid, '00000000-0000-0000-0000-000000000000'::uuid) order by food.id limit ${BATCH_SIZE}) insert into catalog_release_food (catalog_release_id, food_id) select ${release.id}, id from batch on conflict do nothing returning food_id as id`).map((row) => row.id));
    await runPhase('alias', async (tx, release, lastId) => (await tx<{ id: string }[]>`with batch as (select alias.id from food_alias alias join catalog_release_food food on food.food_id = alias.food_id and food.catalog_release_id = ${release.id} where alias.id > coalesce(${lastId}::uuid, '00000000-0000-0000-0000-000000000000'::uuid) order by alias.id limit ${BATCH_SIZE}) insert into catalog_release_food_alias (catalog_release_id, food_alias_id) select ${release.id}, id from batch on conflict do nothing returning food_alias_id as id`).map((row) => row.id));
    await runPhase('profile', async (tx, release, lastId) => (await tx<{ id: string }[]>`with batch as (select profile.id from nutrient_profile profile join catalog_release_food food on food.food_id = profile.food_id and food.catalog_release_id = ${release.id} join catalog_release_source member on member.catalog_release_id = ${release.id} and member.source_release_id = profile.source_release_id where profile.id > coalesce(${lastId}::uuid, '00000000-0000-0000-0000-000000000000'::uuid) order by profile.id limit ${BATCH_SIZE}) insert into catalog_release_nutrient_profile (catalog_release_id, nutrient_profile_id) select ${release.id}, id from batch on conflict do nothing returning nutrient_profile_id as id`).map((row) => row.id));
    await runPhase('serving', async (tx, release, lastId) => (await tx<{ id: string }[]>`with batch as (select serving.id from food_serving serving join catalog_release_food food on food.food_id = serving.food_id and food.catalog_release_id = ${release.id} join catalog_release_source member on member.catalog_release_id = ${release.id} and member.source_release_id = serving.source_release_id where serving.id > coalesce(${lastId}::uuid, '00000000-0000-0000-0000-000000000000'::uuid) order by serving.id limit ${BATCH_SIZE}) insert into catalog_release_food_serving (catalog_release_id, food_serving_id) select ${release.id}, id from batch on conflict do nothing returning food_serving_id as id`).map((row) => row.id));
    await runPhase('document', async (tx, release, lastId) => {
      const rows = await tx<{ id: string; food_id: string; source_alias_id: string | null; display_text_ko: string }[]>`select coalesce(alias.id, food.id) as id, food.id as food_id, alias.id as source_alias_id, coalesce(alias.alias_ko, food.canonical_name_ko) as display_text_ko from catalog_release_food member join food on food.id = member.food_id left join catalog_release_food_alias alias_member on alias_member.catalog_release_id = member.catalog_release_id left join food_alias alias on alias.id = alias_member.food_alias_id and alias.food_id = food.id where member.catalog_release_id = ${release.id} and coalesce(alias.id, food.id) > coalesce(${lastId}::uuid, '00000000-0000-0000-0000-000000000000'::uuid) order by coalesce(alias.id, food.id) limit ${BATCH_SIZE}`;
      const documents = buildCatalogDocuments(rows.map((row) => ({ foodId: row.food_id, sourceAliasId: row.source_alias_id, displayTextKo: row.display_text_ko })));
      for (const document of documents) await tx`insert into catalog_release_search_document (catalog_release_id, food_id, source_alias_id, display_text_ko, normalized_spaced, normalized_compact, ordered_tokens, ordered_trigrams, normalizer_version, content_sha256) values (${release.id}, ${document.foodId}, ${document.sourceAliasId}, ${document.displayTextKo}, ${document.spaced}, ${document.compact}, ${document.orderedTokens}, ${document.orderedTrigrams}, ${FOOD_NORMALIZER_VERSION}, ${document.contentSha256}) on conflict (catalog_release_id, food_id, content_sha256) do nothing`;
      return rows.map((row) => row.id);
    });
    await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${'nueat.catalog-release:' + options.release}))`;
      const release = await releaseForUpdate(tx);
      const actual = await counts(tx, release.id);
      const foods = await tx<Food[]>`select food.id, food.canonical_name_ko, food.category, food.preparation from catalog_release_food member join food on food.id = member.food_id where member.catalog_release_id = ${release.id} order by food.id`;
      const aliases = await tx<Alias[]>`select alias.id, alias.food_id, alias.alias_ko from catalog_release_food_alias member join food_alias alias on alias.id = member.food_alias_id where member.catalog_release_id = ${release.id} order by alias.food_id, alias.id`;
      const manifest = buildCatalogManifest(
        [...foods.map((food) => ({ foodId: food.id, sourceAliasId: null, displayTextKo: food.canonical_name_ko })), ...aliases.map((alias) => ({ foodId: alias.food_id, sourceAliasId: alias.id, displayTextKo: alias.alias_ko }))],
        await authorityMembership(tx, release.id),
      );
      await tx`update catalog_release set food_member_count = ${actual.foods}, food_alias_member_count = ${actual.aliases}, search_document_count = ${actual.documents}, nutrient_profile_member_count = ${actual.profiles}, food_serving_member_count = ${actual.servings}, source_release_member_count = ${actual.sources}, manifest_sha256 = ${manifest.manifestSha256} where id = ${release.id}`;
    });
    console.log(JSON.stringify({ action: options.action, release: options.release, releaseId: setup.id, valid: true }, null, 2));
  } else {
    const result = await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${'nueat.catalog-release:' + options.release}))`;
      const release = await releaseForUpdate(tx);
      const verified = await validate(tx, release);
      if (options.action === 'publish') {
        await tx`update source_release set status = 'published', published_at = now() where id in (select source_release_id from catalog_release_source where catalog_release_id = ${release.id}) and status = 'draft'`;
        await tx`update catalog_release set status = 'published', published_at = now() where id = ${release.id} and status = 'draft'`;
        const activation = await tx<{ id: string }[]>`insert into release_activation (catalog_release_id, policy_version, policy_sha256, eligibility_manifest_sha256, signed_receipt_version, signed_receipt_sha256, actor_id, reason, effective_at) values (${release.id}, ${CATALOG_POLICY_VERSION}, ${CATALOG_POLICY_SHA256}, ${verified.manifestSha256}, ${options.receiptVersion!}, ${options.receiptSha256!}, ${options.actor!}, ${options.reason!}, now()) returning id`;
        await tx`select activate_catalog_release(${activation[0]!.id}, ${verified.manifestSha256})`;
      }
      return { action: options.action, release: options.release, ...verified, valid: true };
    });
    console.log(JSON.stringify(result, null, 2));
  }
} finally {
  await sql.end();
}
