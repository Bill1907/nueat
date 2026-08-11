import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { ApiError } from '@/api/client';
import {
  getNextMealRecommendation,
  type NextMealCandidate,
  type NextMealRecommendation,
  type RecommendationRationaleFact,
} from '@/api/recommendations';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export function NextMealRecommendations({ refreshGeneration }: { refreshGeneration: number }) {
  const theme = useTheme();
  const [recommendation, setRecommendation] = useState<NextMealRecommendation | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestEpoch = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const previousRefreshGeneration = useRef(refreshGeneration);

  const load = useCallback(async () => {
    const epoch = ++requestEpoch.current;
    controller.current?.abort();
    const nextController = new AbortController();
    controller.current = nextController;
    setLoading(true);
    setError(null);
    setRecommendation(null);

    try {
      const response = await getNextMealRecommendation(nextController.signal);
      if (requestEpoch.current === epoch) setRecommendation(response);
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') return;
      if (requestEpoch.current === epoch) {
        setError(
          cause instanceof ApiError && cause.code === 'NUTRITION_TARGET_UNAVAILABLE'
            ? '현재 적용할 영양 목표가 없어 추천을 만들 수 없어요. 목표를 설정한 뒤 다시 계산해 주세요.'
            : '다음 식사 추천을 불러오지 못했습니다. 잠시 후 다시 계산해 주세요.',
        );
      }
    } finally {
      if (requestEpoch.current === epoch) setLoading(false);
    }
  }, []);

  useEffect(() => () => {
    requestEpoch.current += 1;
    controller.current?.abort();
  }, []);

  useEffect(() => {
    if (previousRefreshGeneration.current === refreshGeneration) return;
    previousRefreshGeneration.current = refreshGeneration;
    requestEpoch.current += 1;
    controller.current?.abort();
    controller.current = null;
    setLoading(false);
    setError(null);
    setRecommendation(null);
  }, [refreshGeneration]);

  const hasSafetyFlags = (recommendation?.safetyFlags.length ?? 0) > 0;
  const safetyMessage = recommendation ? getSafetyMessage(recommendation.safetyFlags) : null;

  return (
    <ThemedView surface="raised" style={styles.section} accessibilityLabel="다음 식사 추천">
      <View style={styles.heading}>
        <View style={styles.headingCopy}>
          <ThemedText type="subtitle">다음 식사 추천</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            오늘의 기록과 목표를 기준으로 계산해요.
          </ThemedText>
        </View>
        {recommendation && !loading && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="다음 식사 추천 다시 계산"
            onPress={() => void load()}
            style={({ pressed }) => [styles.recalculate, { borderColor: theme.border }, pressed && styles.pressed]}
          >
            <ThemedText type="smallBold" style={{ color: theme.primary }}>다시 계산</ThemedText>
          </Pressable>
        )}
      </View>

      {!recommendation && !loading && !error && (
        <ActionButton label="다음 식사 추천 받기" onPress={() => void load()} />
      )}
      {loading && (
        <ThemedView surface="inset" style={styles.status} accessibilityRole="progressbar" accessibilityLabel="다음 식사 추천 계산 중">
          <ThemedText themeColor="textSecondary">추천을 계산하고 있어요.</ThemedText>
        </ThemedView>
      )}
      {error && !loading && (
        <ThemedView surface="inset" style={styles.status}>
          <ThemedText accessibilityRole="alert" style={{ color: theme.danger }}>{error}</ThemedText>
          <ActionButton label="다시 계산" onPress={() => void load()} />
        </ThemedView>
      )}
      {recommendation && !loading && safetyMessage && (
        <SafetyNotice text={safetyMessage} />
      )}
      {recommendation && !loading && !hasSafetyFlags && recommendation.candidates.length === 0 && (
        <ThemedView surface="inset" style={styles.status}>
          <ThemedText type="smallBold">지금은 추천할 식사가 없어요.</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">오늘의 목표와 기록을 확인한 뒤 다시 계산해 보세요.</ThemedText>
        </ThemedView>
      )}
      {recommendation && !loading && !hasSafetyFlags && recommendation.candidates.map((candidate) => (
        <CandidateCard key={`${recommendation.recommendationId}-${candidate.rank}`} candidate={candidate} />
      ))}
    </ThemedView>
  );
}

function ActionButton({ label, onPress }: { label: string; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.actionButton, { backgroundColor: theme.primary }, pressed && styles.pressed]}
    >
      <ThemedText type="smallBold" style={{ color: theme.onPrimary }}>{label}</ThemedText>
    </Pressable>
  );
}

function SafetyNotice({ text }: { text: string }) {
  const theme = useTheme();
  return (
    <ThemedView
      surface="inset"
      style={styles.status}
      accessibilityRole="alert"
      accessibilityLabel={`안전 확인이 필요해요. ${text}`}
    >
      <ThemedText type="smallBold" style={{ color: theme.danger }}>안전 확인이 필요해요</ThemedText>
      <ThemedText type="small" themeColor="textSecondary">{text}</ThemedText>
    </ThemedView>
  );
}

