ALTER TABLE "image_asset" ADD COLUMN "pixel_width" integer;--> statement-breakpoint
ALTER TABLE "image_asset" ADD COLUMN "pixel_height" integer;--> statement-breakpoint
ALTER TABLE "image_asset" ADD CONSTRAINT "image_asset_dimensions_check" CHECK (("image_asset"."pixel_width" is null and "image_asset"."pixel_height" is null)
        or ("image_asset"."pixel_width" > 0 and "image_asset"."pixel_height" > 0));