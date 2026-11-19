/**
 * Entry point for pm2 (`stonehash-evm-gateway`). Kept apart from gateway.mjs
 * so the tests can import the gateway without starting one: pm2 runs a script
 * through its own wrapper, so an "am I the main module" check never fires.
 */
import { createGateway } from './gateway.mjs';

const host = process.env.GATEWAY_HOST ?? '127.0.0.1';
const port = Number(process.env.GATEWAY_PORT ?? 5107);
createGateway({ upstream: process.env.EVM_RPC_URL ?? 'http://127.0.0.1:8545' })
  .listen(port, host, () => console.log(`[evm-gateway] read-only RPC on http://${host}:${port}/rpc`));
