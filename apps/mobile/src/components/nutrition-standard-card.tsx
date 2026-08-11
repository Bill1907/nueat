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
      surface="raised"
      style={styles.card}
      accessibilityLabel={`${NUTRITION_STANDARD.nameKo} 적용됨`}>
      <View style={styles.header}>
        <View
          style={[
            styles.badge,
            { backgroundColor: theme.successSurface, borderColor: theme.primary },
          ]}>
          <ThemedText style={[styles.badgeCheck, { color: theme.primary }]}>✓</ThemedText>
        </View>
        <View style={styles.headerCopy}>
          <ThemedText type="smallBold">공식 기준 적용</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            {NUTRITION_STANDARD.publisherKo}
          </ThemedText>
        </View>
      </View>

      <ThemedText style={styles.standardName}>{NUTRITION_STANDARD.nameKo}</ThemedText>
      <ThemedText type="small" themeColor="textSecondary">
        에너지 필요추정량과 영양 목표를 이 기준으로 계산해요. 생성형 AI가 영양 목표를
        정하지 않습니다.
      </ThemedText>

      <View style={styles.metadata}>
        <Metadata label="기준판" value={NUTRITION_STANDARD.equationVersion} />
        <Metadata label="정오표 반영" value={NUTRITION_STANDARD.corrigendaVersion} />
        <Metadata label="계산 엔진" value={NUTRITION_STANDARD.engineVersion} />
      </View>

      <Pressable
        accessibilityRole="link"
        accessibilityLabel="보건복지부 공식 기준 문서 열기"
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
          공식 출처 보기 ↗
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
    borderRadius: Radius.surface,
    padding: Spacing.four,
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
    width: 32,
    height: 32,
    borderRadius: Radius.pill,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeCheck: {
    fontWeight: '800',
  },
  standardName: {
    fontSize: 20,
    lineHeight: 28,
    fontWeight: '700',
  },
  metadata: {
    gap: Spacing.two,
    paddingTop: Spacing.one,
  },
  metadataRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
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
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.12,
    shadowRadius: 6,
    elevation: 2,
  },
  pressed: {
    transform: [{ translateY: 1 }],
    opacity: 0.82,
  },
});
