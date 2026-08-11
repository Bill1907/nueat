CREATE TABLE "recommendation_meal_draft" (
	"recommendation_id" uuid PRIMARY KEY NOT NULL,
	"meal_log_id" uuid NOT NULL,
	"candidate_rank" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recommendation_meal_draft_meal_log_id_unique" UNIQUE("meal_log_id"),
	CONSTRAINT "recommendation_meal_draft_candidate_rank_check" CHECK ("recommendation_meal_draft"."candidate_rank" between 1 and 3)
);
--> statement-breakpoint
ALTER TABLE "recommendation_meal_draft" ADD CONSTRAINT "recommendation_meal_draft_recommendation_id_recommendation_id_fk" FOREIGN KEY ("recommendation_id") REFERENCES "public"."recommendation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation_meal_draft" ADD CONSTRAINT "recommendation_meal_draft_meal_log_id_meal_log_id_fk" FOREIGN KEY ("meal_log_id") REFERENCES "public"."meal_log"("id") ON DELETE restrict ON UPDATE no action;