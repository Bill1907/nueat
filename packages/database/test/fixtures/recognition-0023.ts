export const recognition0023Fixture = {
  userId: '00000000-0000-4000-8000-000000002301',
  imageAssetId: '00000000-0000-4000-8000-000000002302',
  mealLogId: '00000000-0000-4000-8000-000000002303',
} as const;

/** Minimal rows that are valid immediately after migration 0023. */
export const recognition0023FixtureSql = `
INSERT INTO "user" ("id", "name", "email", "email_verified", "created_at", "updated_at")
VALUES ('${recognition0023Fixture.userId}', 'fixture', 'fixture@example.invalid', false, now(), now());
INSERT INTO "image_asset" (
  "id", "user_id", "purpose", "status", "object_key", "declared_content_type",
  "detected_content_type", "byte_size", "width", "height", "sha256", "expires_at"
) VALUES (
  '${recognition0023Fixture.imageAssetId}', '${recognition0023Fixture.userId}',
  'inference', 'processed', 'fixture/not-a-production-key', 'image/jpeg',
  'image/jpeg', 4, 1, 1, repeat('a', 64), now() + interval '1 hour'
);
INSERT INTO "meal_log" (
  "id", "user_id", "image_asset_id", "eaten_at", "timezone", "local_date",
  "meal_type", "status", "recognition_status", "draft_revision"
) VALUES (
  '${recognition0023Fixture.mealLogId}', '${recognition0023Fixture.userId}',
  '${recognition0023Fixture.imageAssetId}', now(), 'Asia/Seoul', current_date,
  'lunch', 'draft', 'manual', 1
);
`;
