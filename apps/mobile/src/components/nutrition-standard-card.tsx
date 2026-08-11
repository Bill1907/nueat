import * as Linking from 'expo-linking';
import { NUTRITION_STANDARD } from '@nueat/domain';
import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export function NutritionStandardCard() {
  const theme = useTheme();

  return (
    <ThemedView
      surface="inset"
      style={styles.card}
      accessibilityLabel={`${NUTRITION_STANDARD.nameKo} 검증된 기준 적용됨`}>
      <View style={styles.header}>
        <View
          style={[
            styles.badge,
            { backgroundColor: theme.successSurface, borderColor: theme.primary },
          ]}>
          <ThemedText style={[styles.badgeCheck, { color: theme.primary }]}>✓</ThemedText>
        </View>
        <View style={styles.headerCopy}>
          <ThemedText type="smallBold">검증된 계산 기준</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            {NUTRITION_STANDARD.nameKo}
          </ThemedText>
        </View>
      </View>

      <ThemedText type="small" themeColor="textSecondary">
        영양 목표는 공식 기준과 계산 엔진으로 산출하며 생성형 AI가 정하지 않습니다.
      </ThemedText>

      <View style={styles.metadata}>
        <Metadata label="산출식 버전" value={NUTRITION_STANDARD.equationVersion} />
        <Metadata label="정오표 반영 버전" value={NUTRITION_STANDARD.corrigendaVersion} />
        <Metadata label="계산 엔진" value={NUTRITION_STANDARD.engineVersion} />
        <Metadata label="안전 규칙" value={NUTRITION_STANDARD.safetyRulesVersion} />
        <Metadata
          label="출처"
          value={`${NUTRITION_STANDARD.equationSource} · ${NUTRITION_STANDARD.publisherKo}`}
        />
      </View>

      <Pressable
        accessibilityRole="link"
        accessibilityLabel="보건복지부 공식 영양소 섭취기준 원문 열기"
        onPress={() => void Linking.openURL(NUTRITION_STANDARD.sourceUrl)}
        style={({ pressed }) => [
          styles.sourceLink,
          {
            backgroundColor: theme.surfaceInset,
            borderColor: theme.border,
            shadowColor: theme.shadow,
          },
          pressed && styles.pressed,
        ]}>
        <ThemedText type="smallBold" style={{ color: theme.primary }}>
          공식 원문 보기 ↗
        </ThemedText>
      </Pressable>
    </ThemedView>
  );
}

function Metadata({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metadataRow}>
      <ThemedText type="small" themeColor="textSecondary" style={styles.metadataLabel}>
        {label}
      </ThemedText>
      <ThemedText type="smallBold" style={styles.metadataValue}>{value}</ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: Spacing.three,
    gap: Spacing.three,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  headerCopy: {
    flex: 1,
  },
  badge: {
    width: 28,
    height: 28,
    borderRadius: Radius.pill,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeCheck: {
    fontWeight: '800',
  },
  metadata: {
    gap: Spacing.two,
  },
  metadataRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  metadataLabel: {
    flexShrink: 0,
  },
  metadataValue: {
    flexShrink: 1,
    textAlign: 'right',
  },
  sourceLink: {
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: Radius.control,
    borderWidth: 1,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
    elevation: 1,
  },
  pressed: {
    transform: [{ translateY: 1 }],
    opacity: 0.82,
  },
});
