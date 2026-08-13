import { createHash } from 'node:crypto';

export const MEAL_ITEM_REVIEW_FINGERPRINT_VERSION = 'meal-item-review-fingerprint-v1';

type NullableString = string | null;

export interface MealItemAuthorityFingerprintInput {
  itemId: string;
  itemRevision: number;
  foodId: string;
  nutrientProfileId: NullableString;
  amountMilliunits: number;
  unit: 'g' | 'ml' | 'serving' | 'bowl' | 'piece';
  gramsMg: number;
  catalogReleaseId: string;
  catalogActivationId: string;
  mappingMethod: 'exact' | 'lexical' | 'user_selected' | 'manual';
  mappingDecisionId: NullableString;
  mappingContentSha256: NullableString;
  sourceRegistryId: NullableString;
  sourceReleaseId: NullableString;
  servingId: NullableString;
  calculationPreviewId: NullableString;
  calculationPreviewSha256: NullableString;
  mealDecompositionRevisionId: NullableString;
  mealDecompositionSha256: NullableString;
  calculationVersion: string;
}

export interface ReviewRequestFingerprintInput {
  mealId: string;
  itemId: string;
  idempotencyKey: string;
  expectedDraftRevision: number;
  expectedItemRevision: number;
  displayedAuthorityFingerprintVersion: string;
  displayedAuthorityFingerprint: string;
}

const AUTHORITY_KEYS = [
  'amountMilliunits',
  'calculationPreviewId',
  'calculationPreviewSha256',
  'calculationVersion',
  'catalogActivationId',
  'catalogReleaseId',
  'foodId',
  'gramsMg',
  'itemId',
  'itemRevision',
  'mappingContentSha256',
  'mappingDecisionId',
  'mappingMethod',
  'mealDecompositionRevisionId',
  'mealDecompositionSha256',
  'nutrientProfileId',
  'servingId',
  'sourceRegistryId',
  'sourceReleaseId',
  'unit',
] as const;
const REQUEST_KEYS = [
  'displayedAuthorityFingerprint',
  'displayedAuthorityFingerprintVersion',
  'expectedDraftRevision',
  'expectedItemRevision',
  'idempotencyKey',
  'itemId',
  'mealId',
] as const;
const SHA256 = /^[a-f0-9]{64}$/;

export function canonicalMealItemAuthorityBytes(input: MealItemAuthorityFingerprintInput): Uint8Array {
  validateAuthority(input);
  return canonicalBytes(MEAL_ITEM_REVIEW_FINGERPRINT_VERSION, input);
}

export function mealItemReviewFingerprint(input: MealItemAuthorityFingerprintInput): string {
  return sha256(canonicalMealItemAuthorityBytes(input));
}

export function canonicalReviewRequestBytes(input: ReviewRequestFingerprintInput): Uint8Array {
  validateRequest(input);
  return canonicalBytes(`${MEAL_ITEM_REVIEW_FINGERPRINT_VERSION}:review-request`, input);
}

export function reviewRequestFingerprint(input: ReviewRequestFingerprintInput): string {
  return sha256(canonicalReviewRequestBytes(input));
}

function canonicalBytes(domain: string, value: object): Uint8Array {
  return new TextEncoder().encode(`${domain}\n${canonicalJson(value)}`);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function validateAuthority(input: MealItemAuthorityFingerprintInput): void {
  assertExactKeys(input, AUTHORITY_KEYS);
  assertNonBlank(input.itemId, 'itemId');
  assertPositiveInteger(input.itemRevision, 'itemRevision');
  assertNonBlank(input.foodId, 'foodId');
  assertNullableString(input.nutrientProfileId, 'nutrientProfileId');
  assertNonNegativeInteger(input.amountMilliunits, 'amountMilliunits');
  assertEnum(input.unit, ['g', 'ml', 'serving', 'bowl', 'piece'], 'unit');
  assertNonNegativeInteger(input.gramsMg, 'gramsMg');
  assertNonBlank(input.catalogReleaseId, 'catalogReleaseId');
  assertNonBlank(input.catalogActivationId, 'catalogActivationId');
  assertEnum(input.mappingMethod, ['exact', 'lexical', 'user_selected', 'manual'], 'mappingMethod');
  assertNullableString(input.mappingDecisionId, 'mappingDecisionId');
  assertNullableHash(input.mappingContentSha256, 'mappingContentSha256');
  assertNullableString(input.sourceRegistryId, 'sourceRegistryId');
  assertNullableString(input.sourceReleaseId, 'sourceReleaseId');
  assertNullableString(input.servingId, 'servingId');
  assertNullableString(input.calculationPreviewId, 'calculationPreviewId');
  assertNullableHash(input.calculationPreviewSha256, 'calculationPreviewSha256');
  assertNullableString(input.mealDecompositionRevisionId, 'mealDecompositionRevisionId');
  assertNullableHash(input.mealDecompositionSha256, 'mealDecompositionSha256');
  assertNonBlank(input.calculationVersion, 'calculationVersion');
}

function validateRequest(input: ReviewRequestFingerprintInput): void {
  assertExactKeys(input, REQUEST_KEYS);
  assertNonBlank(input.mealId, 'mealId');
  assertNonBlank(input.itemId, 'itemId');
  assertNonBlank(input.idempotencyKey, 'idempotencyKey');
  assertNonNegativeInteger(input.expectedDraftRevision, 'expectedDraftRevision');
  assertPositiveInteger(input.expectedItemRevision, 'expectedItemRevision');
  assertNonBlank(input.displayedAuthorityFingerprintVersion, 'displayedAuthorityFingerprintVersion');
  assertHash(input.displayedAuthorityFingerprint, 'displayedAuthorityFingerprint');
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value.normalize('NFC'));
  if (typeof value === 'number') {
    assertSafeInteger(value, 'canonical number');
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!isPlainObject(value)) throw new TypeError('Canonical values must be plain JSON objects');
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key.normalize('NFC'))}:${canonicalJson(value[key])}`).join(',')}}`;
}

function assertExactKeys(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) throw new TypeError('Fingerprint input must be a plain object');
  const actual = Object.keys(value).sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new TypeError('Fingerprint input has an invalid shape');
  }
}

function assertNonBlank(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${field} must be a non-blank string`);
}

function assertNullableString(value: unknown, field: string): asserts value is NullableString {
  if (value !== null && typeof value !== 'string') throw new TypeError(`${field} must be a string or null`);
}

function assertHash(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new TypeError(`${field} must be a lowercase SHA-256 hash`);
}

function assertNullableHash(value: unknown, field: string): asserts value is NullableString {
  if (value !== null) assertHash(value, field);
}

function assertPositiveInteger(value: unknown, field: string): void {
  assertSafeInteger(value, field);
  if (value <= 0) throw new RangeError(`${field} must be positive`);
}

function assertNonNegativeInteger(value: unknown, field: string): void {
  assertSafeInteger(value, field);
  if (value < 0) throw new RangeError(`${field} must not be negative`);
}

function assertSafeInteger(value: unknown, field: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new TypeError(`${field} must be a safe integer`);
}

function assertEnum(value: unknown, values: readonly string[], field: string): void {
  if (typeof value !== 'string' || !values.includes(value)) throw new TypeError(`${field} has an invalid value`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}
