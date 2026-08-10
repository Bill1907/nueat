import { Image } from 'expo-image';
import { useEffect, useRef, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import {
  addMealDraftItem,
  deleteMealDraftItem,
  getMealDraft,
  getMealImageDownloadIntent,
  mapMealDraftItemFood,
  type MealDraftItem,
  type MealDraftResponse,
  type MealUnit,
  updateMealDraftItem,
} from '@/api/meal-drafts';
import { searchFoods, type CanonicalFood } from '@/api/foods';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { decimalToMilliunits, mealUnitLabel } from '@/meals/meal-draft-policy';
import {
  isFoodMappingCurrent,
  normalizeKoreanFoodLabel,
} from '@/meals/food-selection-policy';

const units: MealUnit[] = ['g', 'ml', 'serving', 'bowl', 'piece'];

type ItemForm = {
  recognizedLabel: string;
  amount: string;
  unit: MealUnit;
};
type FoodSearchState =
  | { status: 'idle' | 'loading' | 'empty'; foods: CanonicalFood[] }
  | { status: 'error'; foods: CanonicalFood[]; message: string };

export function MealConfirmationModal({
  mealLogId,
  visible,
  onClose,
}: {
  mealLogId: string | null;
  visible: boolean;
  onClose: () => void;
}) {
  const [data, setData] = useState<MealDraftResponse | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [forms, setForms] = useState<Record<string, ItemForm>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadedMealLogId, setLoadedMealLogId] = useState<string | null>(null);
  const [savingItemId, setSavingItemId] = useState<string | null>(null);

  const [foodSearchItemId, setFoodSearchItemId] = useState<string | null>(null);
  const [foodQuery, setFoodQuery] = useState('');
  const [foodSearchState, setFoodSearchState] = useState<FoodSearchState>({
    status: 'idle',
    foods: [],
  });
  const [mappedFoods, setMappedFoods] = useState<Record<string, CanonicalFood>>(
    {},
  );
  const [invalidatedMappings, setInvalidatedMappings] = useState<Set<string>>(
    new Set(),
  );
  const foodSearchRequest = useRef(0);
  useEffect(() => {
    if (!visible || !mealLogId) return;
    let active = true;

    void (async () => {
      try {
        const mealDraft = await getMealDraft(mealLogId);
        if (!active) return;
        setLoadedMealLogId(mealLogId);
        setLoadError(null);
        setImageUrl(null);
        setData(mealDraft);
        setForms(formsFromItems(mealDraft.items));
        setMappedFoods({});
        setInvalidatedMappings(new Set());
        void loadMappedFoods(mealDraft.items).then((foods) => {
          if (active) setMappedFoods(foods);
        });

        const intent = await getMealImageDownloadIntent(
          mealDraft.mealLog.imageAssetId,
        );
        if (active) setImageUrl(intent.downloadUrl);
      } catch (cause) {
        if (active) setLoadedMealLogId(mealLogId);
        if (active) setLoadError(errorMessage(cause));
      }
    })();
    return () => {
      active = false;
    };
  }, [mealLogId, visible]);
  async function runFoodSearch() {
    const query = normalizeKoreanFoodLabel(foodQuery);
    if (!foodSearchItemId) return;
    if (!query) {
      setFoodSearchState({ status: 'empty', foods: [] });
      return;
    }

    const requestId = ++foodSearchRequest.current;
    setFoodSearchState({ status: 'loading', foods: [] });
    try {
      const { foods } = await searchFoods(query);
      if (requestId !== foodSearchRequest.current) return;
      setFoodSearchState({
        status: foods.length === 0 ? 'empty' : 'idle',
        foods,
      });
    } catch (cause) {
      if (requestId !== foodSearchRequest.current) return;
      setFoodSearchState({
        status: 'error',
        foods: [],
        message: errorMessage(cause),
      });
    }
  }

  function applyResponse(response: MealDraftResponse) {
    setData(response);
    setLoadedMealLogId(response.mealLog.id);
    setForms(formsFromItems(response.items));
    setMappedFoods((current) =>
      Object.fromEntries(
        response.items.flatMap((item) => {
          const food = current[item.id];
          return item.foodId === food?.id ? [[item.id, food]] : [];
        }),
      ),
    );
  }

  function updateRecognizedLabel(item: MealDraftItem, recognizedLabel: string) {
    updateForm(item.id, { recognizedLabel });
    if (!item.foodId) return;

    const food = mappedFoods[item.id];
    setInvalidatedMappings((current) => {
      const next = new Set(current);
      if (isFoodMappingCurrent(recognizedLabel, food ?? null)) {
        next.delete(item.id);
      } else {
        next.add(item.id);
      }
      return next;
    });
  }

  async function selectFood(item: MealDraftItem, food: CanonicalFood) {
    if (!mealLogId) return;
    setSavingItemId(item.id);
    setLoadError(null);
    try {
      const response = await mapMealDraftItemFood(mealLogId, item.id, food.id);
      setMappedFoods((current) => ({ ...current, [item.id]: food }));
      setInvalidatedMappings((current) => {
        const next = new Set(current);
        next.delete(item.id);
        return next;
      });
      applyResponse(response);
      setForms((current) => ({
        ...current,
        [item.id]: {
          ...current[item.id],
          recognizedLabel: food.canonicalNameKo,
        },
      }));
      setFoodSearchItemId(null);
      setFoodQuery('');
    } catch (cause) {
      setLoadError(errorMessage(cause));
    } finally {
      setSavingItemId(null);
    }
  }


  function updateForm(itemId: string, update: Partial<ItemForm>) {
    setForms((current) => ({
      ...current,
      [itemId]: { ...current[itemId], ...update },
    }));
  }

  async function saveItem(item: MealDraftItem) {
    if (!mealLogId) return;
    const form = forms[item.id];
    const amountMilliunits = decimalToMilliunits(form.amount);
    if (!form.recognizedLabel.trim()) {
      setLoadError('음식 이름을 입력해 주세요.');
      return;
    }
    if (!amountMilliunits) {
      setLoadError('양은 0보다 큰 숫자로 입력해 주세요.');
      return;
    }

    setSavingItemId(item.id);
    setLoadError(null);
    try {
      const recognizedLabel = form.recognizedLabel.trim();
      applyResponse(
        await updateMealDraftItem(mealLogId, item.id, {
          ...(recognizedLabel === item.recognizedLabel ? {} : { recognizedLabel }),
          amountMilliunits,
          unit: form.unit,
        }),
      );
    } catch (cause) {
      setLoadError(errorMessage(cause));
    } finally {
      setSavingItemId(null);
    }
  }

  async function removeItem(itemId: string) {
    if (!mealLogId) return;
    setSavingItemId(itemId);
    setLoadError(null);
    try {
      applyResponse(await deleteMealDraftItem(mealLogId, itemId));
    } catch (cause) {
      setLoadError(errorMessage(cause));
    } finally {
      setSavingItemId(null);
    }
  }

  async function addManualItem() {
    if (!mealLogId) return;
    setSavingItemId('new');
    setLoadError(null);
    try {
      applyResponse(
        await addMealDraftItem(mealLogId, {
          recognizedLabel: '직접 입력',
          amountMilliunits: 1000,
          unit: 'serving',
        }),
      );
    } catch (cause) {
      setLoadError(errorMessage(cause));
    } finally {
      setSavingItemId(null);
    }
  }
  const currentData = loadedMealLogId === mealLogId ? data : null;
  const currentError = loadedMealLogId === mealLogId ? loadError : null;

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="pageSheet"
      visible={visible}
    >
      <ThemedView type="background" style={styles.screen}>
        <View style={styles.header}>
          <View style={styles.headerCopy}>
            <ThemedText type="subtitle">음식 확인</ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              저장된 초안은 섭취 또는 영양 기록으로 확정되지 않아요.
            </ThemedText>
          </View>
          <ModalButton label="닫기" onPress={onClose} secondary />
        </View>

        {currentError && (
          <ThemedText
            accessibilityRole="alert"
            type="small"
            style={styles.errorText}
          >
            {currentError}
          </ThemedText>
        )}
        {!currentData && !currentError && (
          <ThemedText type="small" themeColor="textSecondary">
            사진과 인식 결과를 불러오고 있어요.
          </ThemedText>
        )}
        {currentData && (
          <ScrollView contentContainerStyle={styles.content}>
            {imageUrl && (
              <Image
                accessibilityLabel="업로드한 식사 사진"
                contentFit="cover"
                source={{ uri: imageUrl }}
                style={styles.image}
              />
            )}
            <View style={styles.recognition}>
              <ThemedText type="smallBold">인식 결과</ThemedText>
              <ThemedText type="small" themeColor="textSecondary">
                상태: {currentData.mealLog.recognitionStatus} · 엔진:{' '}
                {currentData.mealLog.recognitionEngineVersion}
              </ThemedText>
            </View>
            {currentData.items.map((item) => {
              const form = forms[item.id];
              if (!form) return null;
              const saving = savingItemId === item.id;
              const mappedFood = mappedFoods[item.id];
              const mappingNeedsReconnect =
                item.foodId !== null &&
                (invalidatedMappings.has(item.id) ||
                  (mappedFood !== undefined &&
                    !isFoodMappingCurrent(form.recognizedLabel, mappedFood)));
              const searchOpen = foodSearchItemId === item.id;
              return (
                <View key={item.id} style={styles.itemCard}>
                  <ThemedText type="smallBold">음식</ThemedText>
                  <TextInput
                    accessibilityLabel="음식 이름"
                    editable={!saving}
                    onChangeText={(recognizedLabel) =>
                      updateRecognizedLabel(item, recognizedLabel)
                    }
                    style={styles.input}
                    value={form.recognizedLabel}
                  />
                  {item.foodId && !mappingNeedsReconnect && (
                    <ThemedText type="small" style={styles.mappingConnected}>
                      공식 DB 연결
                      {mappedFood
                        ? ` · ${mappedFood.nutrientProfile.sourceDisplayName} · ${mappedFood.nutrientProfile.datasetVersion}`
                        : ' · 출처 정보 확인 중'}
                    </ThemedText>
                  )}
                  {mappingNeedsReconnect && (
                    <ThemedText
                      accessibilityRole="alert"
                      type="smallBold"
                      style={styles.mappingInvalid}
                    >
                      다시 연결 필요
                    </ThemedText>
                  )}
                  <ModalButton
                    disabled={saving}
                    label={searchOpen ? '음식 검색 닫기' : '한국 음식 DB 검색'}
                    onPress={() => {
                      if (searchOpen) {
                        setFoodSearchItemId(null);
                        foodSearchRequest.current += 1;
                        setFoodSearchState({ status: 'idle', foods: [] });
                        setFoodQuery('');
                      } else {
                        setFoodSearchItemId(item.id);
                        setFoodSearchState({ status: 'idle', foods: [] });
                        setFoodQuery(form.recognizedLabel);
                      }
                    }}
                    secondary
                  />
                  {searchOpen && (
                    <View style={styles.foodSearch}>
                      <TextInput
                        accessibilityLabel="한국 음식 DB 검색어"
                        autoFocus
                        editable={!saving}
                        onChangeText={setFoodQuery}
                        placeholder="음식 이름을 입력해 주세요"
                        style={styles.input}
                        value={foodQuery}
                      />
                      <ModalButton
                        disabled={saving || foodSearchState.status === 'loading'}
                        label="공식 DB 검색 실행"
                        onPress={() => void runFoodSearch()}
                        secondary
                      />
                      {foodSearchState.status === 'loading' && (
                        <ThemedText type="small" themeColor="textSecondary">
                          공식 음식 DB를 검색하고 있어요.
                        </ThemedText>
                      )}
                      {foodSearchState.status === 'empty' && (
                        <ThemedText type="small" themeColor="textSecondary">
                          검색 결과가 없어요.
                        </ThemedText>
                      )}
                      {foodSearchState.status === 'error' && (
                        <ThemedText
                          accessibilityRole="alert"
                          type="small"
                          style={styles.errorText}
                        >
                          {foodSearchState.message}
                        </ThemedText>
                      )}
                      {foodSearchState.foods.map((food) => (
                        <Pressable
                          key={food.id}
                          accessibilityLabel={[
                            food.canonicalNameKo,
                            food.category,
                            food.nutrientProfile.sourceDisplayName,
                            food.nutrientProfile.datasetVersion,
                            `제공량 ${food.servings.map((serving) => serving.labelKo).join(', ') || '없음'}`,
                          ].join(', ')}
                          accessibilityRole="button"
                          disabled={saving}
                          onPress={() => void selectFood(item, food)}
                          style={({ pressed }) => [
                            styles.foodResult,
                            (pressed || saving) && styles.pressed,
                          ]}
                        >
                          <ThemedText type="smallBold">
                            {food.canonicalNameKo}
                          </ThemedText>
                          <ThemedText type="small" themeColor="textSecondary">
                            {food.category}
                            {food.preparation ? ` · ${food.preparation}` : ''}
                          </ThemedText>
                          <ThemedText type="small" themeColor="textSecondary">
                            {food.nutrientProfile.sourceDisplayName} ·{' '}
                            {food.nutrientProfile.datasetVersion}
                          </ThemedText>
                          <ThemedText type="small" themeColor="textSecondary">
                            제공량: {food.servings.map((serving) => serving.labelKo).join(', ') || '없음'}
                          </ThemedText>
                        </Pressable>
                      ))}
                    </View>
                  )}
                  <ThemedText type="small" themeColor="textSecondary">
                    음식 인식 {confidenceLabel(item.recognitionConfidenceBps)} ·
                    양 추정 {confidenceLabel(item.portionConfidenceBps)}
                  </ThemedText>
                  <ThemedText type="smallBold">양</ThemedText>
                  <TextInput
                    accessibilityLabel="음식 양"
                    editable={!saving}
                    keyboardType="decimal-pad"
                    onChangeText={(amount) => updateForm(item.id, { amount })}
                    style={styles.input}
                    value={form.amount}
                  />
                  <View style={styles.unitRow}>
                    {units.map((unit) => (
                      <Pressable
                        key={unit}
                        accessibilityLabel={`${unit} 단위 선택`}
                        accessibilityRole="button"
                        accessibilityState={{ selected: form.unit === unit }}
                        disabled={saving}
                        onPress={() => updateForm(item.id, { unit })}
                        style={[
                          styles.unitButton,
                          form.unit === unit && styles.selectedUnitButton,
                        ]}
                      >
                        <ThemedText
                          type="smallBold"
                          style={
                            form.unit === unit
                              ? styles.selectedUnitText
                              : styles.unitText
                          }
                        >
                          {mealUnitLabel(unit)}
                        </ThemedText>
                      </Pressable>
                    ))}
                  </View>
                  <View style={styles.itemActions}>
                    <ModalButton
                      disabled={saving}
                      label={saving ? '저장 중' : '항목 저장'}
                      onPress={() => void saveItem(item)}
                    />
                    <ModalButton
                      disabled={saving}
                      label="삭제"
                      onPress={() => void removeItem(item.id)}
                      secondary
                    />
                  </View>
                </View>
              );
            })}
            <ModalButton
              disabled={savingItemId !== null}
              label={savingItemId === 'new' ? '추가 중' : '직접 입력 항목 추가'}
              onPress={() => void addManualItem()}
              secondary
            />
            <ModalButton label="초안 저장하고 닫기" onPress={onClose} />
          </ScrollView>
        )}
      </ThemedView>
    </Modal>
  );
}

