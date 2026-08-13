import { describe, expect, test } from 'bun:test';

import {
  MAX_COMPOSITION_LEAVES,
  type DecompositionNode,
  selectMealComposition,
} from './meal-composition';

const leaf = (id: string, ordinal: number) => ({ id, foodId: `food-${id}`, edibleAmountMg: 10_000, ordinal });
const root = { id: 'root', parentId: null, kind: 'root' as const };

function decomposition(nodes: readonly DecompositionNode[]) {
  return { reviewedMealDecomposition: {
    kind: 'meal_decomposition' as const, revisionId: 'revision-1', rootMappingDecisionId: 'decision-1',
    revision: 1, expectedDraftRevision: 3, currentDraftRevision: 3, nodes,
  } };
}

describe('meal composition policy', () => {
  test('rejects parent and component bases instead of silently double counting', () => {
    expect(selectMealComposition({
      finishedProfile: { kind: 'finished_profile', foodId: 'dish', profileId: 'profile', edibleAmountMg: 100_000 },
      sourceRecipe: { kind: 'source_recipe', recipeVersionId: 'recipe', sourceReleaseId: 'source', yieldMg: 100_000, consumedRootAmountMg: 100_000, components: [leaf('a', 0)] },
    })).toEqual({ kind: 'invalid', reason: 'MULTIPLE_COMPOSITION_BASES' });
  });

  test('fails closed for stale revisions and malformed recipe yields', () => {
    expect(selectMealComposition(decomposition([root, { ...leaf('a', 0), parentId: 'root', kind: 'leaf' }]))).toMatchObject({ kind: 'selected' });
    expect(selectMealComposition({ reviewedMealDecomposition: { ...decomposition([root, { ...leaf('a', 0), parentId: 'root', kind: 'leaf' }]).reviewedMealDecomposition, currentDraftRevision: 4 } })).toEqual({ kind: 'invalid', reason: 'STALE_DECOMPOSITION_REVISION' });
    expect(selectMealComposition({ sourceRecipe: { kind: 'source_recipe', recipeVersionId: 'recipe', sourceReleaseId: 'source', yieldMg: 0, consumedRootAmountMg: 1, components: [leaf('a', 0)] } })).toEqual({ kind: 'invalid', reason: 'INVALID_RECIPE_YIELD' });
  });

  test('scales source recipe leaves by consumed root amount using positive half-up rounding', () => {
    const result = selectMealComposition({
      sourceRecipe: {
        kind: 'source_recipe',
        recipeVersionId: 'recipe',
        sourceReleaseId: 'source',
        yieldMg: 3,
        consumedRootAmountMg: 1,
        components: [{ id: 'a', foodId: 'food-a', edibleAmountMg: 2, ordinal: 0 }],
      },
    });
    expect(result).toMatchObject({
      kind: 'selected',
      basis: { kind: 'source_recipe', components: [{ edibleAmountMg: 1 }] },
    });
  });


  test('rejects cycles, depth, duplicate nodes, and more than twelve leaves', () => {
    expect(selectMealComposition(decomposition([{ ...root, parentId: 'root' }]))).toEqual({ kind: 'invalid', reason: 'INVALID_TREE_DEPTH' });
    expect(selectMealComposition(decomposition([root, { ...leaf('a', 0), parentId: 'a', kind: 'leaf' }]))).toEqual({ kind: 'invalid', reason: 'COMPOSITION_CYCLE' });
    expect(selectMealComposition(decomposition([root, { ...leaf('a', 0), parentId: 'child', kind: 'leaf' }, { ...leaf('child', 1), parentId: 'root', kind: 'leaf' }]))).toEqual({ kind: 'invalid', reason: 'INVALID_TREE_DEPTH' });
    expect(selectMealComposition(decomposition([root, { ...leaf('a', 0), parentId: 'root', kind: 'leaf' }, { ...leaf('a', 1), parentId: 'root', kind: 'leaf' }]))).toEqual({ kind: 'invalid', reason: 'DUPLICATE_COMPONENT' });
    expect(selectMealComposition({ sourceRecipe: { kind: 'source_recipe', recipeVersionId: 'recipe', sourceReleaseId: 'source', yieldMg: 10_000, consumedRootAmountMg: 10_000, components: Array.from({ length: MAX_COMPOSITION_LEAVES + 1 }, (_, i) => leaf(String(i), i)) } })).toEqual({ kind: 'invalid', reason: 'INVALID_LEAF_COUNT' });
  });
});
