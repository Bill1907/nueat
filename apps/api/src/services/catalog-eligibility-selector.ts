export const TRUSTED_NUTRITION_SELECTOR_VERSION = 'trusted-nutrition-selector-v1';

export type CatalogServingUnit = 'g' | 'ml' | 'serving' | 'bowl' | 'piece';
type TrustedSourceKind = 'public_dataset' | 'manufacturer' | 'commercial_dataset';
type EligibleQuality = 'verified' | 'estimated';

export type CatalogEligibilityReason =
  | 'CATALOG_RELEASE_NOT_PUBLISHED'
  | 'FOOD_NOT_RELEASE_MEMBER'
  | 'DEPRECATED_FOOD'
  | 'PROFILE_NOT_RELEASE_MEMBER'
  | 'MISMATCHED_PROFILE'
  | 'SOURCE_RELEASE_NOT_FOUND'
  | 'SOURCE_RELEASE_REVOKED'
  | 'SOURCE_RELEASE_NOT_PUBLISHED'
  | 'UNTRUSTED_SOURCE_KIND'
  | 'SOURCE_NOT_APPROVED'
  | 'SOURCE_ARTIFACT_NOT_ALLOWED'
  | 'PROFILE_SOURCE_MISMATCH'
  | 'PROFILE_SOURCE_VERSION_MISMATCH'
  | 'UNTRUSTED_PROFILE_QUALITY'
  | 'NO_SUPPORTED_NUTRIENTS'
  | 'SERVING_NOT_RELEASE_MEMBER'
  | 'MISMATCHED_SERVING'
  | 'MISSING_SERVING_CONVERSION'
  | 'UNTRUSTED_SERVING_SOURCE'
  | 'AMBIGUOUS_SERVING_CONVERSION';

export type TrustedNutritionSelectorInput = {
  catalogReleaseId: string;
  foodId: string;
  unit: CatalogServingUnit;
};

export type TrustedNutritionSelectorRows = {
  catalogRelease: {
    id: string;
    status: 'draft' | 'published' | 'revoked';
    manifestSha256: string;
  } | null;
  food: { id: string; canonicalNameKo: string; isDeprecated: boolean } | null;
  foodMembers: Array<{ catalogReleaseId: string; foodId: string }>;
  profiles: NutrientProfileRow[];
  profileMembers: Array<{ catalogReleaseId: string; nutrientProfileId: string }>;
  servings: FoodServingRow[];
  servingMembers: Array<{ catalogReleaseId: string; foodServingId: string }>;
  sourceReleases: SourceReleaseRow[];
  catalogSources: CatalogSourceRow[];
};

export type NutrientProfileRow = {
  id: string;
  foodId: string;
  sourceRegistryId: string;
  sourceReleaseId: string;
  sourceItemId: string;
  datasetVersion: string;
  basisAmountMg: number;
  energyMillicalories: number | null;
  carbohydrateMg: number | null;
  proteinMg: number | null;
  fatMg: number | null;
  fiberMg: number | null;
  qualityGrade: 'verified' | 'estimated' | 'unverified';
};

export type FoodServingRow = {
  id: string;
  foodId: string;
  sourceRegistryId: string;
  sourceReleaseId: string;
  unit: CatalogServingUnit;
  amountMilliunits: number;
  gramsMg: number;
  qualityGrade: 'verified' | 'estimated' | 'unverified';
};

export type SourceReleaseRow = {
  id: string;
  sourceRegistryId: string;
  version: string;
  status: 'draft' | 'published' | 'revoked';
  kind: TrustedSourceKind | 'recipe_estimate' | 'user_entered';
  artifactKind: string;
  licenseSha256: string;
  artifactSha256: string;
  manifestSha256: string;
};

export type CatalogSourceRow = {
  catalogReleaseId: string;
  sourceReleaseId: string;
  priority: number;
  allowedArtifactKinds: string[];
  eligibilityManifestSha256: string;
};

export type TrustedNutritionSelection = {
  kind: 'selected';
  food: { id: string; canonicalNameKo: string };
  profile: NutrientProfileRow;
  serving: FoodServingRow | null;
  provenance: {
    catalogReleaseId: string;
    catalogManifestSha256: string;
    sourceReleaseId: string;
    sourceReleaseVersion: string;
    sourceLicenseSha256: string;
    sourceArtifactSha256: string;
    sourceManifestSha256: string;
    catalogSourcePriority: number;
    eligibilityManifestSha256: string;
  };
};

export type TrustedNutritionSelectionFailure = {
  kind: 'unavailable';
  reason: CatalogEligibilityReason;
};

export type TrustedNutritionSelectionResult =
  | TrustedNutritionSelection
  | TrustedNutritionSelectionFailure;

/** Database implementations hydrate this release-scoped row set; policy remains pure and testable. */
export interface CatalogEligibilityQueryAdapter {
  load(input: TrustedNutritionSelectorInput): Promise<TrustedNutritionSelectorRows>;
}

