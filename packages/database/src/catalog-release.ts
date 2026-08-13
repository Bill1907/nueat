import { createHash } from 'node:crypto';
import { CORE_KOREAN_FOODS, CORE_KOREAN_FOOD_SOURCE, K_FIND_DATASET_VERSION } from './fixtures/core-korean-foods';
import { DATA_GO_MANIFEST, DATA_GO_SOURCE_CODE, DATA_GO_DATASET_VERSION } from './fixtures/import-data-go-foods';
import { FOOD_NORMALIZER_VERSION, normalizeFoodText } from './catalog-normalization';

export const CATALOG_POLICY_VERSION = 'catalog-release-v1';
export const CATALOG_CATEGORY_TO_V3_V1 = {
  '국 및 탕류': 'soup_stew',
  '구이류': 'unknown',
  '김치류': 'vegetable',
  '나물·숙채류': 'vegetable',
  '면 및 만두류': 'noodle_dumpling',
  '밥류': 'staple',
  '볶음류': 'mixed',
  '전·적 및 부침류': 'mixed',
  '조림류': 'mixed',
  '찌개 및 전골류': 'soup_stew',
} as const;
// Current K-FIND/Data.go imports do not carry a non-null preparation literal.
// Publication compares this exact map to release membership and fails closed
// when a future importer introduces one without an explicit taxonomy update.
export const CATALOG_PREPARATION_TO_V3_V1 = {} as const;
export const CATALOG_TAXONOMY_SHA256 = sha256(canonical({
  category: CATALOG_CATEGORY_TO_V3_V1,
  preparation: CATALOG_PREPARATION_TO_V3_V1,
}));
export const CATALOG_POLICY_SHA256 = sha256(canonical({
  version: CATALOG_POLICY_VERSION,
  normalizerVersion: FOOD_NORMALIZER_VERSION,
  categoryTaxonomy: CATALOG_CATEGORY_TO_V3_V1,
  preparationTaxonomy: CATALOG_PREPARATION_TO_V3_V1,
  sourcePriorityRanges: {
    publicDataset: [100, 199],
    manufacturer: [200, 299],
    commercial: [300, 399],
    importerRecipe: [400, 499],
  },
  profileOrder: [
    'sourcePriority',
    'quality',
    'supportedNutrientCountDesc',
    'sourceItemIdUtf8',
    'profileIdUtf8',
  ],
  supportedNutrients: [
    'energyMillicalories',
    'carbohydrateMg',
    'proteinMg',
    'fatMg',
    'fiberMg',
  ],
  missingNutrientSemantics: 'null-is-unavailable',
}));
export const CATALOG_RELEASE_VERSION = `kfind-${K_FIND_DATASET_VERSION}+data-go-${DATA_GO_DATASET_VERSION}`;

export type CatalogSourceManifest = { code: string; version: string; publisher: string; dataset: string; licenseReference: string; licenseSha256: string; artifactSha256: string; manifestSha256: string; artifactKind: string };
export type CatalogDocumentInput = { foodId: string; sourceAliasId: string | null; displayTextKo: string };
export type CatalogDocument = CatalogDocumentInput & ReturnType<typeof normalizeFoodText> & { contentSha256: string };
export type CatalogAuthorityMembership = {
  nutrientProfileIds: readonly string[];
  foodServingIds: readonly string[];
  sources: readonly {
    sourceReleaseId: string;
    priority: number;
    allowedArtifactKinds: readonly string[];
    eligibilityManifestSha256: string;
  }[];
};

export function sha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  return JSON.stringify(value);
}

