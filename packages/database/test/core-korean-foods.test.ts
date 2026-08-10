import { describe, expect, test } from 'bun:test';

import {
  CORE_KOREAN_FOODS,
  CORE_KOREAN_FOOD_SOURCE,
  K_FIND_DATASET_VERSION,
  K_FIND_OFFICIAL_DOWNLOAD_URL,
  K_FIND_OFFICIAL_LICENSE_URL,
  normalizeKoreanFoodAlias,
} from '../src/fixtures/core-korean-foods';

describe('core Korean food fixture', () => {
  test('has exactly twenty distinct foods and K-FIND source items', () => {
    expect(CORE_KOREAN_FOODS).toHaveLength(20);
    expect(new Set(CORE_KOREAN_FOODS.map((food) => food.id)).size).toBe(20);
    expect(new Set(CORE_KOREAN_FOODS.map((food) => food.sourceItemId)).size).toBe(20);
    expect(new Set(CORE_KOREAN_FOODS.map((food) => food.datasetVersion))).toEqual(
      new Set([K_FIND_DATASET_VERSION]),
    );
  });

  test('stores only nonnegative integer nutrition scaled from a 100 g basis', () => {
    for (const food of CORE_KOREAN_FOODS) {
      for (const value of [
        food.energyMillicalories,
        food.carbohydrateMg,
        food.proteinMg,
        food.fatMg,
        food.fiberMg,
      ]) {
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test('maps mock recognition labels through normalized aliases', () => {
    const aliases = new Map<string, string>();
    for (const food of CORE_KOREAN_FOODS) {
      for (const alias of food.aliasesKo) {
        aliases.set(normalizeKoreanFoodAlias(alias), food.canonicalNameKo);
      }
    }

    expect(aliases.get(normalizeKoreanFoodAlias('흰 쌀밥'))).toBe('쌀밥');
    expect(aliases.get(normalizeKoreanFoodAlias('불고기'))).toBe('소불고기');
    expect(aliases.get(normalizeKoreanFoodAlias('제육볶음'))).toBe('돼지고기볶음(제육볶음)');
    expect(aliases.get(normalizeKoreanFoodAlias('닭갈비'))).toBe('닭볶음(닭갈비)');
    expect(aliases.get(normalizeKoreanFoodAlias('계란 후라이'))).toBe('달걀부침(달걀후라이)');
  });

  test('retains official K-FIND attribution and verified source quality', () => {
    expect(CORE_KOREAN_FOOD_SOURCE).toMatchObject({
      displayName: '식품영양성분 데이터베이스',
      kind: 'public_dataset',
      datasetVersion: K_FIND_DATASET_VERSION,
      englishReference: 'Korean Food Composition Database system (K-FCDB)',
      qualityGrade: 'verified',
      officialDownloadUrl: K_FIND_OFFICIAL_DOWNLOAD_URL,
      officialLicenseUrl: K_FIND_OFFICIAL_LICENSE_URL,
    });
  });

  test('only creates positive gram servings from workbook food weights', () => {
    for (const food of CORE_KOREAN_FOODS) {
      expect(Number.isInteger(food.servingGrams)).toBe(true);
      expect(food.servingGrams).toBeGreaterThan(0);
    }
  });
});
