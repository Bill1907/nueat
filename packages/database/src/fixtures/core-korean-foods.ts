export const K_FIND_DATASET_VERSION = '2025-12-29';
export const K_FIND_SOURCE_ID = '2a6bcece-5f43-5fd7-916d-4b99c08f8042';
export const K_FIND_SOURCE_CODE = 'kfind_food_2025_12_29';
export const K_FIND_OFFICIAL_DOWNLOAD_URL =
  'https://various.foodsafetykorea.go.kr/nutrient/general/down/historyList.do';
export const K_FIND_OFFICIAL_LICENSE_URL =
  'https://www.mfds.go.kr/wpge/m_34/de010803l001.do';

export function normalizeKoreanFoodAlias(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}]/gu, '');
}

export type CoreKoreanFood = {
  id: string;
  sourceItemId: string;
  datasetVersion: typeof K_FIND_DATASET_VERSION;
  canonicalNameKo: string;
  category: string;
  aliasesKo: readonly string[];
  energyMillicalories: number;
  carbohydrateMg: number;
  proteinMg: number;
  fatMg: number;
  fiberMg: number;
  servingGrams: number;
};

const food = (
  id: string,
  sourceItemId: string,
  canonicalNameKo: string,
  category: string,
  aliasesKo: readonly string[],
  energyMillicalories: number,
  carbohydrateMg: number,
  proteinMg: number,
  fatMg: number,
  fiberMg: number,
  servingGrams: number,
): CoreKoreanFood => ({
  id,
  sourceItemId,
  datasetVersion: K_FIND_DATASET_VERSION,
  canonicalNameKo,
  category,
  aliasesKo: [...new Set([canonicalNameKo, ...aliasesKo])],
  energyMillicalories,
  carbohydrateMg,
  proteinMg,
  fatMg,
  fiberMg,
  servingGrams,
});

/**
 * Analyzed K-FIND 2025-12-29 rows. Nutrition is per 100 g; grams are scaled
 * to mg and kcal to millicalories so no AI-supplied nutrition enters storage.
 */
export const CORE_KOREAN_FOODS = [
  food('1692aac9-5ff1-5472-b04b-70d04b8ceca9', 'D301-022000000-0001', '쌀밥', '밥류', ['흰쌀밥'], 166000, 37330, 3360, 320, 100, 100),
  food('52164173-2bc5-59c9-9ee9-d7ab9d8a0672', 'D306-266000000-0001', '김치찌개', '찌개 및 전골류', [], 61000, 2980, 3770, 3750, 2100, 400),
  food('18a04acd-135c-58e1-a4c6-4f3851d4bb41', 'D315-670000000-0001', '배추김치', '김치류', [], 38000, 6490, 1980, 430, 2500, 100),
  food('15b97a64-6e68-54f9-8059-9d92814ca872', 'D106-275000000-0001', '된장찌개', '찌개 및 전골류', [], 46000, 4440, 3380, 1630, 1600, 200),
  food('30262b79-7809-59d5-868b-60c07fcb9d87', 'D105-223000000-0001', '미역국', '국 및 탕류', [], 12000, 870, 650, 610, 400, 400),
  food('6a1dd1fc-6dd6-57cc-9de9-6547350a3f94', 'D105-253000000-0001', '콩나물국', '국 및 탕류', [], 6000, 610, 740, 90, 400, 400),
  food('36fd393d-d97d-585c-94bc-cfd8cda5697f', 'D108-386000000-0001', '소불고기', '구이류', ['불고기'], 170000, 4260, 16410, 9660, 3500, 200),
  food('e2e21023-6352-5b43-8eaf-cceb273484ef', 'D110-465000000-0001', '돼지고기볶음(제육볶음)', '볶음류', ['제육볶음'], 195000, 4730, 12150, 14190, 3600, 250),
  food('e1c2d136-208d-5906-a61b-7eb1e6c4fd69', 'D110-462000000-0001', '닭볶음(닭갈비)', '볶음류', ['닭갈비'], 186000, 7930, 13980, 10960, 1300, 300),
  food('25e6ee3d-6a06-5652-8501-af00b3f64708', 'D108-382000000-0001', '삼겹살구이', '구이류', [], 467000, 350, 22560, 41690, 700, 200),
  food('e07e94cd-cab7-52ae-a65c-21a2c392142c', 'D108-357110000-0001', '고등어구이_석쇠', '구이류', ['고등어구이'], 340000, 3790, 23380, 25690, 2400, 200),
  food('93ff111f-ad37-5513-b88b-0ba7c3b10982', 'D109-417000000-0001', '달걀부침(달걀후라이)', '전·적 및 부침류', ['달걀프라이', '계란후라이'], 208000, 5150, 15730, 13780, 8400, 60),
  food('ef98158c-ac97-5cf6-9588-5e971e26a381', 'D101-007000000-0001', '김밥', '밥류', [], 140000, 19980, 4840, 4550, 1400, 230),
  food('ed77fc7b-035d-520e-b354-0d3ef6d946c9', 'D101-018000000-0001', '비빔밥', '밥류', [], 142000, 18840, 6860, 4320, 2000, 450),
  food('e72661d6-11f4-5b5f-bcad-3575571f8eb0', 'D103-148000000-0001', '라면', '면 및 만두류', [], 82000, 13650, 1720, 2280, 1000, 550),
  food('0d03af3c-6d84-5a7a-8317-90946e98f109', 'D103-174000000-0001', '칼국수', '면 및 만두류', [], 77000, 14900, 3300, 490, 1600, 700),
  food('a2417124-25ca-53d7-ba46-c2228a332e0b', 'D110-467000000-0001', '떡볶이', '볶음류', [], 144000, 25960, 3510, 2960, 1000, 180),
  food('5e89d1b2-4f7f-50d8-aef6-9c5f0295d65d', 'D110-492000000-0001', '잡채', '볶음류', [], 146000, 24260, 4710, 3300, 3700, 200),
  food('66802a79-2cbb-5d81-94cd-4f1bf55e438e', 'D111-517000000-0001', '두부조림', '조림류', [], 143000, 4400, 9640, 9660, 800, 50),
  food('e545162d-cf31-5de2-afdf-ef5bed27f4b7', 'D113-586000000-0001', '시금치나물', '나물·숙채류', [], 69000, 3360, 3740, 4460, 2000, 50),
] as const satisfies readonly CoreKoreanFood[];

export const CORE_KOREAN_FOOD_SOURCE = {
  id: K_FIND_SOURCE_ID,
  code: K_FIND_SOURCE_CODE,
  displayName: '식품영양성분 데이터베이스',
  kind: 'public_dataset',
  datasetVersion: K_FIND_DATASET_VERSION,
  koreanReference: '식품영양성분 데이터베이스',
  englishReference: 'Korean Food Composition Database system (K-FCDB)',
  officialDownloadUrl: K_FIND_OFFICIAL_DOWNLOAD_URL,
  officialLicenseUrl: K_FIND_OFFICIAL_LICENSE_URL,
  licenseReference: `Korean Food Composition Database system (K-FCDB) | ${K_FIND_OFFICIAL_DOWNLOAD_URL} | ${K_FIND_OFFICIAL_LICENSE_URL}`,
  qualityGrade: 'verified',
} as const;
