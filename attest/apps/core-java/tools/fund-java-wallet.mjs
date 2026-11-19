/**
 * Creates the regtest wallet the Java core verifies anchoring with, and funds
 * it once from our own `attest` wallet (owner's instruction, 2026-11-18).
 *
 * RUN ONCE, ON 2026-11-18: wallet `attest-java`, 5 × 0.01 BTC, transaction
 * c419dbd350973394549f8a05b6d3cfd023429fe90771bf913a907ef44c59582d. Kept as
 * the record of how it was done; it refuses to run while the wallet exists.
 * One send is what the owner approved — it is not a top-up tool.
 *
 * The live core funds an anchor in three calls (fund → sign → send) and does
 * not lock what it selected in between. So nothing here lets the wallet pick
 * coins by itself: the one output this spends is locked first, given time to
 * show that nobody had it in hand, and then spent explicitly.
 */
import { rpc } from './btc-rpc.mjs';
import { pending } from './live-pending.mjs';

const FROM = 'attest';
const TO = 'attest-java';
const OUTPUTS = 5;
const EACH = 0.01;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const onDisk = (await rpc('listwalletdir')).wallets.map((w) => w.name);
if (onDisk.includes(TO)) { console.log(`${TO} exists already — nothing done`); process.exit(1); }

// A quiet moment: nothing accepted and waiting for the next batch.
let before = await pending();
for (let i = 0; i < 12 && (before.attestations.accepted ?? 0) + (before.batches.open ?? 0) > 0; i++) { await sleep(5000); before = await pending(); }
console.log('live core before:', JSON.stringify(before));
if ((before.attestations.accepted ?? 0) + (before.batches.open ?? 0) > 0) { console.log('the live core has records waiting to be anchored — not now'); process.exit(1); }

const created = await rpc('createwallet', [TO]);
console.log(`created wallet ${created.name}${created.warnings?.length ? ` (${created.warnings.join('; ')})` : ''}`);
const addresses = [];
for (let i = 0; i < OUTPUTS; i++) addresses.push(await rpc('getnewaddress', [`funding ${i}`], TO));

const unspent = (await rpc('listunspent', [1], FROM)).filter((u) => u.spendable && u.safe).sort((a, b) => b.amount - a.amount);
const coin = unspent[0];
const u = { txid: coin.txid, vout: coin.vout };
console.log(`spending one output of ${FROM}: ${coin.amount} BTC (${coin.txid.slice(0, 16)}…:${coin.vout})`);
await rpc('lockunspent', [false, [u]], FROM);
await sleep(3000);
const still = await rpc('gettxout', [u.txid, u.vout, true]);
if (!still) { console.log('that output was spent meanwhile — nothing sent; run again'); process.exit(1); }

let sent;
try {
  sent = await rpc('send', [addresses.map((a) => ({ [a]: EACH })), null, 'unset', null,
    { inputs: [u], add_inputs: false, fee_rate: 1, change_position: OUTPUTS }], FROM);
} catch (e) {
  await rpc('lockunspent', [true, [u]], FROM).catch(() => {});
  console.log(`not sent (${e.message}); the output is unlocked again`);
  process.exit(1);
}
console.log(`sent ${OUTPUTS} × ${EACH} BTC in one transaction: ${sent.txid} (complete=${sent.complete})`);
const mined = await rpc('generatetoaddress', [1, await rpc('getnewaddress', ['block'], TO)], TO);
const tx = await rpc('gettransaction', [sent.txid], FROM);
console.log(`confirmed in block ${mined[0].slice(0, 16)}… (confirmations ${tx.confirmations}, fee ${Math.round(-tx.fee * 1e8)} sat)`);
const left = await rpc('listlockunspent', [], FROM);
if (left.length > 0) await rpc('lockunspent', [true, left], FROM);
console.log(`${FROM} balance: ${JSON.stringify((await rpc('getbalances', [], FROM)).mine)}; locks left: ${(await rpc('listlockunspent', [], FROM)).length}`);
console.log(`${TO} balance: ${JSON.stringify((await rpc('getbalances', [], TO)).mine)}; outputs: ${(await rpc('listunspent', [1], TO)).map((x) => x.amount).join(', ')}`);
console.log('loaded wallets:', (await rpc('listwallets')).join(', '), '| height', (await rpc('getblockchaininfo')).blocks);
await sleep(4000);
console.log('live core after: ', JSON.stringify(await pending()));
