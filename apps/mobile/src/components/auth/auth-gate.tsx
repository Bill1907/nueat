import { ActivityIndicator, StyleSheet } from 'react-native';

import { useAuthSession } from '@/auth/client';
import AppTabs from '@/components/app-tabs';
import { EmailOtpScreen } from '@/components/auth/email-otp-screen';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';

export function AuthGate() {
  const session = useAuthSession();

  if (session.isPending) {
    return (
      <ThemedView style={styles.loading} accessibilityLabel="로그인 상태 확인 중">
        <ActivityIndicator color="#16794A" size="large" />
        <ThemedText type="small" themeColor="textSecondary">
          로그인 상태를 확인하고 있어요.
        </ThemedText>
      </ThemedView>
    );
  }

  if (!session.data) return <EmailOtpScreen />;
  return <AppTabs />;
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.three,
  },
});
