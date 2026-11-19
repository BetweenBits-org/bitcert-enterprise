/**
 * Configuration — entirely from the environment, with no path or hostname
 * compiled in.
 *
 * This box is a test server; production is a different instance. So nothing here
 * may assume where it is running. Every path is resolved relative to
 * `STONEHASH_DATA_DIR` (default: `./.data` beside the process), and every
 * external address is supplied rather than guessed. Moving to production is
 * copying the tree and setting the environment.
 */
import path from 'node:path';
import { DEFAULT_SOFT_CAP_BYTES, HARD_CEILING_BYTES } from './btc/inscription.ts';

/** `test` keys and `live` keys never share a database or an anchor backend. */
export type Env = 'test' | 'live';
export type AnchorBackendName = 'regtest' | 'mainnet';

/**
 * What the console bills against: one currency, and per product a monthly
 * fee plus a unit price on the thing that product meters (anchors,
 * settlements, snapshots). Everything at 0 is the sandbox, which the console
 * states as "no charge" rather than as a bill of nothing.
 */
export interface Pricing {
  /** ISO 4217 code, the same for every line. */
  currency: string;
  attest: { monthly_fee: number; per_anchor: number };
  por: { monthly_fee: number; per_snapshot: number };
  remit: { monthly_fee: number; per_settlement: number };
}

export const SANDBOX_PRICING: Pricing = {
  currency: 'KRW',
  attest: { monthly_fee: 0, per_anchor: 0 },
  por: { monthly_fee: 0, per_snapshot: 0 },
  remit: { monthly_fee: 0, per_settlement: 0 },
};

