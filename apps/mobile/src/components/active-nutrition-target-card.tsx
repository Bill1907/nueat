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
import { Spacing } from '@/constants/theme';

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
          <ActivityIndicator color="#16794A" />
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
          style={styles.retryButton}>
          <ThemedText type="smallBold" style={styles.retryText}>
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
  return (
    <ThemedView type="backgroundElement" style={styles.card}>
      <View style={styles.header}>
        <ThemedText type="smallBold">내 영양 목표</ThemedText>
        <View style={[styles.badge, badgeTone === 'warning' && styles.warningBadge]}>
          <ThemedText
            type="smallBold"
            style={badgeTone === 'warning' ? styles.warningText : styles.successText}>
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
    borderRadius: 20,
    gap: Spacing.three,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  badge: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: '#E7F4EC',
  },
  warningBadge: {
    backgroundColor: '#FFF1D6',
  },
  successText: {
    color: '#16794A',
  },
  warningText: {
    color: '#8A5A00',
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
  },
  retryText: {
    color: '#16794A',
  },
});
