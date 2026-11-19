/**
 * Chain access for the settlement leg — anvil over bare JSON-RPC, or an
 * in-memory mock with the same surface (CHAIN_BACKEND=mock).
 *
 * anvil's unlocked dev accounts do the signing, so this file contains no key
 * handling and no transaction encoding beyond ABI selectors — the realism
 * the demo needs is real transaction hashes, real blocks and real Transfer
 * logs, all of which eth_sendTransaction from an unlocked account provides.
 * (In production the settlement entity signs with its own custody stack —
 * that swap happens entirely inside this module.)
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = JSON.parse(readFileSync(path.join(HERE, 'musdc-artifact.json'), 'utf8'));

const TRANSFER_SELECTOR = ARTIFACT.selectors['transfer(address,uint256)'];
const BALANCE_SELECTOR = ARTIFACT.selectors['balanceOf(address)'];
export const TRANSFER_TOPIC = ARTIFACT.transferTopic;

const pad32 = (hexNo0x) => hexNo0x.toLowerCase().padStart(64, '0');
const addrWord = (addr) => pad32(addr.replace(/^0x/, ''));
const amountWord = (units) => pad32(units.toString(16));

/** '10000.00' mUSDC → 10000000000n (6 decimals), exact. */
export function usdcUnits(amount) {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(amount);
  if (!m) throw new Error(`not a USDC amount: ${amount}`);
  return BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0') || '0');
}
export function unitsToUsdc(units) {
  const s = units.toString().padStart(7, '0');
  return `${s.slice(0, -6)}.${s.slice(-6, -4)}`;
}

export class AnvilChain {
  constructor(url, stateFile) {
    this.url = url;
    this.stateFile = stateFile;
    this.kind = 'anvil';
  }

  async rpc(method, params = []) {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(10_000),
    });
    const json = await res.json();
    if (json.error) throw new Error(`${method}: ${json.error.message}`);
    return json.result;
  }

  async init() {
    const chainId = parseInt(await this.rpc('eth_chainId'), 16);
    this.chainId = chainId;
    this.accounts = await this.rpc('eth_accounts');
    if (this.accounts.length < 10) throw new Error('anvil must expose its 10 default accounts');
    this.deployer = this.accounts[0];
    this.treasury = this.accounts[1];       // the settlement entity's funds
    this.bfiPool = this.accounts.slice(5);  // per-payment deposit addresses

    const saved = existsSync(this.stateFile) ? JSON.parse(readFileSync(this.stateFile, 'utf8')) : {};
    if (saved.usdc && (await this.rpc('eth_getCode', [saved.usdc, 'latest'])) !== '0x') {
      this.usdc = saved.usdc;
      return;
    }
    // Deploy and fund the treasury. anvil auto-mines, so receipts are instant.
    const deployTx = await this.rpc('eth_sendTransaction', [{
      from: this.deployer, data: ARTIFACT.bytecode, gas: '0x2dc6c0',
    }]);
    const rec = await this.receipt(deployTx);
    this.usdc = rec.contractAddress;
    await this.rpc('eth_sendTransaction', [{
      from: this.deployer, to: this.usdc, gas: '0x30d40',
      data: TRANSFER_SELECTOR + addrWord(this.treasury) + amountWord(usdcUnits('100000000.00')),
    }]);
    writeFileSync(this.stateFile, JSON.stringify({ usdc: this.usdc, chainId }, null, 2));
  }

  async receipt(txHash) {
    for (let i = 0; i < 50; i++) {
      const r = await this.rpc('eth_getTransactionReceipt', [txHash]);
      if (r) {
        if (r.status !== '0x1') throw new Error(`tx ${txHash} reverted`);
        return r;
      }
      await new Promise((ok) => setTimeout(ok, 200));
    }
    throw new Error(`tx ${txHash} not mined in time`);
  }

  depositAddressFor(index) {
    return this.bfiPool[index % this.bfiPool.length];
  }

  async transferFromTreasury(to, amount) {
    return this.transferToken(this.treasury, to, amount);
  }

  /** Any unlocked account → ERC-20 transfer. Used by the BFI for refunds. */
  async transferToken(fromAddr, to, amount) {
    const txHash = await this.rpc('eth_sendTransaction', [{
      from: fromAddr, to: this.usdc, gas: '0x30d40',
      data: TRANSFER_SELECTOR + addrWord(to) + amountWord(usdcUnits(amount)),
    }]);
    const rec = await this.receipt(txHash);
    return { txHash, block: parseInt(rec.blockNumber, 16), from: fromAddr };
  }

  async balanceOf(addr) {
    const out = await this.rpc('eth_call', [{
      to: this.usdc, data: BALANCE_SELECTOR + addrWord(addr),
    }, 'latest']);
    return BigInt(out);
  }

  /** Transfer logs into `to`, from `fromBlock` (decimal). */
  async transfersTo(to, fromBlock) {
    const logs = await this.rpc('eth_getLogs', [{
      address: this.usdc,
      topics: [TRANSFER_TOPIC, null, '0x' + addrWord(to)],
      fromBlock: '0x' + fromBlock.toString(16),
      toBlock: 'latest',
    }]);
    return logs.map((l) => ({
      txHash: l.transactionHash,
      block: parseInt(l.blockNumber, 16),
      from: '0x' + l.topics[1].slice(26),
      to: '0x' + l.topics[2].slice(26),
      units: BigInt(l.data),
    }));
  }

  async blockNumber() {
    return parseInt(await this.rpc('eth_blockNumber'), 16);
  }
}

/** Same surface, no chain — for CI and machines without foundry. */
export class MockChain {
  constructor() {
    this.kind = 'mock';
    this.chainId = 31337;
    this.usdc = '0x' + 'f0'.repeat(20);
    this.deployer = mockAddr(0);
    this.treasury = mockAddr(1);
    this.bfiPool = [5, 6, 7, 8, 9].map(mockAddr);
    this.block = 1;
    this.balances = new Map([[this.treasury, usdcUnits('100000000.00')]]);
    this.logs = [];
  }

  async init() {}
  depositAddressFor(index) { return this.bfiPool[index % this.bfiPool.length]; }
  async blockNumber() { return this.block; }
  async balanceOf(addr) { return this.balances.get(addr) ?? 0n; }

  async transferFromTreasury(to, amount) {
    return this.transferToken(this.treasury, to, amount);
  }

  async transferToken(fromAddr, to, amount) {
    const units = usdcUnits(amount);
    const bal = this.balances.get(fromAddr) ?? 0n;
    if (bal < units) throw new Error('mock balance exceeded');
    this.balances.set(fromAddr, bal - units);
    this.balances.set(to, (this.balances.get(to) ?? 0n) + units);
    const txHash = '0x' + randomBytes(32).toString('hex');
    const block = ++this.block;
    this.logs.push({ txHash, block, from: fromAddr, to, units });
    return { txHash, block, from: fromAddr };
  }

  async transfersTo(to, fromBlock) {
    return this.logs.filter((l) => l.to === to && l.block >= fromBlock);
  }
}

function mockAddr(i) {
  return '0x' + String(i).repeat(2).padStart(2, '0').repeat(20).slice(0, 40);
}
