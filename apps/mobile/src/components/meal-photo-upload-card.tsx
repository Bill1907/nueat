import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useEffect, useRef, useState } from 'react';
import { Linking, Platform, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import {
  loadLocalUploadDraft,
  removeLocalUploadDraft,
  type LocalImageUploadDraft,
} from '@/uploads/image-upload-draft';
import {
  uploadImageDraft,
  type ValidatedImageAsset,
} from '@/uploads/image-upload-client';
import { prepareImageUploadDraft } from '@/uploads/image-preprocessor';

type Phase =
  | 'restoring'
  | 'idle'
  | 'preparing'
  | 'ready'
  | 'uploading'
  | 'validating'
  | 'success'
  | 'error';

export function MealPhotoUploadCard() {
  const [phase, setPhase] = useState<Phase>('restoring');
  const [draft, setDraft] = useState<LocalImageUploadDraft | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [permissionBlocked, setPermissionBlocked] = useState(false);
  const [validatedAsset, setValidatedAsset] =
    useState<ValidatedImageAsset | null>(null);
  const abortController = useRef<AbortController | null>(null);

  useEffect(() => {
    let active = true;
    void loadLocalUploadDraft()
      .then((restored) => {
        if (!active) return;
        setDraft(restored);
        setPhase(restored ? 'ready' : 'idle');
      })
      .catch(() => {
        if (active) setPhase('idle');
      });
    return () => {
      active = false;
      abortController.current?.abort();
    };
  }, []);

  async function selectImage(source: LocalImageUploadDraft['source']) {
    setError(null);
    setPermissionBlocked(false);
    setValidatedAsset(null);

    try {
      const granted = await requestPermission(source);
      if (!granted) {
        setPermissionBlocked(true);
        setError('사진을 선택하려면 설정에서 접근 권한을 허용해 주세요.');
        setPhase(draft ? 'ready' : 'error');
        return;
      }

      const result =
        source === 'camera'
          ? await ImagePicker.launchCameraAsync(pickerOptions)
          : await ImagePicker.launchImageLibraryAsync(pickerOptions);
      if (result.canceled || !result.assets[0]) {
        setPhase(draft ? 'ready' : 'idle');
        return;
      }

      setPhase('preparing');
      const prepared = await prepareImageUploadDraft(result.assets[0], source);
      setDraft(prepared);
      await startUpload(prepared);
    } catch (cause) {
      setError(errorMessage(cause));
      setPhase(draft ? 'ready' : 'error');
    }
  }

  async function startUpload(target = draft) {
    if (!target) return;
    const controller = new AbortController();
    abortController.current = controller;
    setError(null);
    setPermissionBlocked(false);
    setProgress(0);
    setPhase('uploading');

    try {
      const result = await uploadImageDraft(target, {
        signal: controller.signal,
        onProgress: setProgress,
        onStage: setPhase,
      });
      await removeLocalUploadDraft();
      setDraft(null);
      setValidatedAsset(result);
      setPhase('success');
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') {
        setError('업로드를 취소했습니다. 사진은 기기에 보관되어 있어요.');
        setPhase('ready');
      } else {
        setError(errorMessage(cause));
        setPhase('error');
      }
    } finally {
      if (abortController.current === controller)
        abortController.current = null;
    }
  }

  async function discardDraft() {
    abortController.current?.abort();
    await removeLocalUploadDraft();
    setDraft(null);
    setError(null);
    setProgress(0);
    setPermissionBlocked(false);
    setPhase('idle');
  }

  const busy =
    phase === 'preparing' || phase === 'uploading' || phase === 'validating';

  return (
    <ThemedView type="backgroundElement" style={styles.card}>
      <View style={styles.header}>
        <View style={styles.copy}>
          <ThemedText type="smallBold">식사 사진 업로드</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            확인 전에는 식사 기록이나 영양 섭취로 확정되지 않아요.
          </ThemedText>
        </View>
        <StatusBadge phase={phase} />
      </View>

      {draft && phase !== 'success' && (
        <Image
          source={{ uri: draft.fileUri }}
          style={styles.preview}
          contentFit="cover"
        />
      )}

      {phase === 'restoring' && (
        <ThemedText type="small" themeColor="textSecondary">
          저장된 업로드 초안을 확인하고 있어요.
        </ThemedText>
      )}
      {phase === 'preparing' && (
        <ThemedText type="small" themeColor="textSecondary">
          위치정보를 제거하고 사진 크기를 조정하고 있어요.
        </ThemedText>
      )}
      {(phase === 'uploading' || phase === 'validating') && (
        <View style={styles.progressSection}>
          <ThemedText type="smallBold">
            {phase === 'uploading'
              ? `업로드 ${Math.round(progress * 100)}%`
              : '이미지 검증 중'}
          </ThemedText>
          <View style={styles.progressTrack}>
            <View
              style={[
                styles.progressFill,
                { width: `${Math.round(progress * 100)}%` },
              ]}
            />
          </View>
        </View>
      )}
      {phase === 'ready' && draft && (
        <ThemedText type="small" themeColor="textSecondary">
          중단된 사진이 기기에 보관되어 있습니다. 다시 업로드하거나 삭제할 수
          있어요.
        </ThemedText>
      )}
      {phase === 'success' && validatedAsset && (
        <View style={styles.successCopy}>
          <ThemedText type="smallBold" style={styles.successText}>
            안전하게 업로드했어요
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            {validatedAsset.width}×{validatedAsset.height}px · 다음 단계에서
            음식을 확인합니다.
          </ThemedText>
        </View>
      )}
      {error && (
        <ThemedText
          accessibilityRole="alert"
          type="small"
          style={styles.errorText}
        >
          {error}
        </ThemedText>
      )}

      <View style={styles.actions}>
        {!busy && (!draft || phase === 'success') && (
          <>
            <ActionButton
              label="사진 촬영"
              onPress={() => void selectImage('camera')}
            />
            <ActionButton
              label="앨범 선택"
              onPress={() => void selectImage('library')}
              secondary
            />
          </>
        )}
        {!busy && draft && (phase === 'ready' || phase === 'error') && (
          <>
            <ActionButton
              label="다시 업로드"
              onPress={() => void startUpload()}
            />
            <ActionButton
              label="초안 삭제"
              onPress={() => void discardDraft()}
              secondary
            />
          </>
        )}
        {(phase === 'uploading' || phase === 'validating') && (
          <ActionButton
            label="취소"
            onPress={() => abortController.current?.abort()}
            secondary
          />
        )}
        {permissionBlocked && (
          <ActionButton
            label="설정 열기"
            onPress={() => void Linking.openSettings()}
            secondary
          />
        )}
      </View>
    </ThemedView>
  );
}