export async function selectTrustedNutrition(
  adapter: CatalogEligibilityQueryAdapter,
  input: TrustedNutritionSelectorInput,
): Promise<TrustedNutritionSelectionResult> {
  return selectTrustedNutritionRows(input, await adapter.load(input));
}

/** Selects one source-backed profile and, for non-gram input, one unambiguous serving conversion. */
export function selectTrustedNutritionRows(
  input: TrustedNutritionSelectorInput,
  rows: TrustedNutritionSelectorRows,
): TrustedNutritionSelectionResult {
  const { catalogRelease, food } = rows;
  if (!catalogRelease || catalogRelease.id !== input.catalogReleaseId || catalogRelease.status !== 'published') {
    return unavailable('CATALOG_RELEASE_NOT_PUBLISHED');
  }
  if (!food || food.id !== input.foodId || !rows.foodMembers.some(
    (member) => member.catalogReleaseId === catalogRelease.id && member.foodId === food.id,
  )) {
    return unavailable('FOOD_NOT_RELEASE_MEMBER');
  }
  if (food.isDeprecated) return unavailable('DEPRECATED_FOOD');

  const profileMembers = new Set(
    rows.profileMembers
      .filter((member) => member.catalogReleaseId === catalogRelease.id)
      .map((member) => member.nutrientProfileId),
  );
  const memberProfiles = rows.profiles.filter((profile) => profileMembers.has(profile.id));
  if (memberProfiles.length === 0) return unavailable('PROFILE_NOT_RELEASE_MEMBER');
  if (memberProfiles.some((profile) => profile.foodId !== food.id)) return unavailable('MISMATCHED_PROFILE');

  const profileCandidates = memberProfiles.map((profile) => assessSource(profile, rows, catalogRelease.id));
  const profileSourceFailure = firstFailure(profileCandidates);
  const trustedProfiles = profileCandidates
    .filter((candidate): candidate is SourceAssessment<NutrientProfileRow> & { source: SourceReleaseRow; catalogSource: CatalogSourceRow } => candidate.reason === null)
    .filter((candidate) => candidate.row.qualityGrade === 'verified' || candidate.row.qualityGrade === 'estimated');
  if (trustedProfiles.length === 0) {
    if (profileSourceFailure) return unavailable(profileSourceFailure);
    return unavailable('UNTRUSTED_PROFILE_QUALITY');
  }
  const nutrientProfiles = trustedProfiles.filter((candidate) => supportedNutrientCount(candidate.row) > 0);
  if (nutrientProfiles.length === 0) return unavailable('NO_SUPPORTED_NUTRIENTS');
  nutrientProfiles.sort(compareProfiles);
  const selectedProfile = nutrientProfiles[0]!;

  if (input.unit === 'g') return selected(food, catalogRelease, selectedProfile, null);

  const servingMembers = new Set(
    rows.servingMembers
      .filter((member) => member.catalogReleaseId === catalogRelease.id)
      .map((member) => member.foodServingId),
  );
  const memberServings = rows.servings.filter((serving) => servingMembers.has(serving.id));
  if (memberServings.length === 0) return unavailable('SERVING_NOT_RELEASE_MEMBER');
  const unitServings = memberServings.filter((serving) => serving.unit === input.unit);
  if (unitServings.length === 0) return unavailable('MISSING_SERVING_CONVERSION');
  if (unitServings.some((serving) => serving.foodId !== food.id)) return unavailable('MISMATCHED_SERVING');

  const servingCandidates = unitServings.map((serving) => assessSource(serving, rows, catalogRelease.id));
  const trustedServings = servingCandidates
    .filter((candidate): candidate is SourceAssessment<FoodServingRow> & { source: SourceReleaseRow; catalogSource: CatalogSourceRow } => candidate.reason === null)
    .filter((candidate) => candidate.row.qualityGrade === 'verified' || candidate.row.qualityGrade === 'estimated');
  if (trustedServings.length === 0) return unavailable('UNTRUSTED_SERVING_SOURCE');
  const bestPriority = Math.min(...trustedServings.map((candidate) => candidate.catalogSource.priority));
  const bestServings = trustedServings.filter((candidate) => candidate.catalogSource.priority === bestPriority);
  if (bestServings.length !== 1) return unavailable('AMBIGUOUS_SERVING_CONVERSION');
  return selected(food, catalogRelease, selectedProfile, bestServings[0]!);
}

type SourceBoundRow = { sourceRegistryId: string; sourceReleaseId: string; datasetVersion?: string };
type SourceAssessment<T extends SourceBoundRow> = {
  row: T;
  source?: SourceReleaseRow;
  catalogSource?: CatalogSourceRow;
  reason: CatalogEligibilityReason | null;
};

