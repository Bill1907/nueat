export const MEAL_COMPOSITION_POLICY_VERSION = 'meal-composition-v1';
export const MAX_COMPOSITION_LEAVES = 12;

export type CompositionLeaf = {
  id: string;
  foodId: string;
  edibleAmountMg: number;
  ordinal: number;
};

export type FinishedProfileBasis = {
  kind: 'finished_profile';
  foodId: string;
  edibleAmountMg: number;
  profileId: string;
};

export type SourceRecipeBasis = {
  kind: 'source_recipe';
  recipeVersionId: string;
  sourceReleaseId: string;
  yieldMg: number;
  consumedRootAmountMg: number;
  components: readonly CompositionLeaf[];
};

export type DecompositionNode = {
  id: string;
  parentId: string | null;
  kind: 'root' | 'leaf';
  foodId?: string;
  edibleAmountMg?: number;
  ordinal?: number;
};

export type ReviewedMealDecompositionBasis = {
  kind: 'meal_decomposition';
  revisionId: string;
  rootMappingDecisionId: string;
  revision: number;
  expectedDraftRevision: number;
  currentDraftRevision: number;
  nodes: readonly DecompositionNode[];
};

export type MealCompositionInput = {
  finishedProfile?: FinishedProfileBasis;
  sourceRecipe?: SourceRecipeBasis;
  reviewedMealDecomposition?: ReviewedMealDecompositionBasis;
};

export type ValidCompositionBasis =
  | FinishedProfileBasis
  | SourceRecipeBasis
  | (ReviewedMealDecompositionBasis & { components: readonly CompositionLeaf[] });

export type CompositionValidationFailure = {
  kind: 'invalid';
  reason:
    | 'INVALID_FINISHED_PROFILE'
    | 'INVALID_COMPOSITION_IDENTITY'
    | 'INVALID_RECIPE_YIELD'
    | 'INVALID_LEAF_COUNT'
    | 'INVALID_LEAF_ORDER'
    | 'DUPLICATE_COMPONENT'
    | 'STALE_DECOMPOSITION_REVISION'
    | 'MISSING_ROOT'
    | 'MULTIPLE_ROOTS'
    | 'INVALID_TREE_DEPTH'
    | 'COMPOSITION_CYCLE'
    | 'INVALID_LEAF'
    | 'MULTIPLE_COMPOSITION_BASES';
};

export type MealCompositionSelection =
  | { kind: 'selected'; basis: ValidCompositionBasis }
  | CompositionValidationFailure
  | { kind: 'unavailable'; reason: 'NO_COMPOSITION_BASIS' };

/** Selects one authoritative basis; callers must never add parent and component totals. */
export function selectMealComposition(input: MealCompositionInput): MealCompositionSelection {
  if ([input.finishedProfile, input.sourceRecipe, input.reviewedMealDecomposition]
    .filter((basis) => basis !== undefined).length > 1) {
    return invalid('MULTIPLE_COMPOSITION_BASES');
  }
  if (input.finishedProfile) {
    return validFinishedProfile(input.finishedProfile)
      ? { kind: 'selected', basis: input.finishedProfile }
      : invalid('INVALID_FINISHED_PROFILE');
  }
  if (input.sourceRecipe) {
    const sourceRecipe = input.sourceRecipe;
    if (!nonBlank(sourceRecipe.recipeVersionId) || !nonBlank(sourceRecipe.sourceReleaseId))
      return invalid('INVALID_COMPOSITION_IDENTITY');
    const failure = validateLeafComposition(sourceRecipe.components, sourceRecipe.yieldMg);
    if (failure) return failure;
    if (!isPositiveInteger(sourceRecipe.consumedRootAmountMg)) {
      return invalid('INVALID_FINISHED_PROFILE');
    }
    return {
      kind: 'selected',
      basis: {
        ...sourceRecipe,
        components: sourceRecipe.components.map((component) => ({
          ...component,
          edibleAmountMg: positiveHalfUp(
            component.edibleAmountMg,
            sourceRecipe.consumedRootAmountMg,
            sourceRecipe.yieldMg,
          ),
        })),
      },
    };
  }
  if (input.reviewedMealDecomposition) {
    const decomposition = input.reviewedMealDecomposition;
    if (!nonBlank(decomposition.revisionId) || !nonBlank(decomposition.rootMappingDecisionId))
      return invalid('INVALID_COMPOSITION_IDENTITY');
    if (decomposition.revision <= 0 || decomposition.expectedDraftRevision !== decomposition.currentDraftRevision) {
      return invalid('STALE_DECOMPOSITION_REVISION');
    }
    const tree = leavesFromDecomposition(decomposition.nodes);
    if (tree.kind === 'invalid') return tree;
    const failure = validateLeafComposition(tree.components);
    return failure ? failure : { kind: 'selected', basis: { ...decomposition, components: tree.components } };
  }
  return { kind: 'unavailable', reason: 'NO_COMPOSITION_BASIS' };
}

