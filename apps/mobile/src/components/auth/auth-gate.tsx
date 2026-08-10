import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet } from 'react-native';

import { apiRequest } from '@/api/client';
import { useAuthSession } from '@/auth/client';
import AppTabs from '@/components/app-tabs';
import { EmailOtpScreen } from '@/components/auth/email-otp-screen';
import { OnboardingFlow } from '@/components/onboarding/onboarding-flow';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';

interface OnboardingStatus {
  status: 'pending' | 'completed' | 'limited';
}

export function AuthGate() {
  const session = useAuthSession();
  const userId = session.data?.user.id;
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusUserId, setStatusUserId] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!userId) return;
    let active = true;
    void apiRequest<OnboardingStatus>('/api/onboarding/status')
      .then((result) => {
        if (!active) return;
        setStatus(result);
        setStatusError(null);
        setStatusUserId(userId);
      })
      .catch((cause) => {
        if (!active) return;
        setStatus(null);
        setStatusError(
          cause instanceof Error ? cause.message : '다시 시도해 주세요.',
        );
        setStatusUserId(userId);
      });
    return () => {
      active = false;
    };
  }, [reload, userId]);

  if (session.isPending) return <Loading />;

  if (!session.data) return <EmailOtpScreen />;

  if (statusUserId !== userId) return <Loading />;

  if (statusError) {
    return (
      <ThemedView style={styles.loading}>
        <ThemedText accessibilityRole="alert">{statusError}</ThemedText>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="온보딩 상태 다시 시도"
          onPress={() => setReload((value) => value + 1)}
          style={styles.retry}
        >
          <ThemedText type="smallBold" style={styles.retryText}>
            다시 시도
          </ThemedText>
        </Pressable>
      </ThemedView>
    );
  }

  if (!status) return <Loading />;
  if (status.status === 'pending')
    return (
      <OnboardingFlow onComplete={() => setReload((value) => value + 1)} />
    );
  return <AppTabs />;
}

function Loading() {
  return (
    <ThemedView style={styles.loading} accessibilityLabel="로그인 상태 확인 중">
      <ActivityIndicator color="#16794A" size="large" />
      <ThemedText type="small" themeColor="textSecondary">
        로그인 상태를 확인하고 있어요.
      </ThemedText>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.three,
  },
  retry: {
    minHeight: 44,
    minWidth: 100,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    backgroundColor: '#16794A',
    paddingHorizontal: Spacing.three,
  },
  retryText: {
    color: '#FFFFFF',
  },
});
