import { useState, type ReactNode } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
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
          <ThemedText type="subtitle">계산 기준</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            목표의 계산식, 적용 기준과 자동 계산 제한을 확인합니다.
          </ThemedText>
        </View>

        <NutritionStandardCard />

        <PolicySection title="에너지 산출식 · 활동계수">
          <ThemedText type="small" themeColor="textSecondary">
            나이, 계산상 성별, 신장, 체중과 활동계수를 2025 KDRI 성인 산출식에 적용합니다.
            계산상 성별은 공식 산출식 선택에만 사용합니다.
          </ThemedText>
          {ACTIVITY_LEVELS.map(([label, value]) => (
            <PolicyRow key={label} label={label} value={value} />
          ))}
        </PolicySection>

        <PolicySection title="목표별 에너지 조정">
          {GOAL_ADJUSTMENTS.map(([label, value]) => (
            <PolicyRow key={label} label={label} value={value} />
          ))}
          <ThemedText type="small" themeColor="textSecondary">
            감량 목표는 여성 1,200 kcal, 남성 1,500 kcal보다 낮게 자동 설정하지 않습니다.
          </ThemedText>
        </PolicySection>

        <PolicySection title="매크로 · 식이섬유 정책">
          <PolicyRow label="균형·유지·근육 증가" value="탄수화물 55% · 단백질 20% · 지방 25%" />
          <PolicyRow label="체중 감량" value="탄수화물 50% · 단백질 20% · 지방 30%" />
          <PolicyRow label="식이섬유" value="KDRI 연령·성별 충분섭취량" />
        </PolicySection>

        <PolicySection title="자동 계산 제한">
          <ThemedText type="small" themeColor="textSecondary">
            미성년자, 임신·수유, 섭식장애 위험, 임상 영양 관리, 계산상 성별 또는 유효한
            신체 정보 미입력, 매우 높은 활동량, 저체중 감량, 75세 이상 체중 변경 목표는
            자동 코칭 대신 제한 모드와 전문가 안내를 제공합니다.
          </ThemedText>
        </PolicySection>

        <ThemedText type="small" themeColor="textSecondary" style={styles.disclaimer}>
          일반 웰니스를 위한 추정치이며 의료 진단이나 처방이 아닙니다. 프로필을 변경하면
          이후 목표만 새 버전으로 계산되고 과거 기록은 유지됩니다.
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
  const [expanded, setExpanded] = useState(false);

  return (
    <ThemedView surface="inset" style={styles.section}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${title} ${expanded ? '접기' : '펼치기'}`}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((current) => !current)}
        style={({ pressed }) => [styles.sectionControl, pressed && styles.pressed]}>
        <ThemedText type="smallBold" style={styles.sectionTitle}>
          {title}
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          {expanded ? '접기' : '보기'}
        </ThemedText>
      </Pressable>
      {expanded ? <View style={styles.sectionContent}>{children}</View> : null}
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
    gap: Spacing.two,
    overflow: 'hidden',
  },
  sectionControl: {
    minHeight: 44,
    paddingHorizontal: Spacing.three,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  sectionTitle: {
    flex: 1,
  },
  sectionContent: {
    gap: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.three,
  },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  rowValue: {
    flexShrink: 1,
    textAlign: 'right',
  },
  disclaimer: {
    paddingHorizontal: Spacing.two,
  },
  pressed: {
    opacity: 0.72,
  },
});