function formsFromItems(items: MealDraftItem[]) {
  return Object.fromEntries(
    items.map((item) => [
      item.id,
      {
        recognizedLabel: item.recognizedLabel,
        amount: (item.amountMilliunits / 1000).toString(),
        unit: item.unit,
      },
    ]),
  );
}

async function loadMappedFoods(items: MealDraftItem[]) {
  const matches = await Promise.all(
    items
      .filter((item) => item.foodId)
      .map(async (item) => {
        try {
          const { foods } = await searchFoods(item.recognizedLabel);
          const food = foods.find((candidate) => candidate.id === item.foodId);
          return food ? ([item.id, food] as const) : null;
        } catch {
          return null;
        }
      }),
  );

  return Object.fromEntries(
    matches.filter(
      (match): match is readonly [string, CanonicalFood] => match !== null,
    ),
  );
}

function confidenceLabel(basisPoints: number | null) {
  return basisPoints === null
    ? '확인 필요'
    : `${Math.round(basisPoints / 100)}%`;
}

function errorMessage(cause: unknown) {
  return cause instanceof Error
    ? cause.message
    : '식사 초안을 처리하지 못했습니다.';
}

function ModalButton({
  label,
  onPress,
  secondary = false,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  secondary?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        secondary && styles.secondaryButton,
        (pressed || disabled) && styles.pressed,
      ]}
    >
      <ThemedText
        type="smallBold"
        style={secondary ? styles.secondaryText : styles.buttonText}
      >
        {label}
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: Spacing.four, gap: Spacing.three },
  header: { flexDirection: 'row', gap: Spacing.two, alignItems: 'flex-start' },
  headerCopy: { flex: 1, gap: Spacing.half },
  content: { gap: Spacing.three, paddingBottom: Spacing.four },
  image: {
    width: '100%',
    aspectRatio: 4 / 3,
    borderRadius: 14,
    backgroundColor: '#DDE5E0',
  },
  recognition: { gap: Spacing.one },
  itemCard: {
    gap: Spacing.two,
    padding: Spacing.three,
    borderRadius: 14,
    backgroundColor: '#F2F6F3',
  },
  input: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: '#AAB8B0',
    borderRadius: 10,
    paddingHorizontal: Spacing.two,
    color: '#1D2A23',
  },
  foodSearch: { gap: Spacing.two },
  foodResult: {
    minHeight: 44,
    gap: Spacing.half,
    padding: Spacing.two,
    borderWidth: 1,
    borderColor: '#AAB8B0',
    borderRadius: 10,
    backgroundColor: '#FFFFFF',
  },
  mappingConnected: { color: '#16794A' },
  mappingInvalid: { color: '#B42318' },
  unitRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.one },
  unitButton: {
    minHeight: 44,
    minWidth: 58,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.two,
    borderWidth: 1,
    borderColor: '#16794A',
    borderRadius: 10,
  },
  selectedUnitButton: { backgroundColor: '#16794A' },
  unitText: { color: '#16794A' },
  selectedUnitText: { color: '#FFFFFF' },
  itemActions: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two },
  button: {
    minHeight: 44,
    minWidth: 112,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    paddingHorizontal: Spacing.three,
    backgroundColor: '#16794A',
  },
  secondaryButton: {
    borderWidth: 1,
    borderColor: '#16794A',
    backgroundColor: 'transparent',
  },
  buttonText: { color: '#FFFFFF' },
  secondaryText: { color: '#16794A' },
  pressed: { opacity: 0.6 },
  errorText: { color: '#B42318' },
});
