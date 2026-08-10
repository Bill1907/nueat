import type { ReactNode } from 'react';
import { Platform, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { NutritionStandardCard } from '@/components/nutrition-standard-card';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

const ACTIVITY_LEVELS = [
  ['비활동적', '남 1.00 · 여 1.00'],
  ['저활동적', '남 1.11 · 여 1.12'],
  ['활동적', '남 1.25 · 여 1.27'],
  ['매우 활동적', '남 1.48 · 여 1.45'],
] as const;

const GOAL_ADJUSTMENTS = [
  ['균형 식사·유지', '필요추정량 유지'],
  ['체중 감량', '15% 감량 · 최대 500 kcal'],
  ['근육 증가', '8% 증가 · 최대 300 kcal'],
] as const;

export default function NutritionBasisScreen() {
  const insets = useSafeAreaInsets();
  const theme = useTheme();

  return (
    <ScrollView
      style={[styles.scrollView, { backgroundColor: theme.background }]}
      contentContainerStyle={[
        styles.content,
        {
          paddingTop: Platform.OS === 'web' ? 96 : insets.top + Spacing.four,
          paddingBottom: insets.bottom + BottomTabInset + Spacing.four,
        },
      ]}>
      <ThemedView style={styles.container}>
        <View style={styles.header}>
          <ThemedText type="subtitle">목표 계산 기준</ThemedText>
          <ThemedText themeColor="textSecondary">
            NUEAT이 목표를 어떻게 계산하고 언제 자동 계산을 제한하는지 확인할 수 있어요.
          </ThemedText>
        </View>

        <NutritionStandardCard />

        <PolicySection title="에너지 필요추정량">
          <ThemedText type="small" themeColor="textSecondary">
            나이, 계산상 성별, 신장, 체중과 활동계수를 2025 KDRI 성인 산출식에 적용합니다.
            계산상 성별은 공식 산출식 선택에만 사용합니다.
          </ThemedText>
          {ACTIVITY_LEVELS.map(([label, value]) => (
            <PolicyRow key={label} label={label} value={value} />
          ))}
        </PolicySection>

        <PolicySection title="목표별 조정">
          {GOAL_ADJUSTMENTS.map(([label, value]) => (
            <PolicyRow key={label} label={label} value={value} />
          ))}
          <ThemedText type="small" themeColor="textSecondary">
            감량 목표는 여성 1,200 kcal, 남성 1,500 kcal보다 낮게 자동 설정하지 않습니다.
          </ThemedText>
        </PolicySection>

        <PolicySection title="매크로와 식이섬유">
          <PolicyRow label="균형·유지·근육 증가" value="탄 55% · 단 20% · 지 25%" />
          <PolicyRow label="체중 감량" value="탄 50% · 단 20% · 지 30%" />
          <PolicyRow label="식이섬유" value="KDRI 연령·성별 충분섭취량" />
        </PolicySection>

        <PolicySection title="자동 계산 제한">
          <ThemedText type="small" themeColor="textSecondary">
            미성년자, 임신·수유, 섭식장애 위험, 임상 영양 관리, 저체중 감량, 75세 이상
            체중 변경 목표는 자동 코칭 대신 제한 모드와 전문가 안내를 제공합니다.
          </ThemedText>
        </PolicySection>

        <ThemedText type="small" themeColor="textSecondary" style={styles.disclaimer}>
          이 목표는 일반 웰니스를 위한 추정치이며 의료 진단이나 처방이 아닙니다. 프로필을
          변경하면 이후 목표만 새 버전으로 계산되고 과거 기록은 유지됩니다.
        </ThemedText>
      </ThemedView>
    </ScrollView>
  );
}

function PolicySection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <ThemedView type="backgroundElement" style={styles.section}>
      <ThemedText style={styles.sectionTitle}>{title}</ThemedText>
      {children}
    </ThemedView>
  );
}

function PolicyRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <ThemedText type="small">{label}</ThemedText>
      <ThemedText type="smallBold" style={styles.rowValue}>
        {value}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  scrollView: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
    alignItems: 'center',
    paddingHorizontal: Spacing.four,
  },
  container: {
    width: '100%',
    maxWidth: MaxContentWidth,
    gap: Spacing.four,
  },
  header: {
    gap: Spacing.two,
    paddingBottom: Spacing.two,
  },
  section: {
    padding: Spacing.four,
    borderRadius: 20,
    gap: Spacing.three,
  },
  sectionTitle: {
    fontSize: 18,
    lineHeight: 26,
    fontWeight: '700',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: Spacing.three,
  },
  rowValue: {
    flexShrink: 1,
    textAlign: 'right',
  },
  disclaimer: {
    paddingHorizontal: Spacing.two,
  },
});
