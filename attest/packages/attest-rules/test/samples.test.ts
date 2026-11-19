/**
 * The embedded samples must stay identical to the files they were copied from.
 *
 * `src/samples.ts` exists so the service never reads a fixture off disk at
 * runtime. The cost of that is two spellings of the same document, and the
 * way two spellings go wrong is silently: someone edits the JSON a test reads
 * and the constant the product ships keeps the old amounts. Then the sandbox
 * demonstrates one thing and the suite pins another.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SAMPLE_POLICY, SAMPLE_SETTLEMENT } from '../src/index.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string): unknown =>
  JSON.parse(readFileSync(path.resolve(HERE, '..', rel), 'utf8'));

test('the embedded evidence is byte-identical in meaning to the fixture', () => {
  assert.deepEqual(SAMPLE_SETTLEMENT, read('fixtures/a-normal-trade-payment.json'));
});

test('the embedded policy is byte-identical in meaning to the policy file', () => {
  assert.deepEqual(SAMPLE_POLICY, read('policies/settlement-match-v1.json'));
});

test('the sample announces that it is not a real payment', () => {
  // A reviewer who downloads a verdict built from this has to be able to tell.
  assert.equal(SAMPLE_SETTLEMENT.dataMode, 'SYNTHETIC');
  assert.equal(SAMPLE_SETTLEMENT.notRealPayment, true);
});
