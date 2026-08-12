import { useCallback, useState } from 'react';
import {
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuthSession } from '@/auth/client';
import { DailyNutritionDashboard } from '@/components/daily-nutrition-dashboard';
import { NextMealRecommendations } from '@/components/next-meal-recommendations';

import { MealPhotoUploadCard } from '@/components/meal-photo-upload-card';


import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const session = useAuthSession();
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  function refreshHome() {
    setRefreshing(true);
    setRefreshGeneration((generation) => generation + 1);
  }
  const handleDashboardLoadComplete = useCallback(() => {
    setRefreshing(false);
  }, []);
  const handleMealConfirmed = useCallback(() => {
    setRefreshGeneration((generation) => generation + 1);
  }, []);


  return (
    <ScrollView
      style={[styles.scrollView, { backgroundColor: theme.background }]}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => void refreshHome()}
          tintColor={theme.primary}
        />
      }
      contentContainerStyle={[
        styles.content,
        {
          paddingTop: Platform.OS === 'web' ? 96 : insets.top + Spacing.four,
          paddingBottom: insets.bottom + BottomTabInset + Spacing.four,
        },
      ]}
    >
      <ThemedView style={styles.container}>
        <View style={styles.header}>
          <ThemedText style={[styles.brand, { color: theme.primary }]}>NUEAT</ThemedText>
          <ThemedText type="subtitle">오늘, 무엇을 먹을까요?</ThemedText>
          <ThemedText themeColor="textSecondary">
            기록을 시작하면 오늘의 영양 격차와 다음 식사 선택지를 알려드려요.
          </ThemedText>
        </View>

        <DailyNutritionDashboard
          recommendations={session.data?.user.id ? (
            <NextMealRecommendations
              key={session.data.user.id}
              refreshGeneration={refreshGeneration}
              onMealConfirmed={handleMealConfirmed}
              userId={session.data.user.id}
            />
          ) : null}
          refreshGeneration={refreshGeneration}
          onLoadComplete={handleDashboardLoadComplete}
        />
        <MealPhotoUploadCard compact onMealConfirmed={handleMealConfirmed} />
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
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '800',
    letterSpacing: 1.5,
  },
});
