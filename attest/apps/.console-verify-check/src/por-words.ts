/**
 * The reader's words for what the reserve SDK names in code.
 *
 * Two screens say them — 준비금 증명, which reads a balance file, and 검증,
 * which names the file a proof file was written for — and 검증 may import
 * nothing that can reach the API. So the words live here, with the language
 * helper and nothing else.
 */
import { t } from './i18n.ts';

/** The shape a balance file came in, as a result names it. */
export function shapeName(shape: string): string {
  const names: Record<string, string> = {
    wide: t('계정당 한 줄 CSV', 'a CSV with one row per account'),
    long: t('계정·자산당 한 줄 CSV', 'a CSV with one row per account and asset'),
    sheet: t('잔고·부채 열 CSV', 'a CSV with balance and debt columns'),
    json: t('계정 배열 JSON', 'a JSON array of accounts'),
  };
  return Object.hasOwn(names, shape) ? names[shape]! : shape;
}
