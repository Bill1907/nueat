ALTER TABLE "meal_log" DROP CONSTRAINT "meal_log_recognition_manual_override_check";--> statement-breakpoint
ALTER TABLE "meal_log" ADD CONSTRAINT "meal_log_recognition_manual_override_check" CHECK ("meal_log"."recognition_manual_override" is null
        or ("meal_log"."recognition_status" = 'manual'
        and "meal_log"."recognition_manual_override"->>'fromStatus' in ('ready', 'pending', 'processing', 'failed')
        and "meal_log"."recognition_manual_override"->>'decision' = 'direct_entry'
        and "meal_log"."recognition_manual_override"->>'decisionVersion' = 'recognition-manual-override-v1'
        and "meal_log"."recognition_manual_override" ? 'actorUserId'
        and jsonb_typeof("meal_log"."recognition_manual_override"->'expectedDraftRevision') = 'number'
        and jsonb_typeof("meal_log"."recognition_manual_override"->'changedFields') = 'array'
        and "meal_log"."recognition_manual_override" ? 'decidedAt'
        and ("meal_log"."recognition_manual_override"->>'fromStatus' <> 'ready'
          or ("meal_log"."recognition_result" is not null
            and "meal_log"."recognition_result"->>'outcome' in ('no_food', 'insufficient_evidence')
            and "meal_log"."recognition_manual_override"->>'fromOutcome' = "meal_log"."recognition_result"->>'outcome'))));