/**
 * Reserve measurement — the on-chain half of the solvency picture.
 *
 * The statement declares addresses; this module reads their token balances
 * directly from the chain at verification time. Reading, not trusting: the
 * figure that lands in the snapshot's reserve report came from `eth_call`,
 * not from the exchange. Entries on chains this deployment cannot reach are
 * reported `DECLARED_ONLY`, never silently counted.
 *
 * Deliberately not here: address-control proofs (the exchange signing from
 * the reserve key). That is a live-tier control; the report says which
 * addresses were measured and leaves ownership as the declared claim it is.
 */

export interface ReserveEntry {
  chain: string;
  asset: string;
  address: string;
  token_contract?: string;
}

export interface ReserveMeasurement {
  chain: string;
  asset: string;
  address: string;
  status: 'MEASURED' | 'DECLARED_ONLY' | 'UNREACHABLE';
  balance?: string;       // base units, integer string
  measured_at?: string;
  detail?: string;
}

export interface SolvencyLine {
  asset: string;
  liabilities: string;
  reserves_measured: string;
  coverage: string | null;   // e.g. "110.42%" — null when nothing was measured
  status: 'MEASURED' | 'NOT_MEASURED';
}

const BALANCE_OF = '0x70a08231';

async function erc20BalanceOf(rpc: string, token: string, holder: string): Promise<bigint> {
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'eth_call',
      params: [{ to: token, data: BALANCE_OF + holder.replace(/^0x/, '').toLowerCase().padStart(64, '0') }, 'latest'],
    }),
    signal: AbortSignal.timeout(5_000),
  });
  const json = await res.json() as { result?: string; error?: { message: string } };
  if (json.error || !json.result) throw new Error(json.error?.message ?? 'empty eth_call result');
  return BigInt(json.result);
}

export async function measureReserves(
  entries: ReserveEntry[], localChain: string, rpcUrl: string,
): Promise<ReserveMeasurement[]> {
  const out: ReserveMeasurement[] = [];
  for (const e of entries) {
    if (e.chain !== localChain || !e.token_contract) {
      out.push({ chain: e.chain, asset: e.asset, address: e.address,
        status: 'DECLARED_ONLY', detail: 'no reachable RPC for this chain in the sandbox' });
      continue;
    }
    try {
      const bal = await erc20BalanceOf(rpcUrl, e.token_contract, e.address);
      out.push({ chain: e.chain, asset: e.asset, address: e.address,
        status: 'MEASURED', balance: bal.toString(), measured_at: new Date().toISOString() });
    } catch (err) {
      out.push({ chain: e.chain, asset: e.asset, address: e.address,
        status: 'UNREACHABLE', detail: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

/** Coverage per asset: measured reserves over committed liabilities. */
export function solvency(
  totals: Record<string, string>, measurements: ReserveMeasurement[],
): SolvencyLine[] {
  return Object.entries(totals).map(([asset, liabilities]) => {
    const measured = measurements
      .filter((m) => m.asset === asset && m.status === 'MEASURED')
      .reduce((acc, m) => acc + BigInt(m.balance ?? '0'), 0n);
    const hasMeasurement = measurements.some((m) => m.asset === asset && m.status === 'MEASURED');
    let coverage: string | null = null;
    if (hasMeasurement && BigInt(liabilities) > 0n) {
      const bps = (measured * 1_000_000n) / BigInt(liabilities);  // percent with 4 implied decimals
      const text = bps.toString().padStart(5, '0');
      coverage = `${text.slice(0, -4)}.${text.slice(-4, -2)}%`;
    }
    return {
      asset,
      liabilities,
      reserves_measured: measured.toString(),
      coverage,
      status: hasMeasurement ? 'MEASURED' as const : 'NOT_MEASURED' as const,
    };
  });
}
