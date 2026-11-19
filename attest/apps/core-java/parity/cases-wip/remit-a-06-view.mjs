/**
 * The settlement rail, one settlement: `GET /v1/settlements/:id`, `…/chain`, `…/evidence` — on the seeded ledger.
 *
 * Every seeded settlement of the organisation no case writes to is read in each of the three ways: its state and
 * its whole event log; what the settlement chain's node says of its transfer (the stand-in node answers from the
 * transaction hash: confirmed with and without a transfer log, reverted, in the pool, unknown, and each way a read
 * can fail — the route then says "did not answer" and nothing of the failure); its evidence package with the
 * commitment and, where its anchor record got that far, the bundle. The seeded rows are the same in both stores, so
 * whole answers are compared; one member is each server's own: the time at which an anchored record's bundle was put
 * together for this answer.
 *
 * Then what one organisation may learn of another's settlement (nothing: 404, as for one that does not exist), and
 * ids a router has to read with care.
 */
import { remitKit } from '../remit-kit.mjs';

export default (ctx) => {
  const k = remitKit(ctx);
  if (!k) { console.log('remit-a-06: the settlement rail is not seeded — no cases'); return []; }
  const { R, O, key } = k;
  const cases = [];
  const L = '/v1/settlements';
  const one = (name, target, more = {}, o = O.read) => cases.push({ name, target, headers: key(o), ...more });
  /** The bundle of an anchored record says when it was put together: now, on each server. */
  const WHEN = ['$.attestation.bundle.generated_at'];

  // ── every seeded settlement of the read organisation ─────────────────────────────────────────────────────────
  for (const [name, s] of Object.entries(R.settlements.read)) {
    one(`${name} (${s.state}${s.mode === 'B' ? ', mode B' : ''})`, `${L}/${s.id}`, { expect: { '$.state': s.state, '$.payment_id': s.id } });
    one(`${name}: evidence (${s.packaged ? `packaged${s.attestation ? `, anchor record ${s.attestation.status}` : ''}` : 'no package'})`, `${L}/${s.id}/evidence`,
      { volatile: WHEN, ...(s.packaged ? {} : { expect: { '$.error': 'evidence_not_ready' } }) });
    if (!s.chain_tx) one(`${name}: chain (no transfer yet)`, `${L}/${s.id}/chain`, { expect: { '$.error': 'no_chain_tx' } });
  }
  // ── the chain, for each thing the node can say ───────────────────────────────────────────────────────────────
  const STATE = { confirmed: 'confirmed', failed: 'failed', pool: 'pending', noReceipt: 'pending', unknown: 'not_found', 'not a hash': 'not_found' };
  for (const [kind, id] of Object.entries(R.chain)) {
    const state = STATE[kind] ?? (kind.startsWith('confirmed') && !kind.includes('/') ? 'confirmed' : kind.startsWith('failed') ? 'failed' : undefined);
    one(`chain: ${kind}`, `${L}/${id}/chain`, state ? { expect: { '$.state': state } } : {});
  }
  // Settlements that went on past the chain keep their transfer: asked again much later.
  for (const name of ['anchored-a', 'anchored-b', 'returned-after-failure', 'exception-reconciliation', 'exception-notice-refused', 'in-progress', 'l1-hold']) {
    const s = R.settlements.read[name];
    if (s?.chain_tx) one(`chain of ${name} (${s.state})`, `${L}/${s.id}/chain`);
  }
  one('chain with a query', `${L}/${R.chain.confirmed}/chain?tx=0x00&rpc=http://127.0.0.1:1/`);

  // ── the other organisations' seeded settlements, before any case moves them ──────────────────────────────────
  for (const org of ['rail', 'nohook', 'b', 'off', 'deact']) {
    for (const [name, s] of Object.entries(R.settlements[org] ?? {})) {
      one(`${org}: ${name} (${s.state})`, `${L}/${s.id}`, { expect: { '$.state': s.state } }, O[org]);
      if (s.packaged) one(`${org}: ${name}: evidence`, `${L}/${s.id}/evidence`, { volatile: WHEN }, O[org]);
    }
  }
  for (const s of [R.settlements.rail['onchain-00'], R.settlements.rail['rfi-00'], R.settlements.rail['cancellable-accepted-0'], R.settlements.nohook.anchored]) {
    const o = s.id.startsWith('PAY-NOHOOK') ? O.nohook : O.rail;
    one(`evidence of ${s.id} (${s.state})`, `${L}/${s.id}/evidence`, { volatile: WHEN }, o);
    one(`chain of ${s.id} (${s.state})`, `${L}/${s.id}/chain`, {}, o);
  }

  // ── what one organisation learns of another's ────────────────────────────────────────────────────────────────
  const theirs = [R.settlements.rail['terminal-anchored'].id, R.settlements.b.anchored.id, R.settlements.nohook['onchain-0'].id];
  for (const id of theirs) {
    one(`another organisation's settlement ${id}`, `${L}/${id}`, { expect: { '$.error': 'not_found' } });
    one(`another organisation's settlement ${id}: chain`, `${L}/${id}/chain`, { expect: { '$.error': 'not_found' } });
    one(`another organisation's settlement ${id}: evidence`, `${L}/${id}/evidence`, { expect: { '$.error': 'not_found' } });
  }
  one('a settlement of the read organisation, asked for by another', `${L}/PAY-SEED-ANCHORED-A`, { expect: { '$.error': 'not_found' } }, O.rail);
  one('a settlement of the read organisation, asked for by one without a subscription', `${L}/PAY-SEED-ANCHORED-A`, { expect: { '$.error': 'not_found' } }, O.nosub);

  // ── ids to read with care ────────────────────────────────────────────────────────────────────────────────────
  for (const id of ['PAY-NO-SUCH', 'pay-seed-anchored-a', 'PAY-SEED-ANCHORED-a', 'PAY-SEED-ANCHORED-A%20', '%20PAY-SEED-ANCHORED-A', 'PAY-SEED-ANCHORED-A%0A', 'PAY-SEED-ANCHORED-A%00', '%50AY-SEED-ANCHORED-A', 'PAY%2DSEED%2DANCHORED%2DA',
    'PAY-SEED-ANCHORED-A%2Fchain', 'PAY-SEED-ANCHORED-A;x=1', 'PAY-SEED-ANCHORED-A.json', 'PAY-SEED-ANCHORED-%', '%', '%25', '%E0%A4%A', '%FF', '..', '.', '%2E%2E', '*', '%2A', "PAY-SEED-ANCHORED-A'--", 'PAY-SEED-ANCHORED-_', 'PAY-SEED-ANCHORED-%25',
    '한글', '%ED%95%9C%EA%B8%80', '😀', 'a'.repeat(128), 'a'.repeat(129), 'a'.repeat(2000), '0', 'null', 'undefined', 'true']) {
    const shown = JSON.stringify(id.length > 40 ? `${id.slice(0, 6)}… (${id.length})` : id);
    one(`settlement ${shown}`, `${L}/${id}`);
    one(`chain of ${shown}`, `${L}/${id}/chain`);
    one(`evidence of ${shown}`, `${L}/${id}/evidence`, { volatile: WHEN });
  }
  one('a settlement with a query', `${L}/PAY-SEED-ANCHORED-A?events=none&x=1`);
  one('evidence with a query', `${L}/PAY-SEED-ANCHORED-A/evidence?format=zip`, { volatile: WHEN });
  one('a path under a settlement that is no route', `${L}/PAY-SEED-ANCHORED-A/events`);
  one('a path under its evidence', `${L}/PAY-SEED-ANCHORED-A/evidence/package`);
  one('the anchor record of a seeded package, through the document route', `/v1/attestations/${R.settlements.read['anchored-a'].attestation.id}`);
  one('its bundle, through the document route', `/v1/attestations/${R.settlements.read['anchored-a'].attestation.id}/bundle`, { volatile: ['$.generated_at'] });
  return cases;
};
