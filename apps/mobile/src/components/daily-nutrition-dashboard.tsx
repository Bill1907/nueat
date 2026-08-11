import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Pressable, StyleSheet, View } from 'react-native';

import {
  getDailyDashboard,
  type DailyDashboard,
  type DailyMeal,
  type DailyNutritionTotals,
} from '@/api/daily-dashboard';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

type Props = {
  refreshGeneration: number;
  onLoadComplete?: () => void;
};

export function DailyNutritionDashboard({ refreshGeneration, onLoadComplete }: Props) {
  const theme = useTheme();
  const [dashboard, setDashboard] = useState<DailyDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const requestEpoch = useRef(0);
  const controller = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    const epoch = ++requestEpoch.current;
    controller.current?.abort();
    const nextController = new AbortController();
    controller.current = nextController;
    setLoading(true);
    setError(null);
    try {
      const response = await getDailyDashboard(undefined, nextController.signal);
      if (requestEpoch.current !== epoch) return;
      setDashboard(response);
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') return;
      if (requestEpoch.current === epoch) {
        setError('오늘의 영양 현황을 불러오지 못했습니다.');
      }
    } finally {
      if (requestEpoch.current === epoch) {
        setLoading(false);
        onLoadComplete?.();
      }
    }
  }, [onLoadComplete]);

  useEffect(() => {
    const task = setTimeout(() => void load(), 0);
    return () => {
      clearTimeout(task);
      requestEpoch.current += 1;
      controller.current?.abort();
    };
  }, [load, refreshGeneration]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void load();
    });
    return () => subscription.remove();
  }, [load]);

  if (loading && !dashboard) {
    return <DashboardShell><ThemedText themeColor="textSecondary">오늘의 영양 현황을 불러오는 중이에요.</ThemedText></DashboardShell>;
  }

  if (error && !dashboard) {
    return (
      <DashboardShell>
        <ThemedText accessibilityRole="alert" style={{ color: theme.danger }}>
          {error}
        </ThemedText>
        <RetryButton onPress={() => void load()} />
      </DashboardShell>
    );
  }

  if (!dashboard) return null;
  const { target, totals, meals } = dashboard;
  const energyTarget = target?.energyMillicalories ?? null;
  const consumedEnergy = totals.energyMillicalories;
  const remainingEnergy = energyTarget === null ? null : energyTarget - consumedEnergy;

  return (
    <View style={styles.section} accessibilityLabel="오늘의 영양 대시보드">
      <View style={styles.titleRow}>
        <View style={styles.titleCopy}>
          <ThemedText type="subtitle">오늘의 영양</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">{formatDate(dashboard.date)} · {dashboard.timezone}</ThemedText>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="오늘의 영양 현황 새로고침"
          onPress={() => void load()}
          style={({ pressed }) => [styles.refreshButton, { borderColor: theme.border }, pressed && styles.pressed]}
        >
          <ThemedText type="smallBold" style={{ color: theme.primary }}>새로고침</ThemedText>
        </Pressable>
      </View>

      {target === null ? (
        <DashboardShell>
          <ThemedText type="smallBold">{targetStatusCopy(dashboard).title}</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            {targetStatusCopy(dashboard).description}
          </ThemedText>
          <ConsumedSummary totals={totals} />
          <MealTimeline meals={meals} timezone={dashboard.timezone} />
        </DashboardShell>
      ) : (
        <>
          <View style={[styles.hero, { backgroundColor: theme.surfaceRaised, borderColor: theme.highlight, shadowColor: theme.shadow }]}>
            <View style={[styles.highlightEdge, { backgroundColor: theme.highlight }]} />
            <ThemedText type="smallBold" style={{ color: theme.primary }}>열량</ThemedText>
            <View style={styles.energyRow}>
              <ThemedText style={styles.energyValue}>{formatKcal(consumedEnergy)}</ThemedText>
              <ThemedText type="small" themeColor="textSecondary">/ {formatKcal(target.energyMillicalories)}</ThemedText>
            </View>
            <ProgressBar value={consumedEnergy} target={target.energyMillicalories} />
            <ThemedText type="small" themeColor="textSecondary">
              {remainingEnergy === null ? '' : remainingEnergy >= 0 ? `${formatKcal(remainingEnergy)} 남음` : `${formatKcal(-remainingEnergy)} 초과`}
            </ThemedText>
            <ThemedText type="smallBold" style={{ color: theme.text }}>{gapCopy(target, totals)}</ThemedText>
          </View>

          <View style={styles.compactRow}>
            <NutrientCard label="단백질" value={totals.proteinMg} target={target.proteinMg} />
            <NutrientCard
              label="식이섬유"
              value={totals.fiberKnownMg}
              target={target.fiberMg}
              detail={totals.fiberComplete ? undefined : '일부 항목의 식이섬유 정보가 없어 확인 가능한 값만 표시해요.'}
              knownOnly={!totals.fiberComplete}
            />
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={expanded ? '탄수화물과 지방 접기' : '탄수화물과 지방 펼치기'}
            accessibilityState={{ expanded }}
            onPress={() => setExpanded((current) => !current)}
            style={({ pressed }) => [styles.expandControl, { backgroundColor: theme.surfaceInset, borderColor: theme.border }, pressed && styles.pressed]}
          >
            <ThemedText type="smallBold">탄수화물 · 지방</ThemedText>
            <ThemedText type="small" style={{ color: theme.primary }}>{expanded ? '접기' : '보기'}</ThemedText>
          </Pressable>
          {expanded && (
            <View style={styles.compactRow}>
              <NutrientCard label="탄수화물" value={totals.carbohydrateMg} target={target.carbohydrateMg} />
              <NutrientCard label="지방" value={totals.fatMg} target={target.fatMg} />
            </View>
          )}
          <MealTimeline meals={meals} timezone={dashboard.timezone} />
        </>
      )}
      {error && <ThemedText accessibilityRole="alert" type="small" style={{ color: theme.danger }}>{error}</ThemedText>}
    </View>
  );
}

