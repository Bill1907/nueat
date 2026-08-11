CREATE TABLE "recognition_daily_usage" (
	"user_id" text NOT NULL,
	"attempt_date" date NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recognition_daily_usage_user_id_attempt_date_pk" PRIMARY KEY("user_id","attempt_date"),
	CONSTRAINT "recognition_daily_usage_attempt_count_check" CHECK ("recognition_daily_usage"."attempt_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "meal_log" DROP CONSTRAINT "meal_log_recognition_retry_schedule_check";--> statement-breakpoint
ALTER TABLE "recognition_daily_usage" ADD CONSTRAINT "recognition_daily_usage_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_log" ADD CONSTRAINT "meal_log_recognition_retry_schedule_check" CHECK ("meal_log"."recognition_status" <> 'pending'
        or "meal_log"."recognition_next_attempt_at" is not null);