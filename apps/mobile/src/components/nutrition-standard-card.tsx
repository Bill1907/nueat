import * as Linking from 'expo-linking';
import { NUTRITION_STANDARD } from '@nueat/domain';
import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';

export function NutritionStandardCard() {
  return (
    <ThemedView
      type="backgroundElement"
      style={styles.card}
      accessibilityLabel={`${NUTRITION_STANDARD.nameKo} 적용됨`}>
      <View style={styles.header}>
        <View style={styles.badge}>
          <ThemedText style={styles.badgeCheck}>✓</ThemedText>
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
        style={({ pressed }) => [styles.sourceLink, pressed && styles.pressed]}>
        <ThemedText type="smallBold" style={styles.sourceText}>
          공식 출처 보기 ↗
        </ThemedText>
      </Pressable>
    </ThemedView>
  );
}

function Metadata({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metadataRow}>
      <ThemedText type="small" themeColor="textSecondary">
        {label}
      </ThemedText>
      <ThemedText type="smallBold">{value}</ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 20,
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
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#DDF7E8',
  },
  badgeCheck: {
    color: '#16794A',
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
    justifyContent: 'space-between',
    gap: Spacing.three,
  },
  sourceLink: {
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 12,
    backgroundColor: '#DDEBFF',
  },
  sourceText: {
    color: '#123A63',
  },
  pressed: {
    opacity: 0.7,
  },
});