function assessSource<T extends SourceBoundRow>(
  row: T,
  rows: TrustedNutritionSelectorRows,
  catalogReleaseId: string,
): SourceAssessment<T> {
  const source = rows.sourceReleases.find((candidate) => candidate.id === row.sourceReleaseId);
  if (!source) return { row, reason: 'SOURCE_RELEASE_NOT_FOUND' };
  if (source.status === 'revoked') return { row, source, reason: 'SOURCE_RELEASE_REVOKED' };
  if (source.status !== 'published') return { row, source, reason: 'SOURCE_RELEASE_NOT_PUBLISHED' };
  if (!isTrustedSourceKind(source.kind)) return { row, source, reason: 'UNTRUSTED_SOURCE_KIND' };
  const catalogSource = rows.catalogSources.find(
    (candidate) => candidate.catalogReleaseId === catalogReleaseId && candidate.sourceReleaseId === source.id,
  );
  if (!catalogSource) return { row, source, reason: 'SOURCE_NOT_APPROVED' };
  if (!catalogSource.allowedArtifactKinds.includes(source.artifactKind)) {
    return { row, source, catalogSource, reason: 'SOURCE_ARTIFACT_NOT_ALLOWED' };
  }
  if (row.sourceRegistryId !== source.sourceRegistryId) {
    return { row, source, catalogSource, reason: 'PROFILE_SOURCE_MISMATCH' };
  }
  if (row.datasetVersion !== undefined && row.datasetVersion !== source.version) {
    return { row, source, catalogSource, reason: 'PROFILE_SOURCE_VERSION_MISMATCH' };
  }
  return { row, source, catalogSource, reason: null };
}

function selected(
  food: NonNullable<TrustedNutritionSelectorRows['food']>,
  catalogRelease: NonNullable<TrustedNutritionSelectorRows['catalogRelease']>,
  profile: SourceAssessment<NutrientProfileRow> & { source: SourceReleaseRow; catalogSource: CatalogSourceRow },
  serving: (SourceAssessment<FoodServingRow> & { source: SourceReleaseRow; catalogSource: CatalogSourceRow }) | null,
): TrustedNutritionSelection {
  return {
    kind: 'selected',
    food: { id: food.id, canonicalNameKo: food.canonicalNameKo },
    profile: profile.row,
    serving: serving?.row ?? null,
    provenance: {
      catalogReleaseId: catalogRelease.id,
      catalogManifestSha256: catalogRelease.manifestSha256,
      sourceReleaseId: profile.source.id,
      sourceReleaseVersion: profile.source.version,
      sourceLicenseSha256: profile.source.licenseSha256,
      sourceArtifactSha256: profile.source.artifactSha256,
      sourceManifestSha256: profile.source.manifestSha256,
      catalogSourcePriority: profile.catalogSource.priority,
      eligibilityManifestSha256: profile.catalogSource.eligibilityManifestSha256,
    },
  };
}

function compareProfiles(
  left: SourceAssessment<NutrientProfileRow> & { source: SourceReleaseRow; catalogSource: CatalogSourceRow },
  right: SourceAssessment<NutrientProfileRow> & { source: SourceReleaseRow; catalogSource: CatalogSourceRow },
) {
  return left.catalogSource.priority - right.catalogSource.priority ||
    qualityRank(left.row.qualityGrade) - qualityRank(right.row.qualityGrade) ||
    supportedNutrientCount(right.row) - supportedNutrientCount(left.row) ||
    compareUtf8(left.row.sourceItemId, right.row.sourceItemId) ||
    compareUtf8(left.row.id, right.row.id);
}

function supportedNutrientCount(profile: NutrientProfileRow) {
  return [profile.energyMillicalories, profile.carbohydrateMg, profile.proteinMg, profile.fatMg, profile.fiberMg]
    .filter((value) => value !== null).length;
}

function qualityRank(quality: EligibleQuality | 'unverified') {
  return quality === 'verified' ? 0 : quality === 'estimated' ? 1 : 2;
}

function isTrustedSourceKind(kind: SourceReleaseRow['kind']): kind is TrustedSourceKind {
  return kind === 'public_dataset' || kind === 'manufacturer' || kind === 'commercial_dataset';
}

function firstFailure<T extends SourceBoundRow>(candidates: SourceAssessment<T>[]): CatalogEligibilityReason | null {
  const order: CatalogEligibilityReason[] = [
    'SOURCE_RELEASE_NOT_FOUND', 'SOURCE_RELEASE_REVOKED', 'SOURCE_RELEASE_NOT_PUBLISHED',
    'UNTRUSTED_SOURCE_KIND', 'SOURCE_NOT_APPROVED', 'SOURCE_ARTIFACT_NOT_ALLOWED',
    'PROFILE_SOURCE_MISMATCH', 'PROFILE_SOURCE_VERSION_MISMATCH',
  ];
  return order.find((reason) => candidates.some((candidate) => candidate.reason === reason)) ?? null;
}

function unavailable(reason: CatalogEligibilityReason): TrustedNutritionSelectionFailure {
  return { kind: 'unavailable', reason };
}

function compareUtf8(left: string, right: string) {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  for (let index = 0; index < Math.min(leftBytes.length, rightBytes.length); index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}
