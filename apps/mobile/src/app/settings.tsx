import { useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { authClient, useAuthSession } from '@/auth/client';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const session = useAuthSession();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);

  async function signOut() {
    if (isSigningOut) return;
    setIsSigningOut(true);
    setSignOutError(null);
    try {
      const result = await authClient.signOut();
      if (result.error) {
        setSignOutError('로그아웃하지 못했어요. 다시 시도해 주세요.');
      }
    } catch {
      setSignOutError('로그아웃하지 못했어요. 다시 시도해 주세요.');
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
      ]}
    >
      <ThemedView style={styles.container}>
        <View style={styles.header}>
          <ThemedText type="title">설정</ThemedText>
          <ThemedText themeColor="textSecondary">
            계정과 앱 설정을 관리하세요.
          </ThemedText>
        </View>

        <ThemedView type="backgroundElement" style={styles.section}>
          <View style={styles.accountCopy}>
            <ThemedText type="smallBold">로그인 계정</ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              {session.data?.user.email}
            </ThemedText>
          </View>

          {signOutError && (
            <ThemedText
              accessibilityRole="alert"
              type="small"
              style={{ color: theme.danger }}
            >
              {signOutError}
            </ThemedText>
          )}

          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: isSigningOut }}
            disabled={isSigningOut}
            onPress={() => void signOut()}
            style={({ pressed }) => [
              styles.signOutButton,
              { borderColor: theme.danger },
              pressed && styles.pressed,
              isSigningOut && styles.disabled,
            ]}
          >
            {isSigningOut && <ActivityIndicator color={theme.danger} />}
            <ThemedText type="smallBold" style={{ color: theme.danger }}>
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
  section: {
    gap: Spacing.three,
    padding: Spacing.four,
    borderRadius: 18,
  },
  accountCopy: {
    gap: Spacing.half,
  },
  signOutButton: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: Spacing.two,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: Spacing.three,
  },
  pressed: {
    opacity: 0.7,
  },
  disabled: {
    opacity: 0.6,
  },
});
