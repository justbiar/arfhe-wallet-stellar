/**
 * Verifies the wallet's shielded-token discovery against live chain state.
 *
 * Mirrors `Network.getShieldedPortfolio` step for step, so a green run here means the
 * wallet's Home, Send and Shield screens will find the same balances. The bug this guards
 * against: discovery used to be driven by a hardcoded aeETH/aeUSDC pair, so a token
 * shielded through the factory had a real encrypted balance that no screen could see —
 * and the funds could not be sent or unshielded from the UI.
 *
 * Read-only. Spends nothing.
 *
 *   node scripts/verify-discovery.mjs [sepolia|arb|base|all]
 */

import 'dotenv/config';
import { JsonRpcProvider, Wallet, Contract, formatUnits, ZeroAddress } from 'ethers';
import { createCofheConfig, createCofheClient } from '@cofhe/sdk/node';
import { Ethers6Adapter } from '@cofhe/sdk/adapters';
import { chains } from '@cofhe/sdk/chains';
import { FheTypes } from '@cofhe/sdk';

const NETWORKS = {
  sepolia: {
    chain: chains.sepolia,
    rpc: process.env.VITE_ALCHEMY_SEPOLIA_API_KEY,
    factory: process.env.VITE_WRAPPER_FACTORY_ADDRESS,
    nativeWrapper: process.env.VITE_WRAPPED_ETH_ADDRESS,
    legacyWrapper: process.env.VITE_WRAPPED_USDC_ADDRESS,
  },
  arb: {
    chain: chains.arbSepolia,
    rpc: process.env.VITE_ALCHEMY_ARBSEPOLIA_API_KEY,
    factory: process.env.VITE_ARB_WRAPPER_FACTORY_ADDRESS,
    nativeWrapper: process.env.VITE_ARB_WRAPPED_ETH_ADDRESS,
    legacyWrapper: process.env.VITE_ARB_WRAPPED_USDC_ADDRESS,
  },
  base: {
    chain: chains.baseSepolia,
    rpc: process.env.VITE_ALCHEMY_BASESEPOLIA_API_KEY,
    factory: process.env.VITE_BASE_WRAPPER_FACTORY_ADDRESS,
    nativeWrapper: process.env.VITE_BASE_WRAPPED_ETH_ADDRESS,
    legacyWrapper: process.env.VITE_BASE_WRAPPED_USDC_ADDRESS,
  },
};

const FACTORY_ABI = [
  'function wrapperCount() view returns (uint256)',
  'function wrappersAt(uint256 offset, uint256 limit) view returns (address[])',
  'function wrapperFor(address underlying) view returns (address)',
];

const WRAPPER_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function rate() view returns (uint256)',
  'function underlying() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function balanceOfIsIndicator() view returns (bool)',
  'function confidentialBalanceOf(address) view returns (bytes32)',
];

const ok = (msg) => console.log(`    ✓ ${msg}`);
const warn = (msg) => console.log(`    ! ${msg}`);