export interface Config {
  env: Env;
  port: number;
  host: string;
  dataDir: string;
  dbPath: string;
  /** `mysql://user:pass@host:port/db` — the production store. Empty → SQLite at dbPath. */
  dbUrl: string;
  anchorBackend: AnchorBackendName;
  /** Written verbatim into every bundle's `bitcoin_network`. */
  bitcoinNetwork: 'regtest' | 'mainnet';
  bitcoind: { url: string; user: string; password: string; wallet: string };
  batch: { maxLeaves: number; flushIntervalMs: number };
  /**
   * Largest document this deployment will inscribe, in bytes.
   *
   * Three numbers bound this and they are not interchangeable. Bitcoin's
   * `MAX_STANDARD_TX_WEIGHT` leaves roughly 390 KB of body before an ordinary
   * node refuses to relay the reveal; a node run with `-acceptnonstdtxn=1`
   * and raised mempool limits — which the regtest node here is — lifts that
   * toward the block limit, where `HARD_CEILING_BYTES` is the last-line
   * guard. This value is the deployment's own policy, and it is the one a
   * caller actually hits.
   *
   * It is deliberately well under standard relay by default. The cost of an
   * inscription is linear in its size and paid in real fees on mainnet, so
   * the default is a number someone can spend by accident without regretting
   * it, not the largest number that would technically work.
   */
  inscriptionMaxBytes: number;
  /**
   * Base URL of a block explorer that indexes **this** chain, or `''`.
   *
   * Empty by default and deliberately so. An explorer pointed at a different
   * regtest chain answers 404 for every transaction we produced, and a link
   * that always fails is worse than no link — it reads as the anchor being
   * missing rather than as the explorer being the wrong one. Set it only once
   * an explorer is indexing the node in `BITCOIND_URL`.
   *
   * A transaction is linked as `<base>/tx/<txid>`, which is what mempool.space
   * and its self-hosted builds use.
   */
  explorerBaseUrl: string;
  /** `0` disables the in-process worker (useful when running one-shot commands). */
  workerTickMs: number;
  publicBaseUrl: string;
  /** Absolute path to the built Playground, or `''` to not serve it. */
  playgroundDir: string;
  /** Absolute path to the built Developer Hub, or `''` to not serve it. */
  docsDir: string;
  /** Absolute path to the built Sandbox Console, or `''` to not serve it. */
  consoleDir: string;
  /**
   * The sandbox console: self-serve accounts for people evaluating the product.
   *
   * Signup is instant and ungated by design — an approval queue between a
   * developer and their first API response is what loses an evaluation. The
   * quota is what makes that safe to offer.
   */
  console: {
    enabled: boolean;
    /** Mark the session cookie `Secure`. Required under HTTPS; breaks plain HTTP. */
    cookieSecure: boolean;
    /**
     * Attestations one org may create per calendar month. There is deliberately
     * no retention setting beside it: an organisation's records never expire,
     * in the sandbox or in production — only the free tier's do.
     */
    monthlyQuota: number;
    /** Per-address cap on signup and login, so neither is a free guessing oracle. */
    authRateLimit: { windowMs: number; max: number };
  };
  /** Honour `x-forwarded-for` when rate limiting. Only true behind a proxy. */
  trustProxy: boolean;
  /** Sandbox key minting is unauthenticated by design; this caps the cost. */
  signupRateLimit: { windowMs: number; max: number };
  /**
   * The no-signup free tier. Unauthenticated by design — the point is that a
   * visitor can anchor their own digest without an account — so the limits are
   * what keeps that from being an open write endpoint.
   */
  publicAnchor: {
    enabled: boolean;
    /** Per-address cap. */
    rateLimit: { windowMs: number; max: number };
    /** Service-wide cap, so many addresses cannot do what one cannot. */
    globalRateLimit: { windowMs: number; max: number };
    /** Days a free anchor stays retrievable here. The bundle outlives it. */
    retentionDays: number;
    /** Origins allowed to call it from a browser. `*` in a test deployment. */
    allowedOrigins: string[];
  };
  /**
   * Remit — the cross-border settlement rail (sandbox scope, arch doc stage 0).
   *
   * Everything here is corridor plumbing for the VN→SG demo: where the partner
   * simulator lives, the static quote table, and the platform's own signing
   * key. Rates are configuration because a sandbox quote must be reproducible
   * in the evidence that cites it.
   */
  remit: {
    enabled: boolean;
    /** demo-partners base URL (BFI · payout bank · settlement wallet sim). */
    partnersBase: string;
    /** Registers partner institutions into the Trust Registry. Sandbox token. */
    adminToken: string;
    /** PEM path for the platform ES256 key; created on first boot. */
    platformKeyPath: string;
    /** Treat six-axis businessFinality=DEMO_ONLY as acceptable (sandbox). */
    acceptDemoFinality: boolean;
    quoteTtlMs: number;
    rates: { usdVnd: string; usdSgd: string };
    feeUsd: string;
    /** CAIP-2 label written into chainTransfer evidence. */
    chainLabel: string;
    /**
     * Per-transaction explorer link for the settlement chain, or `''`.
     *
     * The same reasoning as `explorerBaseUrl`, one chain over: a link that
     * always fails reads as the transfer being missing, not as the explorer
     * being the wrong one. The sandbox rail is a local Anvil chain with no
     * explorer, so it stays unset there; a public chain sets something like
     * `https://etherscan.io/tx/{tx}`, with `{tx}` where the hash goes.
     */
    explorerTxUrl: string;
    /**
     * JSON-RPC of the settlement chain, read-only, for the console's "what does
     * the chain say about this transfer" lookup. Server-side only — the browser
     * never sees it, which matters on a dev chain whose accounts are unlocked.
     * The sandbox default is the local test chain; live must set it. Checked
     * at boot: an http(s) URL with no credentials in it, or the boot stops.
     */
    chainRpc: string;
    webhookMaxAttempts: number;
    /** RPC used to measure declared PoR reserve balances on the local chain. */
    porChainRpc: string;
  };
  /** The price list the console's billing card is computed from. */
  pricing: Pricing;
}