function DashboardShell({ children }: { children: React.ReactNode }) {
  const theme = useTheme();
  return <View style={[styles.shell, { backgroundColor: theme.surfaceRaised, borderColor: theme.border }]}>{children}</View>;
}

function NutrientCard({
  label,
  value,
  target,
  detail,
  knownOnly = false,
}: {
  label: string;
  value: number;
  target: number;
  detail?: string;
  knownOnly?: boolean;
}) {
  const theme = useTheme();
  return (
    <View style={[styles.nutrientCard, { backgroundColor: theme.surfaceRaised, borderColor: theme.border, shadowColor: theme.shadow }]}>
      <ThemedText type="smallBold">{label}</ThemedText>
      <ThemedText style={styles.nutrientValue}>
        {knownOnly ? `확인 ${formatGrams(value)}` : formatGrams(value)}
      </ThemedText>
      {!knownOnly && <ProgressBar value={value} target={target} />}
      <ThemedText type="small" themeColor="textSecondary">{detail ?? `${formatGrams(Math.max(target - value, 0))} 남음`}</ThemedText>
    </View>
  );
}

function ProgressBar({ value, target }: { value: number; target: number }) {
  const theme = useTheme();
  const width: `${number}%` = target > 0 ? `${Math.min((value / target) * 100, 100)}%` : '0%';
  return <View accessibilityLabel={`${Math.round(target > 0 ? (value / target) * 100 : 0)}퍼센트 달성`} style={[styles.track, { backgroundColor: theme.surfaceInset }]}><View style={[styles.fill, { width, backgroundColor: theme.primaryAccent }]} /></View>;
}

function MealTimeline({ meals, timezone }: { meals: DailyMeal[]; timezone: string }) {
  const theme = useTheme();
  return (
    <View style={styles.timeline}>
      <ThemedText type="smallBold">확정한 식사</ThemedText>
      {meals.length === 0 ? (
        <ThemedText type="small" themeColor="textSecondary">아직 확정한 식사가 없어요. 사진에서 음식을 확인해 기록해 보세요.</ThemedText>
      ) : meals.map((meal) => (
        <View key={meal.id} style={[styles.meal, { borderColor: theme.border }]} accessibilityLabel={`${mealTypeLabel(meal.mealType)} ${meal.itemLabels.join(', ')}`}>
          <View style={[styles.mealDot, { backgroundColor: theme.primary }]} />
          <View style={styles.mealCopy}>
            <ThemedText type="smallBold">{mealTypeLabel(meal.mealType)} · {formatTime(meal.eatenAt, timezone)}</ThemedText>
            <ThemedText numberOfLines={2} type="small" themeColor="textSecondary">{meal.itemLabels.join(', ') || '음식 항목'}</ThemedText>
          </View>
          <View style={styles.mealValue}>
            <ThemedText type="smallBold">{formatKcal(meal.totals.energyMillicalories)}</ThemedText>
            <ThemedText type="small" style={{ color: meal.qualityGrade === 'verified' ? theme.primary : theme.warning }}>{meal.qualityGrade === 'verified' ? '확인됨' : '추정'}</ThemedText>
          </View>
        </View>
      ))}
    </View>
  );
}

function RetryButton({ onPress }: { onPress: () => void }) {
  const theme = useTheme();
  return <Pressable accessibilityRole="button" accessibilityLabel="오늘의 영양 현황 다시 시도" onPress={onPress} style={({ pressed }) => [styles.retry, { backgroundColor: theme.primary }, pressed && styles.pressed]}><ThemedText type="smallBold" style={{ color: theme.onPrimary }}>다시 시도</ThemedText></Pressable>;
}

