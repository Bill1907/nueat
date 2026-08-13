CREATE TYPE "public"."release_status" AS ENUM('draft', 'published', 'revoked');--> statement-breakpoint
CREATE TABLE "source_identity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"publisher" text NOT NULL,
	"dataset" text NOT NULL,
	"kind" "source_kind" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_identity_publisher_dataset_unique" UNIQUE("publisher","dataset")
);--> statement-breakpoint
CREATE TABLE "source_release" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_identity_id" uuid NOT NULL,
	"source_registry_id" uuid NOT NULL,
	"version" text NOT NULL,
	"status" "release_status" DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"license_reference" text NOT NULL,
	"license_sha256" text NOT NULL,
	"artifact_sha256" text NOT NULL,
	"manifest_sha256" text NOT NULL,
	"artifact_kind" text NOT NULL,
	CONSTRAINT "source_release_identity_version_unique" UNIQUE("source_identity_id","version"),
	CONSTRAINT "source_release_version_check" CHECK (length(trim("source_release"."version")) > 0),
	CONSTRAINT "source_release_hashes_check" CHECK ("source_release"."license_sha256" ~ '^[0-9a-f]{64}$' and "source_release"."artifact_sha256" ~ '^[0-9a-f]{64}$' and "source_release"."manifest_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "source_release_publication_check" CHECK (("source_release"."status" = 'draft' and "source_release"."published_at" is null) or ("source_release"."status" in ('published', 'revoked') and "source_release"."published_at" is not null))
);--> statement-breakpoint
CREATE TABLE "catalog_release" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" text NOT NULL,
	"status" "release_status" DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	"normalizer_version" text NOT NULL,
	"normalizer_sha256" text NOT NULL,
	"taxonomy_sha256" text NOT NULL,
	"manifest_sha256" text NOT NULL,
	"food_member_count" integer NOT NULL,
	"food_alias_member_count" integer NOT NULL,
	"search_document_count" integer NOT NULL,
	"nutrient_profile_member_count" integer NOT NULL,
	"food_serving_member_count" integer NOT NULL,
	"source_release_member_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_release_version_unique" UNIQUE("version"),
	CONSTRAINT "catalog_release_version_check" CHECK (length(trim("catalog_release"."version")) > 0),
	CONSTRAINT "catalog_release_hashes_check" CHECK ("catalog_release"."normalizer_sha256" ~ '^[0-9a-f]{64}$' and "catalog_release"."taxonomy_sha256" ~ '^[0-9a-f]{64}$' and "catalog_release"."manifest_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "catalog_release_counts_check" CHECK ("catalog_release"."food_member_count" >= 0 and "catalog_release"."food_alias_member_count" >= 0 and "catalog_release"."search_document_count" >= 0 and "catalog_release"."nutrient_profile_member_count" >= 0 and "catalog_release"."food_serving_member_count" >= 0 and "catalog_release"."source_release_member_count" >= 0),
	CONSTRAINT "catalog_release_publication_check" CHECK (("catalog_release"."status" = 'draft' and "catalog_release"."published_at" is null) or ("catalog_release"."status" in ('published', 'revoked') and "catalog_release"."published_at" is not null))
);--> statement-breakpoint
CREATE TABLE "catalog_release_source" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"catalog_release_id" uuid NOT NULL,
	"source_release_id" uuid NOT NULL,
	"priority" integer NOT NULL,
	"allowed_artifact_kinds" text[] NOT NULL,
	"eligibility_manifest_sha256" text NOT NULL,
	CONSTRAINT "catalog_release_source_release_unique" UNIQUE("catalog_release_id","source_release_id"),
	CONSTRAINT "catalog_release_source_priority_unique" UNIQUE("catalog_release_id","priority"),
	CONSTRAINT "catalog_release_source_priority_check" CHECK ("catalog_release_source"."priority" >= 100 and "catalog_release_source"."priority" <= 499),
	CONSTRAINT "catalog_release_source_artifact_kinds_check" CHECK (cardinality("catalog_release_source"."allowed_artifact_kinds") > 0),
	CONSTRAINT "catalog_release_source_eligibility_hash_check" CHECK ("catalog_release_source"."eligibility_manifest_sha256" ~ '^[0-9a-f]{64}$')
);--> statement-breakpoint
CREATE TABLE "catalog_release_food" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"catalog_release_id" uuid NOT NULL,
	"food_id" uuid NOT NULL,
	CONSTRAINT "catalog_release_food_unique" UNIQUE("catalog_release_id","food_id")
);--> statement-breakpoint
CREATE TABLE "catalog_release_food_alias" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"catalog_release_id" uuid NOT NULL,
	"food_alias_id" uuid NOT NULL,
	CONSTRAINT "catalog_release_food_alias_unique" UNIQUE("catalog_release_id","food_alias_id")
);--> statement-breakpoint
CREATE TABLE "catalog_release_nutrient_profile" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"catalog_release_id" uuid NOT NULL,
	"nutrient_profile_id" uuid NOT NULL,
	CONSTRAINT "catalog_release_nutrient_profile_unique" UNIQUE("catalog_release_id","nutrient_profile_id")
);--> statement-breakpoint
CREATE TABLE "catalog_release_food_serving" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"catalog_release_id" uuid NOT NULL,
	"food_serving_id" uuid NOT NULL,
	CONSTRAINT "catalog_release_food_serving_unique" UNIQUE("catalog_release_id","food_serving_id")
);--> statement-breakpoint
CREATE TABLE "catalog_release_search_document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"catalog_release_id" uuid NOT NULL,
	"food_id" uuid NOT NULL,
	"source_alias_id" uuid,
	"display_text_ko" text NOT NULL,
	"normalized_spaced" text NOT NULL,
	"normalized_compact" text NOT NULL,
	"ordered_tokens" text[] NOT NULL,
	"ordered_trigrams" text[] NOT NULL,
	"normalizer_version" text NOT NULL,
	"content_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_release_search_document_content_unique" UNIQUE("catalog_release_id","food_id","content_sha256"),
	CONSTRAINT "catalog_release_search_document_compact_check" CHECK (length("catalog_release_search_document"."normalized_compact") > 0),
	CONSTRAINT "catalog_release_search_document_hash_check" CHECK ("catalog_release_search_document"."content_sha256" ~ '^[0-9a-f]{64}$')
);--> statement-breakpoint
CREATE TABLE "release_activation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"catalog_release_id" uuid NOT NULL,
	"policy_version" text NOT NULL,
	"policy_sha256" text NOT NULL,
	"eligibility_manifest_sha256" text NOT NULL,
	"signed_receipt_version" text NOT NULL,
	"signed_receipt_sha256" text NOT NULL,
	"actor_id" text NOT NULL,
	"reason" text NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "release_activation_hashes_check" CHECK ("release_activation"."policy_sha256" ~ '^[0-9a-f]{64}$' and "release_activation"."eligibility_manifest_sha256" ~ '^[0-9a-f]{64}$' and "release_activation"."signed_receipt_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "release_activation_text_check" CHECK (length(trim("release_activation"."policy_version")) > 0 and length(trim("release_activation"."signed_receipt_version")) > 0 and length(trim("release_activation"."actor_id")) > 0 and length(trim("release_activation"."reason")) > 0)
);--> statement-breakpoint
CREATE TABLE "active_catalog_release_pointer" (
	"singleton_id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"activation_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "active_catalog_release_pointer_singleton_check" CHECK ("active_catalog_release_pointer"."singleton_id" = 1)
);--> statement-breakpoint
ALTER TABLE "source_release" ADD CONSTRAINT "source_release_source_identity_id_source_identity_id_fk" FOREIGN KEY ("source_identity_id") REFERENCES "public"."source_identity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_release" ADD CONSTRAINT "source_release_source_registry_id_source_registry_id_fk" FOREIGN KEY ("source_registry_id") REFERENCES "public"."source_registry"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_release_source" ADD CONSTRAINT "catalog_release_source_catalog_release_id_catalog_release_id_fk" FOREIGN KEY ("catalog_release_id") REFERENCES "public"."catalog_release"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_release_source" ADD CONSTRAINT "catalog_release_source_source_release_id_source_release_id_fk" FOREIGN KEY ("source_release_id") REFERENCES "public"."source_release"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_release_food" ADD CONSTRAINT "catalog_release_food_catalog_release_id_catalog_release_id_fk" FOREIGN KEY ("catalog_release_id") REFERENCES "public"."catalog_release"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_release_food" ADD CONSTRAINT "catalog_release_food_food_id_food_id_fk" FOREIGN KEY ("food_id") REFERENCES "public"."food"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_release_food_alias" ADD CONSTRAINT "catalog_release_food_alias_catalog_release_id_catalog_release_id_fk" FOREIGN KEY ("catalog_release_id") REFERENCES "public"."catalog_release"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_release_food_alias" ADD CONSTRAINT "catalog_release_food_alias_food_alias_id_food_alias_id_fk" FOREIGN KEY ("food_alias_id") REFERENCES "public"."food_alias"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_release_nutrient_profile" ADD CONSTRAINT "catalog_release_nutrient_profile_catalog_release_id_catalog_release_id_fk" FOREIGN KEY ("catalog_release_id") REFERENCES "public"."catalog_release"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_release_nutrient_profile" ADD CONSTRAINT "catalog_release_nutrient_profile_nutrient_profile_id_nutrient_profile_id_fk" FOREIGN KEY ("nutrient_profile_id") REFERENCES "public"."nutrient_profile"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_release_food_serving" ADD CONSTRAINT "catalog_release_food_serving_catalog_release_id_catalog_release_id_fk" FOREIGN KEY ("catalog_release_id") REFERENCES "public"."catalog_release"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_release_food_serving" ADD CONSTRAINT "catalog_release_food_serving_food_serving_id_food_serving_id_fk" FOREIGN KEY ("food_serving_id") REFERENCES "public"."food_serving"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_release_search_document" ADD CONSTRAINT "catalog_release_search_document_catalog_release_id_catalog_release_id_fk" FOREIGN KEY ("catalog_release_id") REFERENCES "public"."catalog_release"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_release_search_document" ADD CONSTRAINT "catalog_release_search_document_food_id_food_id_fk" FOREIGN KEY ("food_id") REFERENCES "public"."food"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_release_search_document" ADD CONSTRAINT "catalog_release_search_document_source_alias_id_food_alias_id_fk" FOREIGN KEY ("source_alias_id") REFERENCES "public"."food_alias"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_activation" ADD CONSTRAINT "release_activation_catalog_release_id_catalog_release_id_fk" FOREIGN KEY ("catalog_release_id") REFERENCES "public"."catalog_release"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "active_catalog_release_pointer" ADD CONSTRAINT "active_catalog_release_pointer_activation_id_release_activation_id_fk" FOREIGN KEY ("activation_id") REFERENCES "public"."release_activation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "catalog_release_food_release_idx" ON "catalog_release_food" USING btree ("catalog_release_id");--> statement-breakpoint
CREATE INDEX "catalog_release_search_document_release_idx" ON "catalog_release_search_document" USING btree ("catalog_release_id","id");--> statement-breakpoint
CREATE INDEX "catalog_release_search_document_compact_idx" ON "catalog_release_search_document" USING btree ("catalog_release_id","normalized_compact");--> statement-breakpoint
CREATE INDEX "release_activation_catalog_release_idx" ON "release_activation" USING btree ("catalog_release_id","effective_at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_published_release_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IN ('published', 'revoked') THEN
    RAISE EXCEPTION '% rows are immutable after publication', TG_TABLE_NAME;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_source_identity_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'source identities are immutable';
END;
$$;--> statement-breakpoint
CREATE TRIGGER source_identity_immutable
BEFORE UPDATE OR DELETE ON "source_identity"
FOR EACH ROW EXECUTE FUNCTION reject_source_identity_mutation();--> statement-breakpoint
CREATE TRIGGER source_release_immutable_after_publish
BEFORE UPDATE OR DELETE ON "source_release"
FOR EACH ROW EXECUTE FUNCTION reject_published_release_mutation();--> statement-breakpoint
CREATE TRIGGER catalog_release_immutable_after_publish
BEFORE UPDATE OR DELETE ON "catalog_release"
FOR EACH ROW EXECUTE FUNCTION reject_published_release_mutation();--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_non_draft_catalog_member_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  release_id uuid := COALESCE(NEW.catalog_release_id, OLD.catalog_release_id);
  release_status "release_status";
BEGIN
  SELECT status INTO release_status FROM catalog_release WHERE id = release_id;
  IF release_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'catalog release members are immutable outside a draft release';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;--> statement-breakpoint
CREATE TRIGGER catalog_release_source_immutable
BEFORE INSERT OR UPDATE OR DELETE ON "catalog_release_source"
FOR EACH ROW EXECUTE FUNCTION reject_non_draft_catalog_member_mutation();--> statement-breakpoint
CREATE TRIGGER catalog_release_food_immutable
BEFORE INSERT OR UPDATE OR DELETE ON "catalog_release_food"
FOR EACH ROW EXECUTE FUNCTION reject_non_draft_catalog_member_mutation();--> statement-breakpoint
CREATE TRIGGER catalog_release_food_alias_immutable
BEFORE INSERT OR UPDATE OR DELETE ON "catalog_release_food_alias"
FOR EACH ROW EXECUTE FUNCTION reject_non_draft_catalog_member_mutation();--> statement-breakpoint
CREATE TRIGGER catalog_release_nutrient_profile_immutable
BEFORE INSERT OR UPDATE OR DELETE ON "catalog_release_nutrient_profile"
FOR EACH ROW EXECUTE FUNCTION reject_non_draft_catalog_member_mutation();--> statement-breakpoint
CREATE TRIGGER catalog_release_food_serving_immutable
BEFORE INSERT OR UPDATE OR DELETE ON "catalog_release_food_serving"
FOR EACH ROW EXECUTE FUNCTION reject_non_draft_catalog_member_mutation();--> statement-breakpoint
CREATE TRIGGER catalog_release_search_document_immutable
BEFORE INSERT OR UPDATE OR DELETE ON "catalog_release_search_document"
FOR EACH ROW EXECUTE FUNCTION reject_non_draft_catalog_member_mutation();--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_release_activation_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'release activations are append-only';
END;
$$;--> statement-breakpoint
CREATE TRIGGER release_activation_append_only
BEFORE UPDATE OR DELETE ON "release_activation"
FOR EACH ROW EXECUTE FUNCTION reject_release_activation_mutation();--> statement-breakpoint
CREATE OR REPLACE FUNCTION activate_catalog_release(
  requested_activation_id uuid,
  expected_manifest_sha256 text
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  selected_release_id uuid;
  selected_manifest_sha256 text;
  selected_status "release_status";
  selected_effective_at timestamp with time zone;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('nueat.active_catalog_release_pointer'));

  SELECT activation.catalog_release_id, release.manifest_sha256, release.status, activation.effective_at
  INTO selected_release_id, selected_manifest_sha256, selected_status, selected_effective_at
  FROM release_activation AS activation
  JOIN catalog_release AS release ON release.id = activation.catalog_release_id
  WHERE activation.id = requested_activation_id;

  IF NOT FOUND OR selected_status <> 'published' OR selected_effective_at > now()
    OR selected_manifest_sha256 <> expected_manifest_sha256 THEN
    RAISE EXCEPTION 'release activation is not publishable';
  END IF;

  IF (SELECT count(*) FROM catalog_release_food WHERE catalog_release_id = selected_release_id) <>
       (SELECT food_member_count FROM catalog_release WHERE id = selected_release_id)
    OR (SELECT count(*) FROM catalog_release_food_alias WHERE catalog_release_id = selected_release_id) <>
       (SELECT food_alias_member_count FROM catalog_release WHERE id = selected_release_id)
    OR (SELECT count(*) FROM catalog_release_search_document WHERE catalog_release_id = selected_release_id) <>
       (SELECT search_document_count FROM catalog_release WHERE id = selected_release_id)
    OR (SELECT count(*) FROM catalog_release_nutrient_profile WHERE catalog_release_id = selected_release_id) <>
       (SELECT nutrient_profile_member_count FROM catalog_release WHERE id = selected_release_id)
    OR (SELECT count(*) FROM catalog_release_food_serving WHERE catalog_release_id = selected_release_id) <>
       (SELECT food_serving_member_count FROM catalog_release WHERE id = selected_release_id)
    OR (SELECT count(*) FROM catalog_release_source WHERE catalog_release_id = selected_release_id) <>
       (SELECT source_release_member_count FROM catalog_release WHERE id = selected_release_id)
    OR EXISTS (
      SELECT 1
      FROM catalog_release_source AS member
      JOIN source_release AS release ON release.id = member.source_release_id
      WHERE member.catalog_release_id = selected_release_id AND release.status <> 'published'
    )
    OR EXISTS (
      SELECT 1
      FROM catalog_release_search_document AS document
      LEFT JOIN catalog_release_food AS member
        ON member.catalog_release_id = document.catalog_release_id
       AND member.food_id = document.food_id
      WHERE document.catalog_release_id = selected_release_id AND member.id IS NULL
    )
    OR EXISTS (
      SELECT 1
      FROM catalog_release_search_document AS document
      LEFT JOIN catalog_release_food_alias AS member
        ON member.catalog_release_id = document.catalog_release_id
       AND member.food_alias_id = document.source_alias_id
      WHERE document.catalog_release_id = selected_release_id
        AND document.source_alias_id IS NOT NULL
        AND member.id IS NULL
    ) THEN
    RAISE EXCEPTION 'catalog release membership manifest does not match';
  END IF;

  INSERT INTO active_catalog_release_pointer (singleton_id, activation_id, updated_at)
  VALUES (1, requested_activation_id, now())
  ON CONFLICT (singleton_id) DO UPDATE
    SET activation_id = EXCLUDED.activation_id, updated_at = EXCLUDED.updated_at;
END;
$$;