function int(name: string, dflt: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got ${raw}`);
  return n;
}

function str(name: string, dflt: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? dflt : raw;
}

const PRICE_KEYS: Record<'attest' | 'por' | 'remit', string[]> = {
  attest: ['monthly_fee', 'per_anchor'],
  por: ['monthly_fee', 'per_snapshot'],
  remit: ['monthly_fee', 'per_settlement'],
};

/**
 * A price list from the environment, as JSON of the `Pricing` shape. Every
 * key is required and no other key is accepted: a misspelt price must stop
 * the boot, not silently bill at zero.
 */
function pricing(name: string, dflt: Pricing): Pricing {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return dflt;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error(`${name} must be JSON`); }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (k !== 'currency' && !(k in PRICE_KEYS)) throw new Error(`${name}: unknown key ${JSON.stringify(k)}`);
  }
  const currency = obj['currency'];
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
    throw new Error(`${name}: currency must be an ISO 4217 code such as "KRW"`);
  }
  const prices = (product: keyof typeof PRICE_KEYS): Record<string, number> => {
    const p = obj[product];
    if (typeof p !== 'object' || p === null || Array.isArray(p)) throw new Error(`${name}: ${product} must be an object`);
    const rec = p as Record<string, unknown>;
    for (const k of Object.keys(rec)) {
      if (!PRICE_KEYS[product].includes(k)) throw new Error(`${name}: unknown key ${product}.${k}`);
    }
    const out: Record<string, number> = {};
    for (const k of PRICE_KEYS[product]) {
      const v = rec[k];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        throw new Error(`${name}: ${product}.${k} must be a non-negative number`);
      }
      out[k] = v;
    }
    return out;
  };
  return {
    currency,
    attest: prices('attest') as Pricing['attest'],
    por: prices('por') as Pricing['por'],
    remit: prices('remit') as Pricing['remit'],
  };
}

/**
 * A link template with one `{tx}` placeholder, or `''` when unset.
 *
 * Checked at boot like the price list: a template that cannot take a hash
 * would put a dead link beside every settlement, and nobody would notice
 * until a customer clicked one.
 */
function txUrlTemplate(name: string): string {
  const raw = str(name, '');
  if (raw === '') return '';
  if (!/^https?:\/\//.test(raw)) {
    throw new Error(`${name} must start with http:// or https://, got ${JSON.stringify(raw)}`);
  }
  if (!raw.includes('{tx}')) {
    throw new Error(`${name} must contain the literal {tx} placeholder, e.g. https://etherscan.io/tx/{tx}`);
  }
  return raw;
}

/**
 * A JSON-RPC address the server calls, or `''` when unset.
 *
 * Checked at boot because both ways it goes wrong are quiet until they leak:
 * a value that does not parse, or one with `user:pass@`, makes Node's fetch
 * throw an error quoting the whole URL, and the lookups that use it answer
 * tenants. Userinfo credentials never worked here anyway — fetch refuses to
 * send them — so refusing them at boot stops nothing that ran. The errors
 * name the variable and never the value, which is what must not reach a log.
 */