function ConsumedSummary({ totals }: { totals: DailyNutritionTotals }) {
  return (
    <View style={styles.summaryGrid}>
      <SummaryValue label="섭취 열량" value={formatKcal(totals.energyMillicalories)} />
      <SummaryValue label="단백질" value={formatGrams(totals.proteinMg)} />
      <SummaryValue
        label="식이섬유"
        value={`${totals.fiberComplete ? '' : '확인 '}${formatGrams(totals.fiberKnownMg)}`}
      />
    </View>
  );
}

function SummaryValue({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.summaryValue}>
      <ThemedText type="small" themeColor="textSecondary">{label}</ThemedText>
      <ThemedText type="smallBold">{value}</ThemedText>
    </View>
  );
}

function targetStatusCopy(dashboard: DailyDashboard) {
  if (dashboard.targetStatus === 'limited') {
    return {
      title: '안전 모드가 적용 중이에요',
      description: '자동 목표 계산은 제한되어 있지만 확정한 섭취량은 그대로 확인할 수 있어요.',
    };
  }
  if (dashboard.targetStatus === 'pending') {
    return {
      title: '영양 목표 설정이 필요해요',
      description: '온보딩을 완료하면 섭취량과 남은 목표를 함께 안내해 드려요.',
    };
  }
  return {
    title: '이 날짜에 적용된 목표가 없어요',
    description: '확정한 섭취량은 확인할 수 있지만 남은 목표는 계산하지 않아요.',
  };
}

function gapCopy(target: NonNullable<DailyDashboard['target']>, totals: DailyNutritionTotals) {
  const protein = target.proteinMg - totals.proteinMg;
  if (protein > 0) return `단백질 ${formatGrams(protein)}을 더 채워 보세요.`;
  if (!totals.fiberComplete) return '식이섬유는 확인 가능한 값만 반영했어요.';
  const fiber = target.fiberMg - totals.fiberKnownMg;
  if (fiber > 0) return `식이섬유 ${formatGrams(fiber)}을 더 채워 보세요.`;
  const energy = target.energyMillicalories - totals.energyMillicalories;
  return energy >= 0 ? '핵심 영양 목표를 잘 채우고 있어요.' : '다음 식사는 가볍게 선택해 보세요.';
}

function formatKcal(value: number) { return `${new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 0 }).format(value / 1000)} kcal`; }
function formatGrams(value: number) { return `${new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 1 }).format(value / 1000)} g`; }
function formatDate(value: string) { return value.replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$2월 $3일'); }
function formatTime(value: string, timezone: string) { return new Intl.DateTimeFormat('ko-KR', { hour: 'numeric', minute: '2-digit', timeZone: timezone }).format(new Date(value)); }
function mealTypeLabel(value: string) { return ({ breakfast: '아침', lunch: '점심', dinner: '저녁', snack: '간식' } as Record<string, string>)[value] ?? '식사'; }

const styles = StyleSheet.create({
  section: { gap: Spacing.three }, titleRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two }, titleCopy: { flex: 1, gap: Spacing.half }, refreshButton: { minHeight: 44, justifyContent: 'center', paddingHorizontal: Spacing.three, borderWidth: 1, borderRadius: 14 }, shell: { gap: Spacing.two, borderWidth: 1, borderRadius: 20, padding: Spacing.three }, hero: { overflow: 'hidden', gap: Spacing.two, borderWidth: 1, borderRadius: 24, padding: Spacing.four, shadowOffset: { width: 0, height: 5 }, shadowOpacity: 0.18, shadowRadius: 8, elevation: 4 }, highlightEdge: { position: 'absolute', top: 0, left: 18, right: 18, height: 2, borderBottomLeftRadius: 999, borderBottomRightRadius: 999 }, energyRow: { flexDirection: 'row', alignItems: 'baseline', gap: Spacing.one }, energyValue: { fontSize: 30, lineHeight: 38, fontWeight: '800' }, track: { height: 10, overflow: 'hidden', borderRadius: 999 }, fill: { height: '100%', borderRadius: 999 }, compactRow: { flexDirection: 'row', gap: Spacing.two }, nutrientCard: { flex: 1, gap: Spacing.one, borderWidth: 1, borderRadius: 18, padding: Spacing.three, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.12, shadowRadius: 5, elevation: 2 }, nutrientValue: { fontSize: 20, lineHeight: 27, fontWeight: '800' }, expandControl: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1, borderRadius: 16, paddingHorizontal: Spacing.three }, timeline: { gap: Spacing.two, paddingTop: Spacing.one }, meal: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two, borderTopWidth: 1, paddingTop: Spacing.two }, mealDot: { width: 9, height: 9, borderRadius: 999 }, mealCopy: { flex: 1, gap: Spacing.half }, mealValue: { alignItems: 'flex-end', gap: Spacing.half }, retry: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center', borderRadius: 14, paddingHorizontal: Spacing.three }, retryText: { color: '#FFFFFF' }, pressed: { opacity: 0.7 },
  summaryGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two, paddingTop: Spacing.one },
  summaryValue: { minWidth: 96, flexGrow: 1, gap: Spacing.half },
});