export function buildCatalogSourceManifests(): readonly CatalogSourceManifest[] {
  const kfindArtifact = canonical(CORE_KOREAN_FOODS.map(({ id, ...food }) => food));
  const dataGoArtifact = canonical(DATA_GO_MANIFEST.pages);
  return [
    { code: CORE_KOREAN_FOOD_SOURCE.code, version: K_FIND_DATASET_VERSION, publisher: 'MFDS', dataset: 'K-FCDB', licenseReference: CORE_KOREAN_FOOD_SOURCE.licenseReference, licenseSha256: sha256(CORE_KOREAN_FOOD_SOURCE.licenseReference), artifactSha256: sha256(kfindArtifact), manifestSha256: sha256(canonical({ version: K_FIND_DATASET_VERSION, foods: CORE_KOREAN_FOODS.length, artifact: sha256(kfindArtifact) })), artifactKind: 'kfind-core-fixture' },
    { code: DATA_GO_SOURCE_CODE, version: DATA_GO_DATASET_VERSION, publisher: 'MFDS', dataset: 'Data.go 15100070', licenseReference: `${DATA_GO_MANIFEST.provider} | ${DATA_GO_MANIFEST.officialUrl} | ${DATA_GO_MANIFEST.license}`, licenseSha256: sha256(`${DATA_GO_MANIFEST.provider} | ${DATA_GO_MANIFEST.officialUrl} | ${DATA_GO_MANIFEST.license}`), artifactSha256: sha256(dataGoArtifact), manifestSha256: sha256(canonical(DATA_GO_MANIFEST)), artifactKind: 'data-go-json-pages' },
  ];
}

export function buildCatalogDocuments(inputs: readonly CatalogDocumentInput[]): CatalogDocument[] {
  const documents = inputs.map((input) => {
    const normalized = normalizeFoodText(input.displayTextKo);
    if (!normalized.compact) throw new Error(`Empty normalized catalog document: ${input.foodId}`);
    return { ...input, ...normalized, contentSha256: sha256(canonical({ foodId: input.foodId, sourceAliasId: input.sourceAliasId, displayTextKo: input.displayTextKo, normalized, normalizerVersion: FOOD_NORMALIZER_VERSION })) };
  }).sort((left, right) => left.foodId.localeCompare(right.foodId) || (left.sourceAliasId ?? '').localeCompare(right.sourceAliasId ?? '') || left.contentSha256.localeCompare(right.contentSha256));
  const seen = new Set<string>();
  for (const document of documents) {
    const key = `${document.foodId}:${document.sourceAliasId ?? 'canonical'}:${document.contentSha256}`;
    if (seen.has(key)) throw new Error(`Catalog document collision: ${key}`);
    seen.add(key);
  }
  return documents;
}

export function buildCatalogManifest(
  documents: readonly CatalogDocumentInput[] = [],
  authority: CatalogAuthorityMembership = {
    nutrientProfileIds: [],
    foodServingIds: [],
    sources: [],
  },
): { version: string; manifestSha256: string; sourceManifests: readonly CatalogSourceManifest[]; documentCount: number } {
  const sourceManifests = buildCatalogSourceManifests();
  const normalized = buildCatalogDocuments(documents);
  const exactAuthority = {
    nutrientProfileIds: [...new Set(authority.nutrientProfileIds)].sort(),
    foodServingIds: [...new Set(authority.foodServingIds)].sort(),
    sources: authority.sources
      .map((source) => ({
        ...source,
        allowedArtifactKinds: [...new Set(source.allowedArtifactKinds)].sort(),
      }))
      .sort(
        (left, right) =>
          left.priority - right.priority ||
          left.sourceReleaseId.localeCompare(right.sourceReleaseId),
      ),
  };
  return { version: CATALOG_RELEASE_VERSION, manifestSha256: sha256(canonical({ version: CATALOG_RELEASE_VERSION, normalizerVersion: FOOD_NORMALIZER_VERSION, normalizerSha256: sha256(FOOD_NORMALIZER_VERSION), taxonomySha256: CATALOG_TAXONOMY_SHA256, policySha256: CATALOG_POLICY_SHA256, sources: sourceManifests.map(({ code, manifestSha256 }) => ({ code, manifestSha256 })), authority: exactAuthority, documents: normalized.map(({ foodId, sourceAliasId, contentSha256 }) => ({ foodId, sourceAliasId, contentSha256 })) })), sourceManifests, documentCount: normalized.length };
}

export function assertExactCatalogTaxonomyLiterals(
  categories: readonly string[],
  preparations: readonly string[],
) {
  assertExactSet(
    'category',
    categories,
    Object.keys(CATALOG_CATEGORY_TO_V3_V1),
  );
  assertExactSet(
    'preparation',
    preparations,
    Object.keys(CATALOG_PREPARATION_TO_V3_V1),
  );
}

function assertExactSet(
  name: string,
  actualValues: readonly string[],
  expectedValues: readonly string[],
) {
  const actual = [...new Set(actualValues)].sort();
  const expected = [...expectedValues].sort();
  if (
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    throw new Error(
      `Catalog ${name} taxonomy literals do not match: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`,
    );
  }
}
