import { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { authClient } from '@/auth/client';
import { isCompleteOtp, isValidEmail, normalizeEmail, normalizeOtp } from '@/auth/input';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

type AuthStep = 'email' | 'otp';

export function EmailOtpScreen() {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const [step, setStep] = useState<AuthStep>('email');
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [resendSeconds, setResendSeconds] = useState(0);
  const [failedAttempts, setFailedAttempts] = useState(0);

  useEffect(() => {
    if (resendSeconds <= 0) return;
    const timer = setInterval(() => setResendSeconds((value) => Math.max(0, value - 1)), 1_000);
    return () => clearInterval(timer);
  }, [resendSeconds]);

  async function sendOtp() {
    const normalizedEmail = normalizeEmail(email);
    if (!isValidEmail(normalizedEmail)) {
      setErrorMessage('올바른 이메일 주소를 입력해 주세요.');
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      const result = await authClient.emailOtp.sendVerificationOtp({
        email: normalizedEmail,
        type: 'sign-in',
      });

      if (result.error) {
        setErrorMessage('인증번호를 보내지 못했습니다. 잠시 후 다시 시도해 주세요.');
        return;
      }

      setEmail(normalizedEmail);
      setOtp('');
      setFailedAttempts(0);
      setResendSeconds(60);
      setStep('otp');
    } catch {
      setErrorMessage('네트워크 연결을 확인하고 다시 시도해 주세요.');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function verifyOtp() {
    if (!isCompleteOtp(otp)) {
      setErrorMessage('인증번호 6자리를 입력해 주세요.');
      return;
    }
    if (failedAttempts >= 3) {
      setErrorMessage('인증 시도 횟수를 초과했습니다. 새 인증번호를 요청해 주세요.');
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      const result = await authClient.signIn.emailOtp({
        email,
        otp,
        name: 'NUEAT 사용자',
      });

      if (result.error) {
        const nextAttempts = failedAttempts + 1;
        setFailedAttempts(nextAttempts);
        setErrorMessage(
          nextAttempts >= 3
            ? '인증 시도 횟수를 초과했습니다. 새 인증번호를 요청해 주세요.'
            : '인증번호가 올바르지 않거나 만료됐습니다.',
        );
      }
    } catch {
      setErrorMessage('네트워크 연결을 확인하고 다시 시도해 주세요.');
    } finally {
      setIsSubmitting(false);
    }
  }

  function editEmail() {
    setStep('email');
    setOtp('');
    setErrorMessage(null);
    setFailedAttempts(0);
  }

  return (
    <KeyboardAvoidingView
      style={[styles.screen, { backgroundColor: theme.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + Spacing.five, paddingBottom: insets.bottom + Spacing.five },
        ]}>
        <ThemedView style={styles.container}>
          <View style={styles.header}>
            <ThemedText style={styles.brand}>NUEAT</ThemedText>
            <ThemedText type="subtitle">
              {step === 'email' ? '이메일로 시작하기' : '인증번호 입력'}
            </ThemedText>
            <ThemedText themeColor="textSecondary">
              {step === 'email'
                ? '비밀번호 없이 이메일 인증번호로 안전하게 로그인해요.'
                : `${email} 주소로 보낸 6자리 번호를 입력해 주세요.`}
            </ThemedText>
          </View>

          <ThemedView type="backgroundElement" style={styles.card}>
            {step === 'email' ? (
              <>
                <ThemedText type="smallBold">이메일</ThemedText>
                <TextInput
                  accessibilityLabel="로그인 이메일"
                  autoCapitalize="none"
                  autoComplete="email"
                  autoCorrect={false}
                  keyboardType="email-address"
                  onChangeText={setEmail}
                  onSubmitEditing={() => void sendOtp()}
                  placeholder="name@example.com"
                  placeholderTextColor={theme.textSecondary}
                  returnKeyType="send"
                  style={[
                    styles.input,
                    { color: theme.text, borderColor: theme.backgroundSelected },
                  ]}
                  value={email}
                />
                <PrimaryButton
                  disabled={isSubmitting || !isValidEmail(email)}
                  label={isSubmitting ? '보내는 중…' : '인증번호 받기'}
                  onPress={() => void sendOtp()}
                />
              </>
            ) : (
              <>
                <View style={styles.otpHeader}>
                  <ThemedText type="smallBold">인증번호</ThemedText>
                  <Pressable accessibilityRole="button" onPress={editEmail} hitSlop={8}>
                    <ThemedText type="smallBold" style={styles.textButton}>
                      이메일 변경
                    </ThemedText>
                  </Pressable>
                </View>
                <TextInput
                  accessibilityLabel="이메일 인증번호 6자리"
                  autoComplete="one-time-code"
                  keyboardType="number-pad"
                  maxLength={6}
                  onChangeText={(value) => {
                    setOtp(normalizeOtp(value));
                    setErrorMessage(null);
                  }}
                  onSubmitEditing={() => void verifyOtp()}
                  placeholder="000000"
                  placeholderTextColor={theme.textSecondary}
                  returnKeyType="done"
                  style={[
                    styles.input,
                    styles.otpInput,
                    { color: theme.text, borderColor: theme.backgroundSelected },
                  ]}
                  textContentType="oneTimeCode"
                  value={otp}
                />
                <ThemedText type="small" themeColor="textSecondary">
                  인증번호는 5분 동안 유효하며 최대 3번 확인할 수 있어요.
                </ThemedText>
                <PrimaryButton
                  disabled={isSubmitting || !isCompleteOtp(otp) || failedAttempts >= 3}
                  label={isSubmitting ? '확인 중…' : '로그인'}
                  onPress={() => void verifyOtp()}
                />
                <Pressable
                  accessibilityRole="button"
                  disabled={isSubmitting || resendSeconds > 0}
                  onPress={() => void sendOtp()}
                  style={({ pressed }) => [
                    styles.resendButton,
                    pressed && styles.pressed,
                    resendSeconds > 0 && styles.disabled,
                  ]}>
                  <ThemedText type="smallBold" themeColor="textSecondary">
                    {resendSeconds > 0
                      ? `${resendSeconds}초 후 다시 받기`
                      : '인증번호 다시 받기'}
                  </ThemedText>
                </Pressable>
              </>
            )}

            {errorMessage ? (
              <ThemedText accessibilityRole="alert" type="small" style={styles.errorText}>
                {errorMessage}
              </ThemedText>
            ) : null}
          </ThemedView>

          <ThemedText type="small" themeColor="textSecondary" style={styles.privacyNote}>
            로그인하면 서비스 이용을 위한 계정 식별 정보가 처리됩니다. 건강정보 동의는
            온보딩에서 별도로 요청합니다.
          </ThemedText>
        </ThemedView>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function PrimaryButton({
  disabled,
  label,
  onPress,
}: {
  disabled: boolean;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.primaryButton,
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}>
      <ThemedText type="smallBold" style={styles.primaryButtonText}>
        {label}
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.four,
  },
  container: {
    width: '100%',
    maxWidth: Math.min(MaxContentWidth, 480),
    gap: Spacing.four,
  },
  header: { gap: Spacing.two },
  brand: {
    color: '#16794A',
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '800',
    letterSpacing: 1.5,
  },
  card: {
    borderRadius: 20,
    padding: Spacing.four,
    gap: Spacing.three,
  },
  input: {
    minHeight: 52,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: Spacing.three,
    fontSize: 16,
    fontWeight: '500',
  },
  otpInput: {
    textAlign: 'center',
    fontSize: 28,
    fontWeight: '800',
    letterSpacing: 10,
  },
  otpHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  primaryButton: {
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
    backgroundColor: '#16794A',
  },
  primaryButtonText: { color: '#FFFFFF' },
  resendButton: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  textButton: { color: '#16794A' },
  errorText: { color: '#C43D3D' },
  privacyNote: { textAlign: 'center', paddingHorizontal: Spacing.two },
  pressed: { opacity: 0.72 },
  disabled: { opacity: 0.45 },
});
