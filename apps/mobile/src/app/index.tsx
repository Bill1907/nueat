import { Platform, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { NutritionStandardCard } from '@/components/nutrition-standard-card';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export default function HomeScreen() {
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
          <ThemedText style={styles.brand}>NUEAT</ThemedText>
          <ThemedText type="subtitle">오늘, 무엇을 먹을까요?</ThemedText>
          <ThemedText themeColor="textSecondary">
            기록을 시작하면 오늘의 영양 격차와 다음 식사 선택지를 알려드려요.
          </ThemedText>
        </View>

        <ThemedView type="backgroundElement" style={styles.goalCard}>
          <View style={styles.goalHeader}>
            <ThemedText type="smallBold">내 영양 목표</ThemedText>
            <View style={styles.pendingBadge}>
              <ThemedText type="smallBold" style={styles.pendingText}>
                설정 전
              </ThemedText>
            </View>
          </View>
          <ThemedText style={styles.goalTitle}>목표 프로필을 먼저 설정해 주세요</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            나이, 신장, 체중, 활동 수준과 목표를 바탕으로 열량·탄수화물·단백질·지방·식이섬유
            목표를 계산합니다.
          </ThemedText>
        </ThemedView>

        <View style={styles.sectionHeader}>
          <ThemedText type="smallBold">목표 계산 기준</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            언제든 적용 기준과 버전을 확인할 수 있어요.
          </ThemedText>
        </View>
        <NutritionStandardCard />
      </ThemedView>
    </ScrollView>
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
  brand: {
    color: '#16794A',
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '800',
    letterSpacing: 1.5,
  },
  goalCard: {
    padding: Spacing.four,
    borderRadius: 20,
    gap: Spacing.three,
  },
  goalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  pendingBadge: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: '#FFF1D6',
  },
  pendingText: {
    color: '#8A5A00',
  },
  goalTitle: {
    fontSize: 20,
    lineHeight: 28,
    fontWeight: '700',
  },
  sectionHeader: {
    gap: Spacing.one,
    paddingTop: Spacing.two,
  },
});
