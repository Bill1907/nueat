import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { apiRequest } from '@/api/client';
import {
  formatGrams,
  formatKilocalories,
  goalLabel,
  limitedReasonLabel,
} from '@/components/nutrition-target-display';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

type TargetResponse =
  | { status: 'pending' }
  | { status: 'limited'; reasons: string[] }
  | {
      status: 'active';
      profile: {
        goalType: string;
        calorieTargetMillicalories: number;
        carbohydrateTargetMg: number;
        proteinTargetMg: number;
        fatTargetMg: number;
        fiberTargetMg: number;
        engineVersion: string;
      };
    };

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; result: TargetResponse };

export function ActiveNutritionTargetCard() {
  const [loadState, setLoadState] = useState<LoadState>({ status: 'loading' });
  const [reload, setReload] = useState(0);
  const theme = useTheme();

  useEffect(() => {
    let active = true;
    void apiRequest<TargetResponse>('/api/nutrition-targets/active')
      .then((result) => {
        if (active) setLoadState({ status: 'loaded', result });
      })
      .catch((cause) => {
        if (!active) return;
        setLoadState({
          status: 'error',
          message: cause instanceof Error ? cause.message : '목표를 불러오지 못했습니다.',
        });
      });
    return () => {
      active = false;
    };
  }, [reload]);

  if (loadState.status === 'loading') {
    return (
      <Card badge="불러오는 중">
        <View style={styles.loadingRow}>
          <ActivityIndicator color={theme.primary} />
          <ThemedText type="small" themeColor="textSecondary">
            저장된 영양 목표를 확인하고 있어요.
          </ThemedText>
        </View>
      </Card>
    );
  }

  if (loadState.status === 'error') {
    return (
      <Card badge="확인 필요" badgeTone="warning">
        <ThemedText type="small" themeColor="textSecondary">
          {loadState.message}
        </ThemedText>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="영양 목표 다시 불러오기"
          onPress={() => {
            setLoadState({ status: 'loading' });
            setReload((value) => value + 1);
          }}
          style={({ pressed }) => [
            styles.retryButton,
            {
              backgroundColor: theme.surfaceInset,
              borderColor: theme.primary,
              shadowColor: theme.shadow,
            },
            pressed && styles.pressed,
          ]}>
          <ThemedText type="smallBold" style={{ color: theme.primary }}>
            다시 시도
          </ThemedText>
        </Pressable>
      </Card>
    );
  }

  const { result } = loadState;
  if (result.status === 'limited') {
    return (
      <Card badge="안전 모드" badgeTone="warning">
        <ThemedText style={styles.title}>자동 영양 목표가 제한되었어요</ThemedText>
        <View style={styles.stack}>
          {result.reasons.map((reason) => (
            <ThemedText key={reason} type="small" themeColor="textSecondary">
              • {limitedReasonLabel(reason)}
            </ThemedText>
          ))}
        </View>
      </Card>
    );
  }

  if (result.status === 'pending') {
    return (
      <Card badge="설정 전" badgeTone="warning">
        <ThemedText style={styles.title}>목표 프로필을 먼저 설정해 주세요</ThemedText>
      </Card>
    );
  }

  const { profile } = result;
  return (
    <Card badge="설정 완료">
      <ThemedText style={styles.title}>{goalLabel(profile.goalType)} 목표</ThemedText>
      <View style={styles.targetGrid}>
        <TargetValue label="열량" value={formatKilocalories(profile.calorieTargetMillicalories)} />
        <TargetValue label="단백질" value={formatGrams(profile.proteinTargetMg)} />
        <TargetValue label="식이섬유" value={formatGrams(profile.fiberTargetMg)} />
        <TargetValue label="탄수화물" value={formatGrams(profile.carbohydrateTargetMg)} />
        <TargetValue label="지방" value={formatGrams(profile.fatTargetMg)} />
      </View>
      <ThemedText type="small" themeColor="textSecondary">
        계산 엔진 {profile.engineVersion}
      </ThemedText>
    </Card>
  );
}

function Card({
  badge,
  badgeTone = 'success',
  children,
}: {
  badge: string;
  badgeTone?: 'success' | 'warning';
  children: React.ReactNode;
}) {
  const theme = useTheme();
  const isWarning = badgeTone === 'warning';

  return (
    <ThemedView surface="raised" style={styles.card}>
      <View style={styles.header}>
        <ThemedText type="smallBold">내 영양 목표</ThemedText>
        <View
          style={[
            styles.badge,
            {
              backgroundColor: isWarning ? theme.warningSurface : theme.successSurface,
              borderColor: isWarning ? theme.warning : theme.primary,
            },
          ]}>
          <ThemedText
            type="smallBold"
            style={{ color: isWarning ? theme.warning : theme.primary }}>
            {badge}
          </ThemedText>
        </View>
      </View>
      {children}
    </ThemedView>
  );
}

function TargetValue({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.targetValue}>
      <ThemedText type="small" themeColor="textSecondary">
        {label}
      </ThemedText>
      <ThemedText type="smallBold">{value}</ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: Spacing.four,
    borderRadius: Radius.surface,
    gap: Spacing.three,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  badge: {
    borderRadius: Radius.pill,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  title: {
    fontSize: 20,
    lineHeight: 28,
    fontWeight: '700',
  },
  targetGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    rowGap: Spacing.three,
  },
  targetValue: {
    width: '33.333%',
    gap: Spacing.half,
  },
  stack: {
    gap: Spacing.one,
  },
  loadingRow: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  retryButton: {
    minHeight: 44,
    alignSelf: 'flex-start',
    justifyContent: 'center',
    paddingHorizontal: Spacing.three,
    borderRadius: Radius.control,
    borderWidth: 1,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.12,
    shadowRadius: 6,
    elevation: 2,
  },
  pressed: {
    transform: [{ translateY: 1 }],
    opacity: 0.82,
  },
});
