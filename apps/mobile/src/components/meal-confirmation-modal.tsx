import { Image } from 'expo-image';
import { useEffect, useState } from 'react';
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
  type MealDraftItem,
  type MealDraftResponse,
  type MealUnit,
  updateMealDraftItem,
} from '@/api/meal-drafts';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { decimalToMilliunits, mealUnitLabel } from '@/meals/meal-draft-policy';

const units: MealUnit[] = ['g', 'ml', 'serving', 'bowl', 'piece'];

type ItemForm = {
  recognizedLabel: string;
  amount: string;
  unit: MealUnit;
};

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

  function applyResponse(response: MealDraftResponse) {
    setData(response);
    setLoadedMealLogId(response.mealLog.id);
    setForms(formsFromItems(response.items));
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
      applyResponse(
        await updateMealDraftItem(mealLogId, item.id, {
          recognizedLabel: form.recognizedLabel.trim(),
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
              return (
                <View key={item.id} style={styles.itemCard}>
                  <ThemedText type="smallBold">음식</ThemedText>
                  <TextInput
                    accessibilityLabel="음식 이름"
                    editable={!saving}
                    onChangeText={(recognizedLabel) =>
                      updateForm(item.id, { recognizedLabel })
                    }
                    style={styles.input}
                    value={form.recognizedLabel}
                  />
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
