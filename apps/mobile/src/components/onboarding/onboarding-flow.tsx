import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  TextInput,
  View,
} from 'react-native';
import {
  ACTIVITY_OPTIONS,
  CONSENT_DOCUMENTS,
  GOAL_OPTIONS,
  LIMITED_REASON_LABELS,
  type OnboardingConsentType,
} from '@nueat/domain';

import { apiRequest } from '@/api/client';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  canContinueConsents,
  toProfileInput,
  type OnboardingFormState,
} from '@/components/onboarding/form';

type Preview =
  | {
      status: 'calculated';
      targets: {
        calorieTargetMillicalories: number;
        carbohydrateTargetMg: number;
        proteinTargetMg: number;
        fatTargetMg: number;
        fiberTargetMg: number;
      };
      provenance: {
        standard: { nameKo: string; equationVersion: string };
        baseEerKcal: number;
        activityCoefficient: number;
      };
    }
  | {
      status: 'limited';
      reasons: (keyof typeof LIMITED_REASON_LABELS)[];
      standard: { nameKo: string; equationVersion: string };
    };

const initialForm: OnboardingFormState = {
  goalType: 'balanced_diet',
  birthYear: '',
  calculationSex: null,
  heightCm: '',
  weightKg: '',
  activityLevel: 'sedentary',
  isPregnantOrLactating: false,
  hasEatingDisorderRisk: false,
  requiresMedicalNutrition: false,
};