const pickerOptions: ImagePicker.ImagePickerOptions = {
  mediaTypes: ['images'],
  allowsEditing: false,
  quality: 1,
  exif: false,
  base64: false,
};

async function requestPermission(source: LocalImageUploadDraft['source']) {
  if (Platform.OS === 'web') return true;
  const permission =
    source === 'camera'
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();
  return permission.granted;
}

function StatusBadge({ phase }: { phase: Phase }) {
  const label =
    phase === 'success'
      ? '업로드 완료'
      : phase === 'uploading' || phase === 'validating' || phase === 'preparing'
        ? '처리 중'
        : phase === 'ready'
          ? '초안 보관'
          : '확정 전';
  const success = phase === 'success';
  return (
    <View style={[styles.badge, success && styles.successBadge]}>
      <ThemedText
        type="smallBold"
        style={success ? styles.successText : styles.badgeText}
      >
        {label}
      </ThemedText>
    </View>
  );
}

function ActionButton({
  label,
  onPress,
  secondary = false,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  secondary?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        secondary && styles.secondaryButton,
        (pressed || disabled) && styles.pressed,
      ]}
    >
      <ThemedText
        type="smallBold"
        style={secondary ? styles.secondaryText : styles.buttonText}
      >
        {label}
      </ThemedText>
    </Pressable>
  );
}

function errorMessage(cause: unknown) {
  return cause instanceof Error
    ? cause.message
    : '사진 업로드를 완료하지 못했습니다.';
}

const styles = StyleSheet.create({
  card: {
    padding: Spacing.four,
    borderRadius: 20,
    gap: Spacing.three,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
  },
  copy: {
    flex: 1,
    gap: Spacing.half,
  },
  badge: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: '#FFF1D6',
  },
  successBadge: {
    backgroundColor: '#E7F4EC',
  },
  badgeText: {
    color: '#8A5A00',
  },
  successText: {
    color: '#16794A',
  },
  preview: {
    width: '100%',
    aspectRatio: 4 / 3,
    borderRadius: 14,
    backgroundColor: '#DDE5E0',
  },
  progressSection: {
    gap: Spacing.two,
  },
  progressTrack: {
    height: 8,
    overflow: 'hidden',
    borderRadius: 999,
    backgroundColor: '#DDE5E0',
  },
  progressFill: {
    height: '100%',
    borderRadius: 999,
    backgroundColor: '#16794A',
  },
  successCopy: {
    gap: Spacing.one,
  },
  errorText: {
    color: '#B42318',
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  button: {
    minHeight: 44,
    minWidth: 112,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    paddingHorizontal: Spacing.three,
    backgroundColor: '#16794A',
  },
  secondaryButton: {
    borderWidth: 1,
    borderColor: '#16794A',
    backgroundColor: 'transparent',
  },
  buttonText: {
    color: '#FFFFFF',
  },
  secondaryText: {
    color: '#16794A',
  },
  pressed: {
    opacity: 0.6,
  },
});
