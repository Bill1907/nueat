import { Image } from 'expo-image';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState,
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
  retryMealDraftRecognition,
  startManualMealDraftEntry,
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
import {
  RECOGNITION_MAX_ELAPSED_MS,
  recognitionPollDelay,
  type RecognitionStatus,
} from '@/meals/meal-recognition-policy';

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
  const [loadErrorMealLogId, setLoadErrorMealLogId] = useState<string | null>(null);
  const [loadedMealLogId, setLoadedMealLogId] = useState<string | null>(null);
  const [savingItemId, setSavingItemId] = useState<string | null>(null);
  const [pollGeneration, setPollGeneration] = useState(0);
  const [recognitionTimedOut, setRecognitionTimedOut] = useState(false);
  const [manualForm, setManualForm] = useState<{
    recognizedLabel: string;
    amount: string;
    unit: MealUnit | '';
  } | null>(null);
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
  const mounted = useRef(true);
  const visibleRef = useRef(visible);
  const scopeRef = useRef({ mealLogId, generation: 0 });
  const itemsRef = useRef<MealDraftItem[]>([]);
  const mutationQueue = useRef(Promise.resolve());
  const mutationToken = useRef(0);
  const scopeRequestController = useRef(new AbortController());

  const isCurrent = useCallback((mealId: string, generation: number) => {
    return (
      mounted.current &&
      visibleRef.current &&
      scopeRef.current.mealLogId === mealId &&
      scopeRef.current.generation === generation
    );
  }, []);

  const applyResponse = useCallback(
    (
      response: MealDraftResponse,
      mealId: string,
      generation: number,
    ) => {
      if (!isCurrent(mealId, generation) || response.mealLog.id !== mealId) return;
      itemsRef.current = response.items;
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
    },
    [isCurrent],
  );

  useEffect(() => {
    visibleRef.current = visible;
    scopeRef.current = {
      mealLogId,
      generation: scopeRef.current.generation + 1,
    };
    if (!visible || !mealLogId) return;
    mounted.current = true;
    const generation = scopeRef.current.generation;
    let appActive = AppState.currentState === 'active';
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let loading = false;
    let requestController = new AbortController();
    let refreshRequested = false;
    scopeRequestController.current.abort();
    scopeRequestController.current = requestController;
    const startedAt = Date.now();

    const schedule = (status: RecognitionStatus = 'pending') => {
      const elapsedMs = Date.now() - startedAt;
      const delay = recognitionPollDelay({
        status,
        attempt: attempt++,
        elapsedMs,
        isAppActive: appActive,
      });
      if (delay !== null && isCurrent(mealLogId, generation) && appActive) {
        timer = setTimeout(() => void refresh(false), delay);
      } else if (elapsedMs >= RECOGNITION_MAX_ELAPSED_MS && isCurrent(mealLogId, generation)) {
        setRecognitionTimedOut(true);
      }
    };

    const refresh = async (loadImage: boolean) => {
      if (!isCurrent(mealLogId, generation) || !appActive) return;
      if (loading) {
        refreshRequested = true;
        return;
      }
      loading = true;
      try {
        const mealDraft = await getMealDraft(
          mealLogId,
          requestController.signal,
        );
        if (!isCurrent(mealLogId, generation)) return;
        setLoadError(null);
        setLoadErrorMealLogId(mealLogId);
        setRecognitionTimedOut(false);
        applyResponse(mealDraft, mealLogId, generation);

        if (mealDraft.items.some((item) => item.foodId)) {
          const mapped = await loadMappedFoods(
            mealDraft.items,
            requestController.signal,
          );
          if (!isCurrent(mealLogId, generation)) return;
          setMappedFoods((current) => ({
            ...current,
            ...Object.fromEntries(
              Object.entries(mapped).filter(([itemId, food]) =>
                itemsRef.current.some(
                  (item) => item.id === itemId && item.foodId === food.id,
                ),
              ),
            ),
          }));
        }

        if (loadImage) setImageUrl(null);
        if (loadImage && mealDraft.mealLog.imageAssetId) {
          setImageUrl(null);
          try {
            const intent = await getMealImageDownloadIntent(
              mealDraft.mealLog.imageAssetId,
              requestController.signal,
            );
            if (!isCurrent(mealLogId, generation)) return;
            setImageUrl(intent.downloadUrl);
          } catch (cause) {
            if (cause instanceof Error && cause.name === 'AbortError') return;
            if (isCurrent(mealLogId, generation)) {
              setLoadErrorMealLogId(mealLogId);
              setLoadError(errorMessage(cause));
            }
          }
        }
        schedule(mealDraft.mealLog.recognitionStatus);
      } catch (cause) {
        if (cause instanceof Error && cause.name === 'AbortError') return;
        if (isCurrent(mealLogId, generation)) {
          setLoadErrorMealLogId(mealLogId);
          setLoadError(errorMessage(cause));
          schedule();
        }
      } finally {
        loading = false;
        if (
          refreshRequested &&
          appActive &&
          isCurrent(mealLogId, generation)
        ) {
          refreshRequested = false;
          void refresh(false);
        }
      }
    };

    void refresh(true);
    const subscription = AppState.addEventListener('change', (nextState) => {
      appActive = nextState === 'active';
      if (!appActive) {
        requestController.abort();
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      } else if (isCurrent(mealLogId, generation)) {
        requestController = new AbortController();
        scopeRequestController.current = requestController;
        void refresh(false);
      }
    });
    return () => {
      visibleRef.current = false;
      scopeRef.current.generation += 1;
      requestController.abort();
      scopeRequestController.current.abort();
      if (timer) clearTimeout(timer);
      subscription.remove();
    };
  }, [applyResponse, isCurrent, mealLogId, pollGeneration, visible]);

  useEffect(
    () => () => {
      mounted.current = false;
      scopeRef.current.generation += 1;
    },
    [],
  );

  async function runFoodSearch() {
    const query = normalizeKoreanFoodLabel(foodQuery);
    const itemId = foodSearchItemId;
    const { mealLogId: scopedMealId, generation } = scopeRef.current;
    if (!itemId || !scopedMealId || !query) {
      if (itemId && isCurrent(scopedMealId ?? '', generation)) {
        setFoodSearchState({ status: 'empty', foods: [] });
      }
      return;
    }

    const requestId = ++foodSearchRequest.current;
    setFoodSearchState({ status: 'loading', foods: [] });
    try {
      const { foods } = await searchFoods(
        query,
        scopeRequestController.current.signal,
      );
      if (
        requestId !== foodSearchRequest.current ||
        !isCurrent(scopedMealId, generation) ||
        !itemsRef.current.some((item) => item.id === itemId)
      ) {
        return;
      }
      setFoodSearchState({
        status: foods.length === 0 ? 'empty' : 'idle',
        foods,
      });
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') return;
      if (
        requestId !== foodSearchRequest.current ||
        !isCurrent(scopedMealId, generation)
      ) {
        return;
      }
      setFoodSearchState({
        status: 'error',
        foods: [],
        message: errorMessage(cause),
      });
    }
  }

  function enqueueMutation(
    savingId: string,
    operation: (mealId: string, generation: number) => Promise<void>,
  ) {
    const { mealLogId: scopedMealId, generation } = scopeRef.current;
    if (!scopedMealId || !isCurrent(scopedMealId, generation) || savingItemId) return;
    const token = ++mutationToken.current;
    setSavingItemId(savingId);
    setLoadErrorMealLogId(scopedMealId);
    setLoadError(null);
    mutationQueue.current = mutationQueue.current
      .catch(() => undefined)
      .then(async () => {
        if (!isCurrent(scopedMealId, generation)) return;
        try {
          await operation(scopedMealId, generation);
        } catch (cause) {
          if (isCurrent(scopedMealId, generation)) setLoadError(errorMessage(cause));
        } finally {
          if (mutationToken.current === token) setSavingItemId(null);
        }
      });
  }

  function retryRecognition() {
    enqueueMutation('recognition', async (scopedMealId, generation) => {
      const response = await retryMealDraftRecognition(scopedMealId);
      if (!isCurrent(scopedMealId, generation)) return;
      applyResponse(response, scopedMealId, generation);
      setRecognitionTimedOut(false);
      setPollGeneration((current) => current + 1);
    });
  }

  function startManualEntry() {
    enqueueMutation('recognition', async (scopedMealId, generation) => {
      const response = await startManualMealDraftEntry(scopedMealId);
      if (!isCurrent(scopedMealId, generation)) return;
      applyResponse(response, scopedMealId, generation);
      setRecognitionTimedOut(false);
    });
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

  function selectFood(item: MealDraftItem, food: CanonicalFood) {
    if (!isEditable) return;
    enqueueMutation(item.id, async (scopedMealId, generation) => {
      const response = await mapMealDraftItemFood(scopedMealId, item.id, food.id);
      if (!isCurrent(scopedMealId, generation)) return;
      setMappedFoods((current) => ({ ...current, [item.id]: food }));
      setInvalidatedMappings((current) => {
        const next = new Set(current);
        next.delete(item.id);
        return next;
      });
      applyResponse(response, scopedMealId, generation);
      setForms((current) => ({
        ...current,
        [item.id]: {
          ...current[item.id],
          recognizedLabel: food.canonicalNameKo,
        },
      }));
      setFoodSearchItemId(null);
      setFoodQuery('');
    });
  }

  function updateForm(itemId: string, update: Partial<ItemForm>) {
    setForms((current) => ({
      ...current,
      [itemId]: { ...current[itemId], ...update },
    }));
  }

  function saveItem(item: MealDraftItem) {
    if (!isEditable) return;
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

    enqueueMutation(item.id, async (scopedMealId, generation) => {
      const recognizedLabel = form.recognizedLabel.trim();
      const response = await updateMealDraftItem(scopedMealId, item.id, {
        ...(recognizedLabel === item.recognizedLabel ? {} : { recognizedLabel }),
        amountMilliunits,
        unit: form.unit,
      });
      applyResponse(response, scopedMealId, generation);
    });
  }

  function removeItem(itemId: string) {
    if (!isEditable) return;
    enqueueMutation(itemId, async (scopedMealId, generation) => {
      const response = await deleteMealDraftItem(scopedMealId, itemId);
      applyResponse(response, scopedMealId, generation);
    });
  }

  function addManualItem() {
    setManualForm({ recognizedLabel: '', amount: '', unit: '' });
  }

  function saveManualItem() {
    if (!manualForm || !isEditable) return;
    const recognizedLabel = manualForm.recognizedLabel.trim();
    const amountMilliunits = decimalToMilliunits(manualForm.amount);
    const unit = manualForm.unit;
    if (!recognizedLabel || !amountMilliunits || !unit) {
      setLoadError('음식 이름, 양, 단위를 입력해 주세요.');
      return;
    }
    enqueueMutation('new', async (scopedMealId, generation) => {
      const response = await addMealDraftItem(scopedMealId, {
        recognizedLabel,
        amountMilliunits,
        unit,
      });
      if (!isCurrent(scopedMealId, generation)) return;
      applyResponse(response, scopedMealId, generation);
      setManualForm(null);
    });
  }
  const currentData = loadedMealLogId === mealLogId ? data : null;
  const currentError = loadErrorMealLogId === mealLogId ? loadError : null;
  const isEditable =
    currentData?.mealLog.recognitionStatus === 'ready' ||
    currentData?.mealLog.recognitionStatus === 'manual';
  const canRecoverRecognition =
    currentData?.mealLog.recognitionStatus === 'failed' ||
    recognitionTimedOut;
  function closeModal() {
    visibleRef.current = false;
    scopeRef.current.generation += 1;
    mutationToken.current += 1;
    setSavingItemId(null);
    setManualForm(null);
    onClose();
  }

  return (
    <Modal
      animationType="slide"
      onRequestClose={closeModal}
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
          <ModalButton label="닫기" onPress={closeModal} secondary />
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
        {currentError && visible && mealLogId && (
          <ModalButton
            label="새로고침"
            onPress={() => setPollGeneration((current) => current + 1)}
            secondary
          />
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
                {currentData.mealLog.recognitionStatus === 'pending' ||
                currentData.mealLog.recognitionStatus === 'processing'
                  ? '사진에서 음식을 인식하고 있어요. 완료될 때까지 잠시만 기다려 주세요.'
                  : `상태: ${currentData.mealLog.recognitionStatus} · 제공자: ${currentData.mealLog.recognitionProvider ?? '알 수 없음'} · 모델: ${currentData.mealLog.recognitionModel ?? '알 수 없음'}`}
              </ThemedText>
              {(currentData.mealLog.recognitionStatus === 'pending' ||
                currentData.mealLog.recognitionStatus === 'processing') &&
                currentData.mealLog.recognitionNextAttemptAt && (
                  <ThemedText type="small" themeColor="textSecondary">
                    다음 확인: {currentData.mealLog.recognitionNextAttemptAt}
                  </ThemedText>
                )}
              {canRecoverRecognition && (
                <View style={styles.itemActions}>
                  <ThemedText accessibilityRole="alert" type="small" style={styles.errorText}>
                    {recognitionTimedOut
                      ? '인식 시간이 초과되었습니다. 다시 시도하거나 직접 입력해 주세요.'
                      : '음식 인식에 실패했습니다. 다시 시도하거나 직접 입력해 주세요.'}
                  </ThemedText>
                  <ModalButton
                    disabled={savingItemId !== null}
                    label={savingItemId === 'recognition' ? '처리 중' : '인식 다시 시도'}
                    onPress={() => void retryRecognition()}
                  />
                  <ModalButton
                    disabled={savingItemId !== null}
                    label="직접 입력"
                    onPress={() => void startManualEntry()}
                    secondary
                  />
                </View>
              )}
            </View>
            {isEditable && currentData.items.map((item) => {
              const form = forms[item.id];
              if (!form) return null;
              const saving = savingItemId !== null;
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
            {isEditable && manualForm && (
              <View style={styles.itemCard}>
                <ThemedText type="smallBold">직접 입력</ThemedText>
                <TextInput
                  accessibilityLabel="직접 입력 음식 이름"
                  editable={savingItemId === null}
                  onChangeText={(recognizedLabel) =>
                    setManualForm((current) =>
                      current ? { ...current, recognizedLabel } : current,
                    )
                  }
                  style={styles.input}
                  value={manualForm.recognizedLabel}
                />
                <TextInput
                  accessibilityLabel="직접 입력 음식 양"
                  editable={savingItemId === null}
                  keyboardType="decimal-pad"
                  onChangeText={(amount) =>
                    setManualForm((current) =>
                      current ? { ...current, amount } : current,
                    )
                  }
                  style={styles.input}
                  value={manualForm.amount}
                />
                <View style={styles.unitRow}>
                  {units.map((unit) => (
                    <Pressable
                      key={unit}
                      accessibilityLabel={`${unit} 단위 선택`}
                      accessibilityRole="button"
                      accessibilityState={{ selected: manualForm.unit === unit }}
                      disabled={savingItemId !== null}
                      onPress={() =>
                        setManualForm((current) =>
                          current ? { ...current, unit } : current,
                        )
                      }
                      style={[
                        styles.unitButton,
                        manualForm.unit === unit && styles.selectedUnitButton,
                      ]}
                    >
                      <ThemedText
                        type="smallBold"
                        style={
                          manualForm.unit === unit
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
                    disabled={savingItemId !== null}
                    label={savingItemId === 'new' ? '저장 중' : '항목 저장'}
                    onPress={saveManualItem}
                  />
                  <ModalButton
                    disabled={savingItemId !== null}
                    label="취소"
                    onPress={() => setManualForm(null)}
                    secondary
                  />
                </View>
              </View>
            )}
            {isEditable && !manualForm && (
              <ModalButton
                disabled={savingItemId !== null}
                label="직접 입력 항목 추가"
                onPress={addManualItem}
                secondary
              />
            )}
            <ModalButton label="초안 저장하고 닫기" onPress={closeModal} />
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

async function loadMappedFoods(
  items: MealDraftItem[],
  signal?: AbortSignal,
) {
  const matches = await Promise.all(
    items
      .filter((item) => item.foodId)
      .map(async (item) => {
        try {
          const { foods } = await searchFoods(item.recognizedLabel, signal);
          const food = foods.find((candidate) => candidate.id === item.foodId);
          return food ? ([item.id, food] as const) : null;
        } catch (cause) {
          if (cause instanceof Error && cause.name === 'AbortError') throw cause;
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

function errorMessage(_cause: unknown) {
  return '식사 초안을 처리하지 못했습니다.';
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