export function OnboardingFlow({ onComplete }: { onComplete: () => void }) {
  const [step, setStep] = useState(1);
  const [form, setForm] = useState<OnboardingFormState>(initialForm);
  const [consents, setConsents] = useState<OnboardingConsentType[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const update = <K extends keyof OnboardingFormState>(
    key: K,
    value: OnboardingFormState[K],
  ) => {
    setPreview(null);
    setForm((current) => ({ ...current, [key]: value }));
  };
  const profile = toProfileInput(form);

  function toggleConsent(type: OnboardingConsentType, enabled: boolean) {
    setPreview(null);
    setConsents((current) =>
      enabled ? [...current, type] : current.filter((value) => value !== type),
    );
  }
  function next() {
    setError(null);
    if (step === 1 && !canContinueConsents(consents))
      return setError('필수 동의 항목을 모두 선택해 주세요.');
    if (
      step === 3 &&
      (!Number.isInteger(profile.birthYear) ||
        profile.birthYear < 1900 ||
        profile.birthYear > new Date().getUTCFullYear())
    )
      return setError('출생 연도를 확인해 주세요.');
    if (
      step === 4 &&
      (!Number.isInteger(profile.heightMm) ||
        profile.heightMm < 1_200 ||
        profile.heightMm > 2_200 ||
        !Number.isInteger(profile.weightG) ||
        profile.weightG < 35_000 ||
        profile.weightG > 250_000)
    )
      return setError('신장은 120–220cm, 체중은 35–250kg 범위로 입력해 주세요.');
    setStep((current) => current + 1);
  }
  async function requestPreview() {
    setLoading(true);
    setError(null);
    try {
      setPreview(
        await apiRequest<Preview>('/api/onboarding/preview', {
          method: 'POST',
          body: JSON.stringify(profile),
        }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '다시 시도해 주세요.');
    } finally {
      setLoading(false);
    }
  }
  async function complete() {
    setLoading(true);
    setError(null);
    try {
      await apiRequest('/api/onboarding/complete', {
        method: 'PUT',
        body: JSON.stringify({ profile, acceptedConsentTypes: consents }),
      });
      onComplete();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '다시 시도해 주세요.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <ThemedView style={styles.card}>
          <ThemedText type="subtitle">시작하기 {step}/6</ThemedText>
          {step === 1 && (
            <View style={styles.stack}>
              {CONSENT_DOCUMENTS.map((document) => (
                <Toggle
                  key={document.type}
                  label={`${document.titleKo}${document.required ? ' (필수)' : ' (선택)'}`}
                  value={consents.includes(document.type)}
                  onValueChange={(value) => toggleConsent(document.type, value)}
                  detail={document.contentKo}
                />
              ))}
            </View>
          )}
          {step === 2 && (
            <Options
              label="목표"
              options={GOAL_OPTIONS}
              value={form.goalType}
              onChange={(value) => update('goalType', value)}
            />
          )}
          {step === 3 && (
            <View style={styles.stack}>
              <Field
                label="출생 연도"
                value={form.birthYear}
                onChangeText={(value) =>
                  update('birthYear', value.replace(/[^0-9]/g, ''))
                }
              />
              <Options
                label="계산에 사용할 성별"
                options={[
                  { value: 'female', labelKo: '여성' },
                  { value: 'male', labelKo: '남성' },
                  { value: null, labelKo: '선택하지 않음' },
                ]}
                value={form.calculationSex}
                onChange={(value) => update('calculationSex', value)}
              />
            </View>
          )}
          {step === 4 && (
            <View style={styles.stack}>
              <Field
                label="신장 (cm)"
                value={form.heightCm}
                onChangeText={(value) => update('heightCm', value)}
                decimal
              />
              <Field
                label="체중 (kg)"
                value={form.weightKg}
                onChangeText={(value) => update('weightKg', value)}
                decimal
              />
            </View>
          )}
          {step === 5 && (
            <View style={styles.stack}>
              <Options
                label="활동 수준"
                options={ACTIVITY_OPTIONS}
                value={form.activityLevel}
                onChange={(value) => update('activityLevel', value)}
              />
              <Toggle
                label="임신 또는 수유 중"
                value={form.isPregnantOrLactating}
                onValueChange={(value) =>
                  update('isPregnantOrLactating', value)
                }
              />
              <Toggle
                label="섭식장애 위험이 있음"
                value={form.hasEatingDisorderRisk}
                onValueChange={(value) =>
                  update('hasEatingDisorderRisk', value)
                }
              />
              <Toggle
                label="의료 목적 영양관리가 필요함"
                value={form.requiresMedicalNutrition}
                onValueChange={(value) =>
                  update('requiresMedicalNutrition', value)
                }
              />
            </View>
          )}
          {step === 6 && (
            <View style={styles.stack}>
              {preview ? (
                <PreviewResult preview={preview} />
              ) : (
                <ThemedText themeColor="textSecondary">
                  입력한 정보로 일반 웰니스 영양 목표를 확인해요.
                </ThemedText>
              )}
            </View>
          )}
          {error && (
            <ThemedText accessibilityRole="alert" style={styles.error}>
              {error}
            </ThemedText>
          )}
          <View style={styles.actions}>
            {step > 1 && (
              <Button
                label="이전"
                onPress={() => {
                  setError(null);
                  setStep((current) => current - 1);
                }}
                secondary
              />
            )}
            {step < 6 ? (
              <Button label="다음" onPress={next} />
            ) : !preview ? (
              <Button
                label={loading ? '계산 중…' : '목표 확인'}
                onPress={() => void requestPreview()}
                disabled={loading}
              />
            ) : (
              <Button
                label={loading ? '저장 중…' : '완료'}
                onPress={() => void complete()}
                disabled={loading}
              />
            )}
          </View>
        </ThemedView>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function PreviewResult({ preview }: { preview: Preview }) {
  if (preview.status === 'limited')
    return (
      <View style={styles.stack}>
        <ThemedText type="smallBold">자동 목표 제공이 제한되었어요</ThemedText>
        {preview.reasons.map((reason) => (
          <ThemedText key={reason} themeColor="textSecondary">
            • {LIMITED_REASON_LABELS[reason]}
          </ThemedText>
        ))}
        <ThemedText type="small" themeColor="textSecondary">
          기준: {preview.standard.nameKo} {preview.standard.equationVersion}
        </ThemedText>
      </View>
    );
  const { targets, provenance } = preview;
  return (
    <View style={styles.stack}>
      <ThemedText type="smallBold">계산된 영양 목표</ThemedText>
      <ThemedText>
        열량 {targets.calorieTargetMillicalories / 1000} kcal
      </ThemedText>
      <ThemedText>
        탄수화물 {targets.carbohydrateTargetMg / 1000}g · 단백질{' '}
        {targets.proteinTargetMg / 1000}g · 지방 {targets.fatTargetMg / 1000}g ·
        식이섬유 {targets.fiberTargetMg / 1000}g
      </ThemedText>
      <ThemedText type="small" themeColor="textSecondary">
        기준: {provenance.standard.nameKo} {provenance.standard.equationVersion}
        , 기본 필요량 {provenance.baseEerKcal} kcal, 활동계수{' '}
        {provenance.activityCoefficient}
      </ThemedText>
    </View>
  );
}
function Field({
  label,
  value,
  onChangeText,
  decimal = false,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  decimal?: boolean;
}) {
  const theme = useTheme();
  return (
    <View style={styles.stack}>
      <ThemedText type="smallBold">{label}</ThemedText>
      <TextInput
        accessibilityLabel={label}
        keyboardType="decimal-pad"
        value={value}
        onChangeText={onChangeText}
        style={[
          styles.input,
          { color: theme.text, borderColor: theme.backgroundSelected },
        ]}
        placeholder={decimal ? '0.0' : 'YYYY'}
        placeholderTextColor={theme.textSecondary}
      />
    </View>
  );
}
function Options<T extends string | null>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { value: T; labelKo: string; descriptionKo?: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <View style={styles.stack}>
      <ThemedText type="smallBold">{label}</ThemedText>
      {options.map((option) => (
        <Pressable
          key={option.labelKo}
          accessibilityRole="radio"
          accessibilityLabel={option.labelKo}
          accessibilityState={{ selected: value === option.value }}
          onPress={() => onChange(option.value)}
          style={[styles.option, value === option.value && styles.selected]}
        >
          <ThemedText type="smallBold">{option.labelKo}</ThemedText>
          {option.descriptionKo && (
            <ThemedText type="small" themeColor="textSecondary">
              {option.descriptionKo}
            </ThemedText>
          )}
        </Pressable>
      ))}
    </View>
  );
}
function Toggle({
  label,
  value,
  onValueChange,
  detail,
}: {
  label: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  detail?: string;
}) {
  return (
    <View style={styles.toggle}>
      <View style={styles.toggleText}>
        <ThemedText type="smallBold">{label}</ThemedText>
        {detail && (
          <ThemedText type="small" themeColor="textSecondary">
            {detail}
          </ThemedText>
        )}
      </View>
      <Switch
        accessibilityLabel={label}
        value={value}
        onValueChange={onValueChange}
      />
    </View>
  );
}
function Button({
  label,
  onPress,
  disabled = false,
  secondary = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  secondary?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.button,
        secondary && styles.secondary,
        disabled && styles.disabled,
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
  screen: { flex: 1 },
  content: { flexGrow: 1, padding: Spacing.three, justifyContent: 'center' },
  card: { gap: Spacing.three, padding: Spacing.four, borderRadius: 16 },
  stack: { gap: Spacing.two },
  toggle: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  toggleText: { flex: 1, gap: 2 },
  option: {
    minHeight: 44,
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#B8C5BD',
    borderRadius: 10,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  selected: { borderColor: '#16794A', backgroundColor: '#E7F4EC' },
  input: {
    minHeight: 44,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: Spacing.three,
  },
  actions: {
    flexDirection: 'row',
    gap: Spacing.two,
    justifyContent: 'flex-end',
  },
  button: {
    minHeight: 44,
    minWidth: 88,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 10,
    backgroundColor: '#16794A',
    paddingHorizontal: Spacing.three,
  },
  secondary: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: '#16794A',
  },
  buttonText: { color: '#FFFFFF' },
  secondaryText: { color: '#16794A' },
  disabled: { opacity: 0.5 },
  error: { color: '#B42318' },
});