function validFinishedProfile(basis: FinishedProfileBasis): boolean {
  return nonBlank(basis.foodId) && nonBlank(basis.profileId) && isPositiveInteger(basis.edibleAmountMg);
}

function validateLeafComposition(
  components: readonly CompositionLeaf[],
  yieldMg?: number,
): CompositionValidationFailure | null {
  if (yieldMg !== undefined && !isPositiveInteger(yieldMg)) return invalid('INVALID_RECIPE_YIELD');
  if (components.length === 0 || components.length > MAX_COMPOSITION_LEAVES) return invalid('INVALID_LEAF_COUNT');
  const ids = new Set<string>();
  for (let index = 0; index < components.length; index += 1) {
    const component = components[index]!;
    if (component.ordinal !== index) return invalid('INVALID_LEAF_ORDER');
    if (!nonBlank(component.id) || !nonBlank(component.foodId) || !isPositiveInteger(component.edibleAmountMg)) return invalid('INVALID_LEAF');
    if (ids.has(component.id)) return invalid('DUPLICATE_COMPONENT');
    ids.add(component.id);
  }
  return null;
}

function leavesFromDecomposition(nodes: readonly DecompositionNode[]):
  | { kind: 'selected'; components: readonly CompositionLeaf[] }
  | CompositionValidationFailure {
  const roots = nodes.filter((node) => node.kind === 'root');
  if (roots.length === 0) return invalid('MISSING_ROOT');
  if (roots.length !== 1) return invalid('MULTIPLE_ROOTS');
  const root = roots[0]!;
  if (root.parentId !== null || !nonBlank(root.id)) return invalid('INVALID_TREE_DEPTH');
  const byId = new Map<string, DecompositionNode>();
  for (const node of nodes) {
    if (!nonBlank(node.id) || byId.has(node.id)) return invalid('DUPLICATE_COMPONENT');
    byId.set(node.id, node);
  }
  const components: CompositionLeaf[] = [];
  for (const node of nodes) {
    if (node.kind === 'root') continue;
    if (node.parentId === node.id || hasParentCycle(node, byId)) return invalid('COMPOSITION_CYCLE');
    if (node.kind !== 'leaf' || node.parentId !== root.id) return invalid('INVALID_TREE_DEPTH');
    components.push({
      id: node.id,
      foodId: node.foodId ?? '',
      edibleAmountMg: node.edibleAmountMg ?? 0,
      ordinal: node.ordinal ?? -1,
    });
  }
  return { kind: 'selected', components };
}

function hasParentCycle(node: DecompositionNode, byId: ReadonlyMap<string, DecompositionNode>): boolean {
  const visited = new Set<string>([node.id]);
  let parentId = node.parentId;
  while (parentId !== null) {
    if (visited.has(parentId)) return true;
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) return false;
    parentId = parent.parentId;
  }
  return false;
}

function invalid(reason: CompositionValidationFailure['reason']): CompositionValidationFailure {
  return { kind: 'invalid', reason };
}

function nonBlank(value: string): boolean {
  return value.trim().length > 0;
}

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function positiveHalfUp(value: number, multiplier: number, divisor: number): number {
  const rounded = (BigInt(value) * BigInt(multiplier) + BigInt(divisor) / 2n) / BigInt(divisor);
  if (rounded <= 0n || rounded > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('Scaled recipe amount is outside the supported range');
  }
  return Number(rounded);
}
