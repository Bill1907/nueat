import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { buildDataGoImportPlan, exactPositiveGrams, normalizeDataGoAlias, scaledDecimal, uuidV5 } from './import-data-go-foods';

const paths: string[] = [];
afterEach(async () => { await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const row = (code = 'A2', overrides: Record<string, unknown> = {}) => ({ FOOD_CD: code, FOOD_NM: '테스트! 음식', FOOD_LV3_NM: '밥류', NUT_CON_SRTR_QUA: '100g', ENERC: '12.345', CHOCDF: '1.234', PROT: '2.5', FATCE: '0.001', FIBTG: null, SERV_SIZE: '50g', FOOD_SIZE: '60g', ...overrides });
async function fixture(page1: unknown[], page2: unknown[]) { const directory = await mkdtemp(join(tmpdir(), 'data-go-test-')); paths.push(directory); const one = join(directory, 'page1.json'); const two = join(directory, 'page2.json'); await writeFile(one, JSON.stringify(page1)); await writeFile(two, JSON.stringify(page2)); const files = await Promise.all([one, two].map(async (path) => { const bytes = await Bun.file(path).arrayBuffer(); return { sha256: createHash('sha256').update(new Uint8Array(bytes)).digest('hex'), byteSize: bytes.byteLength }; })); return { one, two, manifest: { pages: files, uniqueRows: new Set([...page1, ...page2].map((item) => (item as { FOOD_CD: string }).FOOD_CD)).size, acceptedRows: 0, version: 'test', officialUrl: 'https://example.test', provider: 'MFDS', license: '이용허락범위 제한 없음' } }; }

describe('Data.go food importer', () => {
  test('parses JSON pages with exact decimal scaling, nullable fiber, and SERV_SIZE preference', async () => {
    const input = await fixture([row('B2'), row('A2')], []); input.manifest.acceptedRows = 2;
    const plan = await buildDataGoImportPlan(input.one, input.two, input.manifest);
    expect(plan.foods.map((food) => food.sourceItemId)).toEqual(['A2', 'B2']);
    expect(plan.foods[0]).toMatchObject({ energyMillicalories: 12345, carbohydrateMg: 1234, proteinMg: 2500, fatMg: 1, fiberMg: null, serving: { gramsMg: 50000, label: 'SERV_SIZE', quality: 'verified' } });
    expect(plan.report.nullFiberCount).toBe(2);
  });
  test('reports expected rejected rows without blocking plan construction', async () => {
    const input = await fixture([row('A2'), row('B2', { NUT_CON_SRTR_QUA: '100 g' }), row('C2', { ENERC: null })], []); input.manifest.acceptedRows = 1;
    const plan = await buildDataGoImportPlan(input.one, input.two, input.manifest);
    expect(plan.report.rejectsByReason).toEqual({ missingCore: 1, non100g: 1 });
  });
  test('fails closed when a required header is absent', async () => {
    const input = await fixture([row('A2', { FIBTG: undefined })], []); input.manifest.acceptedRows = 1;
    delete (JSON.parse(await Bun.file(input.one).text())[0] as Record<string, unknown>).FIBTG;
    await writeFile(input.one, JSON.stringify(JSON.parse(await Bun.file(input.one).text())));
    const bytes = new Uint8Array(await Bun.file(input.one).arrayBuffer());
    input.manifest.pages[0] = { sha256: createHash('sha256').update(bytes).digest('hex'), byteSize: bytes.byteLength };
    await expect(buildDataGoImportPlan(input.one, input.two, input.manifest)).rejects.toThrow('Missing required header: FIBTG');
  });
  test('asserts manifest report invariants while allowing small fixture overrides', async () => {
    const input = await fixture([row('A2', { SERV_SIZE: null, FOOD_SIZE: '60g', FIBTG: null }), row('B2', { NUT_CON_SRTR_QUA: '1g' })], []); input.manifest.acceptedRows = 1;
    const manifest = { ...input.manifest, report: { missingCore: 0, non100g: 1, nullFiber: 1, verifiedServings: 0, estimatedFoodSizeServings: 1, omittedServings: 0 } };
    await expect(buildDataGoImportPlan(input.one, input.two, manifest)).resolves.toBeDefined();
    await expect(buildDataGoImportPlan(input.one, input.two, { ...manifest, report: { ...manifest.report, omittedServings: 1 } })).rejects.toThrow('Report omittedServings mismatch');
  });
  test('fails closed on artifact, manifest, and conflicting duplicate identity', async () => {
    const input = await fixture([row('A2')], []); input.manifest.acceptedRows = 1;
    await expect(buildDataGoImportPlan(input.one, input.two, { ...input.manifest, pages: [{ ...input.manifest.pages[0]!, byteSize: 1 }, input.manifest.pages[1]! ] })).rejects.toThrow('byte size');
    await expect(buildDataGoImportPlan(input.one, input.two, { ...input.manifest, uniqueRows: 2 })).rejects.toThrow('Unique FOOD_CD');
    const duplicate = await fixture([row('A2'), row('A2', { FOOD_NM: '다른 음식' })], []); duplicate.manifest.acceptedRows = 1;
    await expect(buildDataGoImportPlan(duplicate.one, duplicate.two, duplicate.manifest)).rejects.toThrow('Conflicting duplicate FOOD_CD');
  });
  test('keeps deterministic IDs and strict gram parsing', () => {
    expect(normalizeDataGoAlias(' Café—밥!™ ')).toBe('café밥');
    expect(uuidV5('food:A2')).toBe('2424463c-5eaa-5b63-b122-d50af7adf350');
    expect(scaledDecimal('1.234', 'x')).toBe(1234);
    expect(() => scaledDecimal('1.0001', 'x')).toThrow('Fractional');
    expect(exactPositiveGrams('50g', 'x')).toBe(50000);
    expect(exactPositiveGrams('50 g', 'x')).toBeNull();
  });
});