function rpcUrl(name: string, dflt: string): string {
  const raw = str(name, dflt);
  if (raw === '') return '';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute http:// or https:// URL; the value set does not parse as one`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${name} must be an http:// or https:// URL`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error(`${name} must not carry credentials (user:pass@ in the URL): fetch will not send them, `
      + 'and the error it throws instead quotes them');
  }
  return raw;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const env = str('STONEHASH_ENV', 'test') as Env;
  if (env !== 'test' && env !== 'live') {
    throw new Error(`STONEHASH_ENV must be "test" or "live", got ${JSON.stringify(env)}`);
  }

  const backend = str('ANCHOR_BACKEND', 'regtest') as AnchorBackendName;
  if (backend !== 'regtest' && backend !== 'mainnet') {
    throw new Error(`ANCHOR_BACKEND must be "regtest" or "mainnet", got ${JSON.stringify(backend)}`);
  }
  // A private chain cannot back a production environment: a third party has no
  // way to confirm an anchor we mined ourselves. Catch it at boot, not in a
  // customer's audit.
  if (env === 'live' && backend === 'regtest' && str('ALLOW_REGTEST_IN_LIVE', '') !== '1') {
    throw new Error(
      'refusing to start: STONEHASH_ENV=live with ANCHOR_BACKEND=regtest. ' +
      'Proofs on a private chain are not publicly verifiable. ' +
      'Set ALLOW_REGTEST_IN_LIVE=1 only if this is a deliberate internal deployment.',
    );
  }

  const dataDir = path.resolve(str('STONEHASH_DATA_DIR', path.join(process.cwd(), '.data')));

  const cfg: Config = {
    env,
    port: int('PORT', 8787),
    host: str('HOST', '127.0.0.1'),
    dataDir,
    dbPath: str('STONEHASH_DB_PATH', path.join(dataDir, `attest-${env}.sqlite`)),
    dbUrl: str('STONEHASH_DB_URL', ''),
    anchorBackend: backend,
    bitcoinNetwork: backend === 'mainnet' ? 'mainnet' : 'regtest',
    bitcoind: {
      url: str('BITCOIND_URL', 'http://127.0.0.1:18443'),
      user: str('BITCOIND_USER', ''),
      password: str('BITCOIND_PASSWORD', ''),
      wallet: str('BITCOIND_WALLET', 'attest'),
    },
    batch: {
      maxLeaves: int('BATCH_MAX_LEAVES', 1024),
      flushIntervalMs: int('BATCH_FLUSH_INTERVAL_MS', 10_000),
    },
    // Clamped, not validated: a deployment that sets this above what Bitcoin
    // can carry should get the largest workable value, not a boot failure.
    explorerBaseUrl: str('EXPLORER_BASE_URL', '').replace(/\/+$/, ''),
    inscriptionMaxBytes: Math.min(
      Math.max(int('INSCRIPTION_MAX_BYTES', DEFAULT_SOFT_CAP_BYTES), 1),
      HARD_CEILING_BYTES,
    ),
    workerTickMs: int('WORKER_TICK_MS', 2_000),
    publicBaseUrl: str('PUBLIC_BASE_URL', ''),
    playgroundDir: str('PLAYGROUND_DIR', ''),
    docsDir: str('DOCS_DIR', ''),
    consoleDir: str('CONSOLE_DIR', ''),
    console: {
      enabled: str('CONSOLE_ENABLED', '1') === '1',
      cookieSecure: str('COOKIE_SECURE', '') === '1',
      monthlyQuota: int('CONSOLE_MONTHLY_QUOTA', 1_000),
      authRateLimit: {
        windowMs: int('CONSOLE_AUTH_WINDOW_MS', 900_000),
        max: int('CONSOLE_AUTH_MAX', 20),
      },
    },
    trustProxy: str('TRUST_PROXY', '') === '1',
    signupRateLimit: {
      windowMs: int('SIGNUP_RATE_WINDOW_MS', 3_600_000),
      max: int('SIGNUP_RATE_MAX', 20),
    },
    publicAnchor: {
      enabled: str('PUBLIC_ANCHOR_ENABLED', '1') === '1',
      rateLimit: {
        windowMs: int('PUBLIC_ANCHOR_WINDOW_MS', 3_600_000),
        max: int('PUBLIC_ANCHOR_MAX', 10),
      },
      globalRateLimit: {
        windowMs: int('PUBLIC_ANCHOR_GLOBAL_WINDOW_MS', 3_600_000),
        max: int('PUBLIC_ANCHOR_GLOBAL_MAX', 500),
      },
      retentionDays: int('PUBLIC_ANCHOR_RETENTION_DAYS', 30),
      allowedOrigins: str('PUBLIC_ANCHOR_ORIGINS', '*').split(',').map((o) => o.trim()).filter(Boolean),
    },
    remit: {
      enabled: str('REMIT_ENABLED', env === 'test' ? '1' : '0') === '1',
      partnersBase: str('REMIT_PARTNERS_BASE', 'http://127.0.0.1:3300'),
      // Sandbox default so provisioning works out of the box; live must set it.
      adminToken: str('REMIT_ADMIN_TOKEN', env === 'test' ? 'remit-admin-sandbox' : ''),
      platformKeyPath: str('REMIT_PLATFORM_KEY_PATH', path.join(dataDir, 'platform-remit-key.pem')),
      acceptDemoFinality: str('REMIT_ACCEPT_DEMO_FINALITY', env === 'test' ? '1' : '0') === '1',
      quoteTtlMs: int('REMIT_QUOTE_TTL_MS', 600_000),
      rates: {
        usdVnd: str('REMIT_RATE_USD_VND', '25380'),
        usdSgd: str('REMIT_RATE_USD_SGD', '1.3350'),
      },
      feeUsd: str('REMIT_FEE_USD', '25.00'),
      chainLabel: str('REMIT_CHAIN_LABEL', 'eip155:31337'),
      explorerTxUrl: txUrlTemplate('REMIT_EXPLORER_TX_URL'),
      chainRpc: rpcUrl('REMIT_CHAIN_RPC', env === 'test' ? 'http://127.0.0.1:8545' : ''),
      webhookMaxAttempts: int('REMIT_WEBHOOK_MAX_ATTEMPTS', 5),
      // Same check: the reserve measurement fetches it the same way, and its
      // report is stored with the snapshot and served on the public endpoint.
      porChainRpc: rpcUrl('POR_CHAIN_RPC', 'http://127.0.0.1:8545'),
    },
    pricing: pricing('CONSOLE_PRICING', SANDBOX_PRICING),
  };
  return { ...cfg, ...overrides };
}
