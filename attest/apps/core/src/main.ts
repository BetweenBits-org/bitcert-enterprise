/**
 * Entry point. One process: HTTP server plus the batch worker on a timer.
 *
 * Start with `node src/main.ts`. There is no build step and no runtime
 * dependency — Node strips the type annotations itself, SQLite and the HTTP
 * server are built in. Deployment is: copy the tree, set the environment, run.
 */
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { AttestService } from './service.ts';
import { BatchWorker } from './worker.ts';
import { BitcoindAnchorBackend } from './anchor/bitcoind.ts';
import { inscribeDocument } from './anchor/inscribe.ts';
import { buildRouter } from './http/routes.ts';
import { RemitStore } from './remit/store.ts';
import { Registry } from './remit/registry.ts';
import { RemitOrchestrator } from './remit/orchestrator.ts';
import { WebhookOutbox } from './remit/webhook.ts';
import { RemitWorker } from './remit/worker.ts';
import { TripleAProfileSim } from './remit/partners-client.ts';
import { loadOrCreatePlatformKey } from './remit/sign.ts';
import type { RemitServices } from './remit/routes.ts';
import { backfillSnapshotKeys } from './por/routes.ts';

const VERSION = '0.1.0';

function log(msg: string, extra?: Record<string, unknown>): void {
  const line = { ts: new Date().toISOString(), msg, ...(extra ?? {}) };
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const db = await openDb(cfg.dbUrl || cfg.dbPath, log);

  const backend = new BitcoindAnchorBackend({
    network: cfg.bitcoinNetwork,
    url: cfg.bitcoind.url,
    user: cfg.bitcoind.user,
    password: cfg.bitcoind.password,
    wallet: cfg.bitcoind.wallet,
  });

  /*
   * Inscription needs the node directly, not through `AnchorBackend`.
   *
   * The backend interface commits 32 bytes and reports on them — deliberately
   * narrow, so batching and bundling stay ignorant of which chain is beneath.
   * An inscription needs to fund an output, build a tapscript and sign a
   * script-path spend, none of which fits that shape and none of which should
   * be forced into it. So it is wired as its own capability and the service
   * treats its absence as "this deployment cannot inscribe".
   */
  const inscriber = async (body: Uint8Array, contentType: string) => inscribeDocument({
    rpcOpts: { url: cfg.bitcoind.url, user: cfg.bitcoind.user, password: cfg.bitcoind.password },
    wallet: cfg.bitcoind.wallet,
    network: cfg.bitcoinNetwork,
    body,
    contentType,
    maxBodyBytes: cfg.inscriptionMaxBytes,
  });

  const svc = new AttestService(db, backend, cfg.batch.maxLeaves, inscriber);
  // Every free-tier record belongs to one org, created once. Keeping them in a
  // named org rather than a null tenant means the ordinary queries, the batcher
  // and the retention sweep all work on them unchanged.
  const publicOrgId = await svc.ensureOrg('public-free-tier', 'Public free tier (no signup)');

  /*
   * The remit rail. Optional by configuration: a deployment without it has no
   * remit routes, no partner connectors and no second worker. The platform
   * registers itself in the Trust Registry at boot so its webhook and event
   * signatures resolve like any other institution's.
   */
  let remit: RemitServices | undefined;
  let remitWorker: RemitWorker | null = null;
  if (cfg.remit.enabled) {
    const platform = loadOrCreatePlatformKey(cfg.remit.platformKeyPath);
    const registry = new Registry(db);
    await registry.upsert({
      id: 'STONEHASH', role: 'STONEHASH', name: 'StoneHash (platform)',
      signing_spki: platform.publicSpkiBase64,
      authority: ['REQUEST_ACCEPTED', 'BANK_AUTHORIZATION_VERIFIED', 'TRAVEL_RULE_SENT',
        'SETTLEMENT_INSTRUCTED', 'SETTLEMENT_RECONCILED', 'EVIDENCE_COMMITTED', 'EVIDENCE_ANCHORED', 'webhook'],
    });
    const store = new RemitStore(db);
    // Settlements accepted before the platform kept one settlement per message: give each its place.
    const backfilled = await store.backfillSourceRefs();
    if (backfilled.claimed + backfilled.duplicates + backfilled.unreadable + backfilled.failed > 0) {
      log(backfilled.failed > 0
        ? 'remit source references: some settlements could not be given their place — a message of theirs sent again would not be recognised'
        : 'remit source references backfilled', backfilled);
    }
    const outbox = new WebhookOutbox(db, platform, cfg.remit.webhookMaxAttempts, log);
    const partners = new TripleAProfileSim(cfg.remit.partnersBase);
    const orchestrator = new RemitOrchestrator({
      store, registry, svc, bfi: partners, wallet: partners, outbox, platform,
      acceptDemoFinality: cfg.remit.acceptDemoFinality,
      chainLabel: cfg.remit.chainLabel,
      log,
    });
    remit = {
      store, registry, orchestrator, platform,
      quoteCfg: {
        rates: cfg.remit.rates, feeUsd: cfg.remit.feeUsd,
        ttlMs: cfg.remit.quoteTtlMs, chainLabel: cfg.remit.chainLabel,
      },
    };
    remitWorker = new RemitWorker(orchestrator, outbox, cfg.workerTickMs > 0 ? 2_000 : 0, log);
    // Reserve snapshots stored before each kept its own verifying key.
    try {
      const filled = await backfillSnapshotKeys({ db, registry });
      if (filled > 0) log('reserve snapshots given their signing key', { filled });
    } catch (e) {
      log('reserve snapshot key backfill skipped', { error: e instanceof Error ? e.message : String(e) });
    }
    log('remit rail enabled', { partners: cfg.remit.partnersBase, corridor: 'VN→SG' });
  }

  const router = buildRouter({ cfg, db, svc, backend, version: VERSION, publicOrgId,
    ...(remit ? { remit } : {}) });

  const server = router.listen(cfg.port, cfg.host);
  log('attest-core listening', {
    version: VERSION, env: cfg.env, host: cfg.host, port: cfg.port,
    network: backend.network, anchorBackend: backend.name,
    db: cfg.dbUrl ? `mysql(${new URL(cfg.dbUrl).pathname.slice(1)})` : cfg.dbPath,
  });

  // Reported, not enforced: an unreachable node must not stop the API from
  // accepting attestations. They queue as `accepted` until the chain returns.
  const chain = await backend.health();
  log(chain.ok ? 'anchor backend reachable' : 'anchor backend NOT reachable', chain);
  if (cfg.bitcoinNetwork === 'regtest') {
    log('NOTE: regtest is a private chain — proofs issued here are not publicly verifiable');
  }

  const worker = new BatchWorker(svc, {
    tickMs: cfg.workerTickMs,
    flushIntervalMs: cfg.batch.flushIntervalMs,
    maxLeaves: cfg.batch.maxLeaves,
    log,
    // On a private chain nothing mines on its own, so an anchor would sit
    // unconfirmed forever and the free tier would never complete. Generating a
    // block after submitting is what regtest is for; it is refused on mainnet.
    ...(backend.network === 'regtest'
      ? { afterAnchor: async () => { await backend.generate(1); } }
      : {}),
    retentionDays: cfg.publicAnchor.retentionDays,
  });
  worker.start();
  remitWorker?.start();

  const shutdown = (signal: string): void => {
    log('shutting down', { signal });
    worker.stop();
    remitWorker?.stop();
    server.close(() => { void db.close().finally(() => process.exit(0)); });
    // Do not hang forever on a stuck connection.
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e: unknown) => {
  log('fatal', { error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
