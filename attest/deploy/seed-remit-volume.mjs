/**
 * Volume seeder: N real settlements through the public SDK, as the demo
 * bank. Exists so the console's search/paging has something worth paging —
 * every row is the full pipeline (travel rule, approval, USDC, payout,
 * evidence), not an INSERT.
 *
 *   node deploy/seed-remit-volume.mjs [--count 36] [--concurrency 6]
 *
 * Mix: mostly happy-path, a few *.13 (returned), *.01 (L1 hold) and one
 * ≥20k RFI answered inline — so the state filter has every value to show.
 */
import { parseArgs } from 'node:util';
import { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { RemitClient } from '../packages/attest-remit/src/index.ts';

const { values: a } = parseArgs({ options: {
  count: { type: 'string' }, concurrency: { type: 'string' },
} });
const COUNT = Number(a.count ?? '36');
const POOL = Number(a.concurrency ?? '6');

const state = JSON.parse(readFileSync(new URL('../../demo-bank/state.json', import.meta.url), 'utf8'));
const client = new RemitClient({
  core: 'http://127.0.0.1:8787',
  apiKey: state.apiKey,
  institutionId: 'VN-BANK-001',
  institutionName: 'Demo Commercial Bank (VN)',
  key: createPrivateKey(readFileSync(new URL('../../demo-bank/hsm/bank-hsm.key', import.meta.url), 'utf8')),
});
await client.assertRegistered();

/** Deterministic-ish spread of importers so rows are tellable apart. */
const IMPORTERS = ['Vina Trading', 'Saigon Textiles', 'Mekong Agro', 'Hanoi Electronics',
  'DaNang Seafood', 'Hue Garments', 'Binh Duong Furniture', 'CanTho Rice'];

function scenario(i) {
  if (i % 12 === 7) return { amount: `${300 + i}.13`, kind: 'returned' };
  if (i % 12 === 11) return { amount: `${400 + i}.01`, kind: 'l1-hold' };
  if (i === 13) return { amount: '25000.00', kind: 'rfi' };
  const units = 500 + ((i * 937) % 9000);
  const cents = String((i * 7) % 100).padStart(2, '0');
  return { amount: `${units}.${cents === '13' || cents === '01' ? '27' : cents}`, kind: 'happy' };
}

let done = 0; let failed = 0;
async function run(i) {
  const sc = scenario(i);
  try {
    const quote = await client.quote(sc.amount);
    const { paymentId, body } = client.buildInstruction(quote, {
      debtor: { name: `${IMPORTERS[i % IMPORTERS.length]} Co., Ltd.`, country: 'VN',
        address: `${10 + i} Le Loi Blvd, HCMC`, registration_number: `VN-03123${String(i).padStart(3, '0')}`,
        account: `VN-ACC-${String(i).padStart(4, '0')}` },
      creditor: { name: 'Pacific Supply Pte Ltd', country: 'SG',
        account: `SG-ACC-${String(i).padStart(4, '0')}`, bank: 'DBS (sim)' },
    });
    await client.submit(body);
    let view = await client.track(paymentId, { timeoutMs: 120_000 });
    if (sc.kind === 'rfi' && view.state === 'TRAVEL_RULE_PENDING') {
      await client.answerRfi(paymentId, {
        source_of_funds: 'invoice INV-SEED-0013, letter of credit on file',
        relationship: 'recurring supplier since 2024',
      });
      view = await client.track(paymentId, { timeoutMs: 120_000 });
    }
    done++;
    console.log(`[${String(done + failed).padStart(2)}/${COUNT}] ${paymentId} → ${view.state} (${sc.kind})`);
  } catch (e) {
    failed++;
    console.error(`[seed ${i}] FAILED: ${e instanceof Error ? e.message : e}`);
  }
}

const queue = Array.from({ length: COUNT }, (_, i) => i);
await Promise.all(Array.from({ length: POOL }, async () => {
  while (queue.length) await run(queue.shift());
}));
console.log(`\nseeded: ${done} ok, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
