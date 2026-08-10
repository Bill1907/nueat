import { useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { authClient, useAuthSession } from '@/auth/client';
import { ActiveNutritionTargetCard } from '@/components/active-nutrition-target-card';

import { NutritionStandardCard } from '@/components/nutrition-standard-card';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const session = useAuthSession();
  const [isSigningOut, setIsSigningOut] = useState(false);

  async function signOut() {
    setIsSigningOut(true);
    try {
      await authClient.signOut();
    } finally {
      setIsSigningOut(false);
    }
  }

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

        <ActiveNutritionTargetCard />

        <View style={styles.sectionHeader}>
          <ThemedText type="smallBold">목표 계산 기준</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            언제든 적용 기준과 버전을 확인할 수 있어요.
          </ThemedText>
        </View>
        <NutritionStandardCard />

        <ThemedView type="backgroundElement" style={styles.accountCard}>
          <View style={styles.accountCopy}>
            <ThemedText type="smallBold">로그인 계정</ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              {session.data?.user.email}
            </ThemedText>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: isSigningOut }}
            disabled={isSigningOut}
            onPress={() => void signOut()}
            style={({ pressed }) => [styles.signOutButton, pressed && styles.pressed]}>
            <ThemedText type="smallBold" style={styles.signOutText}>
              {isSigningOut ? '로그아웃 중…' : '로그아웃'}
            </ThemedText>
          </Pressable>
        </ThemedView>
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
  sectionHeader: {
    gap: Spacing.one,
    paddingTop: Spacing.two,
  },
  accountCard: {
    minHeight: 72,
    padding: Spacing.three,
    borderRadius: 18,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
  },
  accountCopy: {
    flex: 1,
    gap: Spacing.half,
  },
  signOutButton: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: Spacing.three,
  },
  signOutText: {
    color: '#C43D3D',
  },
  pressed: {
    opacity: 0.7,
  },
});
