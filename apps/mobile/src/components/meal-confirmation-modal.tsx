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
  confirmMealDraft,
  deleteMealDraftItem,
  getMealDraft,
  getMealImageDownloadIntent,
  mapMealDraftItemFood,
  retryMealDraftRecognition,
  startManualMealDraftEntry,
  type ConfirmedNutrientValue,
  type ConfirmedMealNutrition,
  type MealDraftItem,
  type MealDraftResponse,
  type MealUnit,
  updateMealDraftItem,
} from '@/api/meal-drafts';
import { ApiError } from '@/api/client';
import { getFood, searchFoods, type CanonicalFood } from '@/api/foods';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import {
  createNutritionPreview,
  decimalToMilliunits,
  formatNutritionValue,
  hasUnsavedMealDraftItemForms,
  mealUnitLabel,
  nutritionKeys,
} from '@/meals/meal-draft-policy';
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
  onConfirmed,
}: {
  mealLogId: string | null;
  visible: boolean;
  onClose: () => void;
  onConfirmed?: () => void;
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
  const [hydrationErrors, setHydrationErrors] = useState<Record<string, string>>({});
  const [confirmationState, setConfirmationState] = useState<{
    mealLogId: string;
    nutrition: ConfirmedMealNutrition | null;
    errors: string[];
  } | null>(null);
  const confirmedNutrition =
    confirmationState?.mealLogId === mealLogId
      ? confirmationState.nutrition
      : null;
  const confirmationErrors =
    confirmationState?.mealLogId === mealLogId
      ? confirmationState.errors
      : [];
  const foodSearchRequest = useRef(0);
  const mounted = useRef(true);
  const visibleRef = useRef(visible);
  const scopeRef = useRef({ mealLogId, generation: 0 });
  const itemsRef = useRef<MealDraftItem[]>([]);
  const mutationQueue = useRef(Promise.resolve());
  const mutationToken = useRef(0);
  const scopeRequestController = useRef(new AbortController());
  const foodSearchController = useRef<AbortController | null>(null);
  const confirmationInFlight = useRef(false);
  const confirmationToken = useRef(0);
  const mutationInFlight = useRef(false);
  const operationEpoch = useRef(0);

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
    confirmationToken.current += 1;
    confirmationInFlight.current = false;
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
      const refreshEpoch = operationEpoch.current;
      try {
        const mealDraft = await getMealDraft(
          mealLogId,
          requestController.signal,
        );
        if (
          !isCurrent(mealLogId, generation) ||
          refreshEpoch !== operationEpoch.current ||
          confirmationInFlight.current
        ) {
          return;
        }
        setLoadError(null);
        setLoadErrorMealLogId(mealLogId);
        setRecognitionTimedOut(false);
        applyResponse(mealDraft, mealLogId, generation);

        if (mealDraft.items.some((item) => item.foodId)) {
          const { foods: mapped, errors } = await loadMappedFoods(
            mealDraft.items,
            requestController.signal,
          );
          if (
            !isCurrent(mealLogId, generation) ||
            refreshEpoch !== operationEpoch.current ||
            confirmationInFlight.current
          ) {
            return;
          }
          setHydrationErrors(errors);
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
      foodSearchController.current?.abort();
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
    foodSearchController.current?.abort();
    const controller = new AbortController();
    foodSearchController.current = controller;
    setFoodSearchState({ status: 'loading', foods: [] });
    try {
      const { foods } = await searchFoods(query, controller.signal);
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
      if (requestId !== foodSearchRequest.current || !isCurrent(scopedMealId, generation)) {
        return;
      }
      if (cause instanceof Error && cause.name === 'AbortError') {
        setFoodSearchState({ status: 'idle', foods: [] });
        return;
      }
      setFoodSearchState({
        status: 'error',
        foods: [],
        message: errorMessage(cause),
      });
    } finally {
      if (foodSearchController.current === controller) {
        foodSearchController.current = null;
      }
    }
  }

  function enqueueMutation(
    savingId: string,
    operation: (mealId: string, generation: number) => Promise<void>,
  ) {
    const { mealLogId: scopedMealId, generation } = scopeRef.current;
    if (
      !scopedMealId ||
      !isCurrent(scopedMealId, generation) ||
      mutationInFlight.current ||
      confirmationInFlight.current
    ) {
      return;
    }
    mutationInFlight.current = true;
    const token = ++mutationToken.current;
    operationEpoch.current += 1;
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
          if (mutationToken.current === token) {
            mutationInFlight.current = false;
            setSavingItemId(null);
          }
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
      setHydrationErrors((current) => {
        const next = { ...current };
        delete next[item.id];
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
    currentData?.mealLog.status === 'draft' &&
    (currentData.mealLog.recognitionStatus === 'ready' ||
      currentData.mealLog.recognitionStatus === 'manual');
  const canRecoverRecognition =
    currentData?.mealLog.recognitionStatus === 'failed' ||
    recognitionTimedOut;
  const nutritionPreview = createNutritionPreview(
    currentData?.items.map((item) => {
      const food = mappedFoods[item.id];
      const form = forms[item.id];
      const mappingCurrent =
        food !== undefined &&
        !invalidatedMappings.has(item.id) &&
        form !== undefined &&
        isFoodMappingCurrent(form.recognizedLabel, food);
      return {
        ...item,
        food: mappingCurrent ? food : null,
      };
    }) ?? [],
  );
  const hasUnsavedItemForms =
    currentData !== null &&
    hasUnsavedMealDraftItemForms(currentData.items, forms);
  const canConfirmMeal =
    nutritionPreview.confirmable && !hasUnsavedItemForms && !manualForm;

  function confirmMeal() {
    const { mealLogId: scopedMealId, generation } = scopeRef.current;
    if (
      !scopedMealId ||
      !canConfirmMeal ||
      mutationInFlight.current ||
      confirmationInFlight.current ||
      !isCurrent(scopedMealId, generation)
    ) {
      return;
    }

    confirmationInFlight.current = true;
    operationEpoch.current += 1;
    scopeRequestController.current.abort();
    const token = ++confirmationToken.current;
    setSavingItemId('confirmation');
    setConfirmationState({
      mealLogId: scopedMealId,
      nutrition: null,
      errors: [],
    });
    void confirmMealDraft(scopedMealId)
      .then((response) => {
        if (!isCurrent(scopedMealId, generation)) return;
        setConfirmationState({
          mealLogId: scopedMealId,
          nutrition: response.nutrition,
          errors: [],
        });
        applyResponse(response, scopedMealId, generation);
        try {
          onConfirmed?.();
        } catch {
          // A consumer refresh failure must not rewrite a successful confirmation.
        }
      })
      .catch((cause) => {
        if (!isCurrent(scopedMealId, generation)) return;
        setConfirmationState({
          mealLogId: scopedMealId,
          nutrition: null,
          errors: confirmationErrorMessages(cause, itemsRef.current),
        });
      })
      .finally(() => {
        if (confirmationToken.current !== token) return;
        confirmationInFlight.current = false;
        if (isCurrent(scopedMealId, generation)) setSavingItemId(null);
        mutationInFlight.current = false;
      });
  }
  function closeModal() {
    visibleRef.current = false;
    scopeRef.current.generation += 1;
    mutationToken.current += 1;
    confirmationToken.current += 1;
    confirmationInFlight.current = false;
    mutationInFlight.current = false;
    foodSearchController.current?.abort();
    setSavingItemId(null);
    setManualForm(null);
    setConfirmationState(null);
    onClose();
  }

  return (
    <Modal
      animationType="slide"
      onRequestClose={() => {
        if (!confirmationInFlight.current) closeModal();
      }}
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
          <ModalButton
            disabled={savingItemId === 'confirmation'}
            label="닫기"
            onPress={closeModal}
            secondary
          />
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
              const nutritionItem = nutritionPreview.items.find(
                (previewItem) => previewItem.itemId === item.id,
              );
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
                  {hydrationErrors[item.id] && (
                    <View style={styles.itemActions}>
                      <ThemedText accessibilityRole="alert" type="small" style={styles.errorText}>
                        {hydrationErrors[item.id]}
                      </ThemedText>
                      <ModalButton
                        disabled={saving}
                        label="공식 음식 정보 다시 불러오기"
                        onPress={() => setPollGeneration((current) => current + 1)}
                        secondary
                      />
                    </View>
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
                  {nutritionItem?.status === 'needs-review' && (
                    <ThemedText
                      accessibilityRole="alert"
                      type="smallBold"
                      style={styles.mappingInvalid}
                    >
                      영양 계산: 확인 필요
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
            {isEditable && !confirmedNutrition && (
              <View style={styles.recognition}>
                <ThemedText type="smallBold">영양 미리보기</ThemedText>
                {nutritionPreview.items.some(
                  (item) => item.status === 'needs-review',
                ) && (
                  <ThemedText
                    accessibilityRole="alert"
                    type="small"
                    style={styles.mappingInvalid}
                  >
                    음식 DB 연결 또는 제공량 변환을 확인해 주세요. 확인 필요 항목이 있으면 식사를 확정할 수 없어요.
                  </ThemedText>
                )}
                {nutritionKeys.map((key) => {
                  const total = nutritionPreview.totals[key];
                  return (
                    <ThemedText key={key} type="small" themeColor="textSecondary">
                      {nutritionLabel(key)}:{' '}
                      {total.knownValue === null
                        ? '확인 필요'
                        : formatNutritionValue(total.knownValue, key)}
                      {total.missingItemCount > 0 ? ' · 확인 필요' : ''}
                    </ThemedText>
                  );
                })}
                {(hasUnsavedItemForms || manualForm) && (
                  <ThemedText
                    accessibilityRole="alert"
                    type="small"
                    style={styles.mappingInvalid}
                  >
                    항목 저장 필요
                  </ThemedText>
                )}
                <ModalButton
                  disabled={!canConfirmMeal || savingItemId !== null}
                  label={savingItemId === 'confirmation' ? '식사 확정 중' : '식사 확정'}
                  onPress={confirmMeal}
                />
              </View>
            )}
            {confirmationErrors.map((message) => (
              <ThemedText
                key={message}
                accessibilityRole="alert"
                type="small"
                style={styles.errorText}
              >
                {message}
              </ThemedText>
            ))}
            {confirmedNutrition && (
              <View style={styles.recognition}>
                <ThemedText type="smallBold">확정된 영양</ThemedText>
                {nutritionKeys.map((key) => (
                  <ThemedText key={key} type="small" themeColor="textSecondary">
                    {nutritionLabel(key)}:{' '}
                    {formatConfirmedNutritionValue(confirmedNutrition.totals[key], key)}
                  </ThemedText>
                ))}
                <ThemedText type="small" themeColor="textSecondary">
                  계산 버전: {confirmedNutrition.calculationVersion}
                </ThemedText>
                {confirmedNutrition.items.map((item) => (
                  <ThemedText
                    key={item.mealItemId}
                    type="small"
                    themeColor="textSecondary"
                  >
                    {confirmedItemSourceLabel(
                      item,
                      currentData?.items.find(
                        (draftItem) => draftItem.id === item.mealItemId,
                      )?.recognizedLabel,
                    )}
                  </ThemedText>
                ))}
              </View>
            )}
            <>
              {confirmedNutrition && (
                <ThemedText accessibilityLiveRegion="polite" accessibilityRole="alert" type="smallBold">
                  식사가 확정되었습니다.
                </ThemedText>
              )}
              <ModalButton
                disabled={savingItemId === 'confirmation'}
                label={confirmedNutrition ? '확인 완료' : '초안 저장하고 닫기'}
                onPress={closeModal}
              />
            </>
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
      .filter(
        (item): item is MealDraftItem & { foodId: string; nutrientProfileId: string } =>
          item.foodId !== null && item.nutrientProfileId !== null,
      )
      .map(async (item) => {
        try {
          return {
            itemId: item.id,
            food: await getFood(item.foodId, item.nutrientProfileId, signal),
          };
        } catch (cause) {
          if (cause instanceof Error && cause.name === 'AbortError') throw cause;
          return { itemId: item.id, food: null };
        }
      }),
  );
  return {
    foods: Object.fromEntries(
      matches.flatMap((match) =>
        match.food ? ([[match.itemId, match.food]] as const) : [],
      ),
    ),
    errors: Object.fromEntries(
      matches.flatMap((match) =>
        match.food
          ? []
          : ([
              [
                match.itemId,
                '공식 음식 정보를 불러오지 못했습니다. 다시 시도해 주세요.',
              ],
            ] as const),
      ),
    ),
  };
}
function nutritionLabel(key: (typeof nutritionKeys)[number]) {
  switch (key) {
    case 'energyMillicalories':
      return '열량';
    case 'carbohydrateMg':
      return '탄수화물';
    case 'proteinMg':
      return '단백질';
    case 'fatMg':
      return '지방';
    case 'fiberMg':
      return '식이섬유';
  }
}

function formatConfirmedNutritionValue(
  total: ConfirmedNutrientValue,
  key: (typeof nutritionKeys)[number],
) {
  if (total.completeness === 'partial') {
    return `${formatNutritionValue(total.knownValue, key)} · 일부 항목 확인 필요`;
  }
  return total.value === null ? '확인 필요' : formatNutritionValue(total.value, key);
}

function confirmedItemSourceLabel(
  item: ConfirmedMealNutrition['items'][number],
  recognizedLabel: string | undefined,
) {
  const serving = item.source.servingId
    ? ` · 제공량 ${item.source.servingId} (${item.source.servingQualityGrade ?? '품질 정보 없음'}${
        item.source.servingSourceRegistryId
          ? ` · ${item.source.servingSourceRegistryId}`
          : ''
      })`
    : '';
  return `출처 · ${recognizedLabel ?? '알 수 없는 음식'} · 프로필 ${item.source.qualityGrade} · ${
    item.source.sourceRegistryId
  } · ${item.source.sourceItemId} · ${item.source.datasetVersion}${serving}`;
}

function confirmationErrorMessages(cause: unknown, items: MealDraftItem[]) {
  const details = (
    cause instanceof ApiError
      ? (cause as ApiError & { details?: unknown }).details
      : undefined
  ) as { items?: unknown } | undefined;
  if (!Array.isArray(details?.items)) {
    return [cause instanceof Error ? cause.message : errorMessage(cause)];
  }

  const messages = details.items.flatMap((detail) => {
    if (!detail || typeof detail !== 'object' || !('code' in detail) || typeof detail.code !== 'string') {
      return [];
    }
    const itemId =
      'itemId' in detail && typeof detail.itemId === 'string'
        ? detail.itemId
        : undefined;
    const label = itemId
      ? items.find((item) => item.id === itemId)?.recognizedLabel
      : undefined;
    return [`${label ? `${label}: ` : ''}${confirmationCodeMessage(detail.code)}`];
  });
  return messages.length > 0
    ? messages
    : [cause instanceof Error ? cause.message : errorMessage(cause)];
}

function confirmationCodeMessage(code: string) {
  switch (code) {
    case 'MISSING_MAPPING':
      return '공식 음식 DB 연결이 필요합니다.';
    case 'MISSING_FOOD':
    case 'DEPRECATED_FOOD':
      return '선택한 음식 정보를 다시 연결해 주세요.';
    case 'MISSING_PROFILE':
    case 'MISMATCHED_PROFILE':
    case 'UNTRUSTED_PROFILE_SOURCE':
    case 'INCOMPLETE_PROFILE':
      return '신뢰할 수 있는 영양 정보를 다시 선택해 주세요.';
    case 'MISSING_SERVING_CONVERSION':
      return '선택한 단위의 제공량 변환이 필요합니다.';
    case 'AMBIGUOUS_SERVING_CONVERSION':
      return '제공량 변환이 하나로 결정되지 않습니다. 단위를 바꿔 주세요.';
    case 'UNTRUSTED_SERVING_SOURCE':
      return '신뢰할 수 있는 제공량 정보를 다시 선택해 주세요.';
    default:
      return '식사 항목을 확인해 주세요.';
  }
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