async function runOne(key) {
  const target = NETWORKS[key];
  if (!target?.rpc) throw new Error(`No RPC configured for ${key}`);

  const provider = new JsonRpcProvider(target.rpc);
  const signer = new Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  const me = await signer.getAddress();

  console.log(`\n━━━ ${target.chain.name} (${target.chain.id}) ━━━`);
  console.log(`Account: ${me}`);

  // Step 1 — the known-wrapper set: registry ∪ configured .env addresses.
  const factory = new Contract(target.factory, FACTORY_ABI, provider);
  const count = await factory.wrapperCount();
  const registry = count > 0n ? await factory.wrappersAt(0, count) : [];

  const known = new Set(
    [target.nativeWrapper, target.legacyWrapper, ...registry]
      .filter(Boolean)
      .map((a) => a.toLowerCase())
  );
  ok(`${registry.length} from the registry + ${known.size - registry.length} configured = ${known.size} known wrapper(s)`);

  // A token with two wrappers has two separate backing pools: funds shielded through one
  // cannot be unshielded through the other, and both render under the same symbol. The
  // registry is the arbiter of which is canonical, so anything it does not point at is a
  // duplicate — most often a wrapper deployed standalone instead of through the factory.
  const byUnderlying = new Map();
  for (const address of [...known]) {
    let underlying = '';
    try {
      const u = await new Contract(address, WRAPPER_ABI, provider).underlying();
      if (u && u !== ZeroAddress) underlying = u.toLowerCase();
    } catch { continue; } // native wrapper — the factory never wraps it, so it cannot collide
    if (!underlying) continue;
    byUnderlying.set(underlying, [...(byUnderlying.get(underlying) ?? []), address]);
  }

  const duplicates = [];
  for (const [underlying, addresses] of byUnderlying) {
    if (addresses.length < 2) continue;
    const canonical = (await factory.wrapperFor(underlying).catch(() => ZeroAddress)).toLowerCase();
    duplicates.push({ underlying, addresses, canonical });
  }

  if (duplicates.length > 0) {
    for (const d of duplicates) {
      warn(`${d.underlying} has ${d.addresses.length} wrappers; canonical is ${d.canonical}`);
      for (const a of d.addresses) {
        const pool = await new Contract(d.underlying, WRAPPER_ABI, provider).balanceOf(a).catch(() => 0n);
        console.log(`        ${a === d.canonical ? 'canonical' : 'SUPERSEDED'}  ${a}  backing pool ${pool}`);
      }
    }
    throw new Error(
      `${duplicates.length} token(s) have more than one wrapper. Point the .env address at ` +
      `the factory-registered one; a wrapper must be created through the factory, never standalone.`
    );
  }
  ok('every token has exactly one wrapper — no split backing pools');

  // Step 2 — keep the ones holding a ciphertext for this account.
  const wrappers = [...known];
  const handles = await Promise.all(
    wrappers.map((a) => new Contract(a, WRAPPER_ABI, provider).confidentialBalanceOf(me).catch(() => null))
  );

  const active = wrappers.filter((a, i) => {
    const h = handles[i];
    return (h && BigInt(h) !== 0n) || a === target.nativeWrapper?.toLowerCase();
  });
  ok(`${active.length} wrapper(s) with a ciphertext for this account (or native)`);

  if (active.length === 0) {
    warn('nothing to decrypt — account has never shielded on this network');
    return { key, holdings: [] };
  }

  // Step 3 — decrypt, exactly as the wallet does.
  const client = createCofheClient(createCofheConfig({ supportedChains: [target.chain] }));
  const { publicClient, walletClient } = await Ethers6Adapter(provider, signer);
  await client.connect(publicClient, walletClient);
  await client.permits.getOrCreateSelfPermit();

  const holdings = [];
  for (const address of active) {
    const w = new Contract(address, WRAPPER_ABI, provider);
    const [symbol, decimals, publicBalance, totalSupply, isIndicator] = await Promise.all([
      w.symbol().catch(() => '???'),
      w.decimals().catch(() => 6),
      w.balanceOf(me).catch(() => 0n),
      w.totalSupply().catch(() => 0n),
      w.balanceOfIsIndicator().catch(() => false),
    ]);

    let underlying = '';
    try {
      const u = await w.underlying();
      if (u && u !== ZeroAddress) underlying = u;
    } catch { /* native wrapper */ }

    const handle = await w.confidentialBalanceOf(me);
    let balance = 0n;
    if (BigInt(handle) !== 0n) {
      try {
        balance = await client.decryptForView(BigInt(handle), FheTypes.Uint64).execute();
      } catch (e) {
        warn(`${symbol} @ ${address}: decrypt failed (${e.shortMessage ?? e.message})`);
      }
    }

    holdings.push({ address, symbol, balance: formatUnits(balance, Number(decimals)), underlying, isIndicator, publicBalance, totalSupply });
  }

  console.log('');
  for (const h of holdings) {
    const kind = h.underlying ? `ERC-20 wrapper of ${h.underlying}` : 'native wrapper';
    console.log(`    ${h.symbol.padEnd(8)} ${h.balance.padStart(14)}   ${h.address}  (${kind})`);

    if (!h.isIndicator) throw new Error(`${h.symbol}: balanceOfIsIndicator() is false — the wallet cannot detect this wrapper`);
    if (h.publicBalance !== 0n) throw new Error(`${h.symbol}: balanceOf leaks a fake holding of ${h.publicBalance}`);
    if (h.totalSupply !== 0n) throw new Error(`${h.symbol}: totalSupply leaks ${h.totalSupply}`);
  }
  console.log('');
  ok('every listed wrapper is detectable and reports no phantom public balance');

  return { key, holdings };
}

async function main() {
  if (!process.env.DEPLOYER_PRIVATE_KEY) throw new Error('DEPLOYER_PRIVATE_KEY is not set');

  const arg = process.argv[2] ?? 'all';
  const keys = arg === 'all' ? Object.keys(NETWORKS) : [arg];
  if (keys.some((k) => !NETWORKS[k])) throw new Error(`Unknown network "${arg}" — use sepolia | arb | base | all`);

  const results = [];
  for (const key of keys) results.push(await runOne(key));

  console.log('\n════════════════════════════════════');
  console.log('  DISCOVERY SUMMARY');
  console.log('════════════════════════════════════');
  for (const r of results) {
    const withBalance = r.holdings.filter((h) => parseFloat(h.balance) > 0);
    console.log(`  ${r.key.padEnd(8)} ${r.holdings.length} discovered, ${withBalance.length} with a balance` +
      (withBalance.length ? `: ${withBalance.map((h) => `${h.balance} ${h.symbol}`).join(', ')}` : ''));
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`\n❌ ${err.shortMessage ?? err.message}`);
    process.exit(1);
  });