function getSafetyMessage(safetyFlags: string[]) {
  if (safetyFlags.length === 0) return null;
  if (safetyFlags.includes('UNRESOLVED_DIETARY_CONSTRAINT')) {
    return '알레르기 또는 제외 식품 정보가 명확하지 않아 안전을 위해 추천을 표시하지 않아요. 정보를 확인한 뒤 다시 계산해 주세요.';
  }
  if (safetyFlags.includes('CALCULATION_SNAPSHOT_UNAVAILABLE')) {
    return '신뢰할 수 있는 영양 계산 정보를 확인하지 못해 추천을 표시하지 않아요. 잠시 후 다시 계산해 주세요.';
  }
  return '안전 조건을 확인하지 못해 추천을 표시하지 않아요. 잠시 후 다시 계산해 주세요.';
}

function CandidateCard({ candidate }: { candidate: NextMealCandidate }) {
  const theme = useTheme();
  const facts = candidate.rationaleFacts
    .filter(isMeaningfulRationale)
    .slice(0, 2)
    .map(rationaleCopy);
  return (
    <View style={[styles.candidate, { backgroundColor: theme.surfaceInset, borderColor: theme.border }]} accessibilityLabel={`${candidate.rank}순위 ${candidate.titleKo}`}>
      <View style={styles.candidateHeader}>
        <ThemedText type="smallBold" style={styles.rank}>{candidate.rank}순위</ThemedText>
        <ThemedText type="subtitle" style={styles.candidateTitle}>{candidate.titleKo}</ThemedText>
      </View>
      <ThemedText type="small" themeColor="textSecondary">
        {candidate.components.map((component) => `${component.nameKo} ${formatGrams(component.gramsMg)}`).join(' · ')}
      </ThemedText>
      <View style={styles.nutritionRow}>
        <NutritionValue label="열량" value={formatKcal(candidate.nutrition.energyMillicalories)} />
        <NutritionValue label="단백질" value={formatGrams(candidate.nutrition.proteinMg)} />
        <NutritionValue label="식이섬유" value={formatGrams(candidate.nutrition.fiberMg)} />
      </View>
      {facts.map((fact) => <ThemedText key={fact} type="small" themeColor="textSecondary">{fact}</ThemedText>)}
      {candidate.warnings.includes('CALORIE_TARGET_OVERAGE') && (
        <ThemedText type="small" style={{ color: theme.warning }}>
          이 식사를 선택하면 일일 목표 열량을 넘을 수 있어요.
        </ThemedText>
      )}
      <View style={[styles.badge, { borderColor: theme.border }]} accessibilityLabel="공식 영양 DB 계산">
        <ThemedText type="smallBold" style={{ color: theme.primary }}>공식 영양 DB 계산</ThemedText>
      </View>
    </View>
  );
}

function NutritionValue({ label, value }: { label: string; value: string }) {
  return <View style={styles.nutritionValue}><ThemedText type="small" themeColor="textSecondary">{label}</ThemedText><ThemedText type="smallBold">{value}</ThemedText></View>;
}

function isMeaningfulRationale(fact: RecommendationRationaleFact) {
  if (fact.scoreBps <= 0) return false;
  switch (fact.code) {
    case 'PROTEIN_GAP':
    case 'FIBER_GAP':
      return fact.remainingMg !== null && fact.remainingMg > 0;
    case 'ENERGY_FIT':
      return fact.projectedEnergyMillicalories !== null;
    case 'RECENT_FOOD_DIVERSITY':
      return !fact.hasRecentFood;
  }
}

function rationaleCopy(fact: RecommendationRationaleFact) {
  switch (fact.code) {
    case 'PROTEIN_GAP': return '단백질 부족분을 채우는 데 도움이 돼요.';
    case 'FIBER_GAP': return '식이섬유 부족분을 채우는 데 도움이 돼요.';
    case 'ENERGY_FIT': return '남은 열량 목표에 맞춰 계산했어요.';
    case 'RECENT_FOOD_DIVERSITY': return '최근 식사와 겹치지 않도록 골랐어요.';
    default: return '현재 목표와 최근 식사를 기준으로 계산했어요.';
  }
}

function formatKcal(value: number | null) {
  return value === null ? '정보 없음' : `${new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 0 }).format(value / 1000)} kcal`;
}

function formatGrams(value: number | null) {
  return value === null ? '정보 없음' : `${new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 1 }).format(value / 1000)} g`;
}

const styles = StyleSheet.create({
  section: { gap: Spacing.three, padding: Spacing.four },
  heading: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  headingCopy: { flex: 1, gap: Spacing.half },
  recalculate: { minHeight: 44, justifyContent: 'center', borderWidth: 1, borderRadius: 14, paddingHorizontal: Spacing.three },
  actionButton: { minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 14, paddingHorizontal: Spacing.three },
  status: { gap: Spacing.two, padding: Spacing.three },
  candidate: { gap: Spacing.two, borderWidth: 1, borderRadius: 18, padding: Spacing.three },
  candidateHeader: { flexDirection: 'row', alignItems: 'baseline', gap: Spacing.two },
  rank: { minWidth: 38 },
  candidateTitle: { flex: 1 },
  nutritionRow: { flexDirection: 'row', gap: Spacing.two },
  nutritionValue: { flex: 1, gap: Spacing.half },
  badge: { alignSelf: 'flex-start', borderWidth: 1, borderRadius: 999, paddingHorizontal: Spacing.two, paddingVertical: Spacing.one },
  pressed: { opacity: 0.7 },
});
