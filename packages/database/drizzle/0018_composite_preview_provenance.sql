ALTER TABLE "calculation_preview"
  ADD CONSTRAINT "calculation_preview_discriminated_identity_check"
  CHECK (
    jsonb_typeof("identity") = 'object'
    AND "identity" ? 'basis'
    AND "identity" ? 'rootMappingDecisionId'
    AND "identity" ? 'rootRevision'
    AND "identity" ? 'catalogReleaseId'
    AND "identity" ? 'releaseActivationId'
    AND "identity" ? 'leaves'
    AND jsonb_typeof("identity"->'leaves') = 'array'
    AND jsonb_array_length("identity"->'leaves') > 0
    AND (
      ("discriminant" = 'finished_profile' AND "identity"->>'basis' = 'finished_profile' AND jsonb_array_length("identity"->'leaves') = 1)
      OR ("discriminant" = 'source_recipe' AND "identity"->>'basis' = 'source_recipe' AND "identity" ? 'recipeVersionId')
      OR ("discriminant" = 'meal_decomposition' AND "identity"->>'basis' = 'meal_decomposition' AND "identity" ? 'decompositionRevisionId')
    )
  ) NOT VALID;
