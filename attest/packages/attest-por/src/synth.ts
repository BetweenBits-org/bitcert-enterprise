/**
 * Synthetic liabilities — reproducible demo data, obviously fake.
 *
 * Deterministic from the seed (xorshift) so a demo narrated twice shows the
 * same numbers, and heavy-tailed so the dataset shapes like an exchange's
 * book rather than a uniform grid: most accounts small, a handful large.
 */
import type { PorBalances } from '@stonehash/attest-verify';

export interface SynthUser {
  user_ref: string;
  balances: PorBalances;
}

export function synthesiseLiabilities(opts: {
  users: number;
  assets: string[];
  seed?: number;
}): SynthUser[] {
  let x = (opts.seed ?? 0x5eed) >>> 0 || 1;
  const rnd = (): number => {
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    return x / 0xffffffff;
  };
  const out: SynthUser[] = [];
  for (let i = 0; i < opts.users; i++) {
    const balances: PorBalances = {};
    for (const asset of opts.assets) {
      if (rnd() < 0.25) continue;                       // not every user holds every asset
      const magnitude = Math.floor(rnd() * rnd() * 9) + 2; // heavy tail, 2..10 digits
      let digits = '';
      for (let d = 0; d < magnitude; d++) digits += Math.floor(rnd() * 10);
      const v = digits.replace(/^0+/, '') || '0';
      if (v !== '0') balances[asset] = v;
    }
    if (Object.keys(balances).length === 0) balances[opts.assets[0]!] = '1';
    out.push({ user_ref: `user-${String(i + 1).padStart(7, '0')}`, balances });
  }
  return out;
}
