/**
 * End-to-end verification of the confidential ERC-20 flow on a live CoFHE testnet.
 *
 * The native-ETH counterpart is scripts/verify-fhe.mjs. This one covers the path that
 * goes through {ArfheWrapperFactory}, which is what lets the wallet shield arbitrary
 * ERC-20s rather than a hardcoded pair:
 *
 *   0. wrapperFor / createWrapper   resolve (or deploy) the token's wrapper
 *   1. approve + shield             ERC-20      -> encrypted balance
 *   2. decryptForView               read the encrypted balance back (needs a permit)
 *   3. confidentialTransfer         send an encrypted amount to a fresh address
 *   4. unshield                     burn + open a claim
 *   5. decryptForTx                 decrypt the burned amount with a verifiable signature
 *   6. claimUnshielded              settle the claim, the ERC-20 returns
 *
 * Also asserts the two properties the wallet's discovery depends on:
 *   - the wrapper reports `balanceOfIsIndicator() == true` (how wrappers are detected)
 *   - `balanceOf` / `totalSupply` are zero (no fake ~7984 holding in any wallet)
 *
 * Spends real testnet ERC-20 plus gas from DEPLOYER_PRIVATE_KEY.
 *
 *   node scripts/verify-fhe-erc20.mjs [sepolia|arb|base]
 */

import 'dotenv/config';
import { JsonRpcProvider, Wallet, Contract, parseUnits, formatUnits, ZeroAddress } from 'ethers';
import { createCofheConfig, createCofheClient } from '@cofhe/sdk/node';
import { Ethers6Adapter } from '@cofhe/sdk/adapters';
import { chains } from '@cofhe/sdk/chains';
import { Encryptable, FheTypes } from '@cofhe/sdk';

const NETWORKS = {
  sepolia: {
    chain: chains.sepolia,
    rpc: process.env.VITE_ALCHEMY_SEPOLIA_API_KEY,
    factory: process.env.VITE_WRAPPER_FACTORY_ADDRESS,
    token: process.env.VITE_SEPOLIA_USDC_ADDRESS,
  },
  arb: {
    chain: chains.arbSepolia,
    rpc: process.env.VITE_ALCHEMY_ARBSEPOLIA_API_KEY,
    factory: process.env.VITE_ARB_WRAPPER_FACTORY_ADDRESS,
    token: process.env.VITE_ARB_SEPOLIA_USDC_ADDRESS,
  },
  base: {
    chain: chains.baseSepolia,
    rpc: process.env.VITE_ALCHEMY_BASESEPOLIA_API_KEY,
    factory: process.env.VITE_BASE_WRAPPER_FACTORY_ADDRESS,
    token: process.env.VITE_BASE_SEPOLIA_USDC_ADDRESS,
  },
};

const FACTORY_ABI = [
  'function wrapperFor(address underlying) view returns (address)',
  'function createWrapper(address underlying) returns (address)',
  'function wrapperCount() view returns (uint256)',
  'function wrappersAt(uint256 offset, uint256 limit) view returns (address[])',
];

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

const WRAPPER_ABI = [
  'function decimals() view returns (uint8)',
  'function rate() view returns (uint256)',
  'function symbol() view returns (string)',
  'function underlying() view returns (address)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function balanceOfIsIndicator() view returns (bool)',
  'function confidentialBalanceOf(address) view returns (bytes32)',
  'function getUserClaims(address) view returns (tuple(address to,bytes32 ctHash,uint64 requestedAmount,uint64 decryptedAmount,bool claimed)[])',
  'function shield(address to, uint256 amount) returns (bytes32)',
  'function unshield(address from, address to, uint64 amount) returns (bytes32)',
  'function claimUnshielded(bytes32 ctHash, uint64 decryptedAmount, bytes decryptionProof)',
  'function claimUnshieldedBatch(bytes32[] ctHashes, uint64[] decryptedAmounts, bytes[] decryptionProofs)',
  'function confidentialTransfer(address to, (uint256 ctHash, uint8 securityZone, uint8 utype, bytes signature) encryptedAmount) returns (bytes32)',
];

/** Amount of the underlying token to shield, in its own decimals. */
const SHIELD_AMOUNT = process.env.VERIFY_SHIELD_ERC20 ?? '2';

let step = 0;
const log = (msg) => console.log(`\n[${++step}] ${msg}`);
const ok = (msg) => console.log(`    ✓ ${msg}`);

/**
 * Approve `spender` for `amount` and wait until the RPC actually reports it.
 *
 * The receipt alone is not enough: `shield` is gas-estimated against whatever the node
 * currently returns, and Base Sepolia serves pre-transaction state for several seconds —
 * producing "transfer amount exceeds allowance" for an approval that has already
 * confirmed. `Network.shieldERC20` waits the same way.
 */
async function approveAndWait(token, spender, owner, amount) {
  let allowance = await token.allowance(owner, spender);
  if (allowance >= amount) return 'existing allowance is sufficient';

  const tx = await token.approve(spender, amount);
  await tx.wait();

  for (let attempt = 0; allowance < amount && attempt < 10; attempt++) {
    await new Promise((r) => setTimeout(r, 2000));
    allowance = await token.allowance(owner, spender);
  }
  if (allowance < amount) throw new Error('Approval confirmed but is still not visible to the RPC');
  return `approved and visible (tx ${tx.hash})`;
}

/** Re-read until the handle changes; some RPCs serve pre-tx state after the receipt. */
async function waitForHandleChange(read, previous, label) {
  let handle = await read();
  for (let attempt = 0; handle === previous && attempt < 10; attempt++) {
    await new Promise((r) => setTimeout(r, 2500));
    handle = await read();
  }
  if (handle === previous) throw new Error(`${label}: handle never changed (stale RPC?)`);
  return handle;
}

async function main() {
  const key = process.argv[2] ?? 'sepolia';
  const target = NETWORKS[key];
  if (!target) throw new Error(`Unknown network "${key}" — use sepolia | arb | base`);
  if (!target.rpc) throw new Error(`No RPC configured for ${key}`);
  if (!target.factory) throw new Error(`No wrapper factory configured for ${key}`);
  if (!target.token) throw new Error(`No test ERC-20 configured for ${key}`);
  if (!process.env.DEPLOYER_PRIVATE_KEY) throw new Error('DEPLOYER_PRIVATE_KEY is not set');

  const provider = new JsonRpcProvider(target.rpc);
  const signer = new Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  const me = await signer.getAddress();

  const underlying = new Contract(target.token, ERC20_ABI, signer);
  const factory = new Contract(target.factory, FACTORY_ABI, signer);

  const [tokenSymbol, tokenDecimals] = await Promise.all([underlying.symbol(), underlying.decimals()]);

  console.log(`Network : ${target.chain.name} (${target.chain.id})`);
  console.log(`Account : ${me}`);
  console.log(`Token   : ${tokenSymbol} @ ${target.token} (${tokenDecimals} decimals)`);
  console.log(`Factory : ${target.factory}`);

  // ── 0. Resolve or deploy the wrapper ───────────────────────────────
  log('Resolving the confidential wrapper via the factory registry');
  let wrapperAddress = await factory.wrapperFor(target.token);

  if (wrapperAddress === ZeroAddress) {
    ok('none registered yet — deploying one');
    const createTx = await factory.createWrapper(target.token);
    ok(`tx ${createTx.hash}`);
    await createTx.wait();

    // Base Sepolia keeps answering from pre-transaction state for a few seconds after the
    // receipt, so a single read here reports address(0) for a wrapper that exists.
    for (let attempt = 0; wrapperAddress === ZeroAddress && attempt < 8; attempt++) {
      await new Promise((r) => setTimeout(r, 2000));
      wrapperAddress = await factory.wrapperFor(target.token);
    }
    if (wrapperAddress === ZeroAddress) throw new Error('createWrapper did not register a wrapper');
  }
  ok(`wrapper ${wrapperAddress}`);

  const wrapper = new Contract(wrapperAddress, WRAPPER_ABI, signer);

  // The registry must be enumerable, because that is how the wallet finds shielded
  // balances for tokens the user no longer holds publicly.
  const count = await factory.wrapperCount();
  const enumerated = await factory.wrappersAt(0, count);
  if (!enumerated.map((a) => a.toLowerCase()).includes(wrapperAddress.toLowerCase())) {
    throw new Error('Wrapper is not enumerable through wrappersAt — wallet discovery would miss it');
  }
  ok(`registry enumerates ${count} wrapper(s), including this one`);

  // ── 0b. Discovery + no-fake-balance invariants ─────────────────────
  log('Checking the wrapper display invariants');
  const [isIndicator, wrapperSymbol, wrapperDecimals, rate, publicBalance, totalSupply, boundUnderlying] =
    await Promise.all([
      wrapper.balanceOfIsIndicator(),
      wrapper.symbol(),
      wrapper.decimals(),
      wrapper.rate(),
      wrapper.balanceOf(me),
      wrapper.totalSupply(),
      wrapper.underlying(),
    ]);

  if (isIndicator !== true) throw new Error('balanceOfIsIndicator() is not true — wallets cannot detect this wrapper');
  ok('balanceOfIsIndicator() == true');

  if (publicBalance !== 0n) throw new Error(`balanceOf leaks a fake holding: ${publicBalance}`);
  if (totalSupply !== 0n) throw new Error(`totalSupply leaks a fake supply: ${totalSupply}`);
  ok('balanceOf and totalSupply are both 0 — no phantom ~7984 holding');

  if (boundUnderlying.toLowerCase() !== target.token.toLowerCase()) {
    throw new Error(`underlying() is ${boundUnderlying}, expected ${target.token}`);
  }
  ok(`underlying() points back at ${tokenSymbol}`);
  console.log(`    symbol ${wrapperSymbol}, confidential decimals ${wrapperDecimals}, rate ${rate}`);

  // ── 0c. Starting state ─────────────────────────────────────────────
  // Every assertion below is on the delta, so the script is safely re-runnable.
  log('Connecting @cofhe/sdk and reading the existing shielded balance');
  const client = createCofheClient(createCofheConfig({ supportedChains: [target.chain] }));
  const { publicClient, walletClient } = await Ethers6Adapter(provider, signer);
  await client.connect(publicClient, walletClient);
  await client.permits.getOrCreateSelfPermit();
  ok(`connected as ${client.connection.account}`);

  const startHandle = await wrapper.confidentialBalanceOf(me);
  const startBalance = BigInt(startHandle) === 0n
    ? 0n
    : await client.decryptForView(BigInt(startHandle), FheTypes.Uint64).execute();
  ok(`starting shielded balance ${formatUnits(startBalance, Number(wrapperDecimals))} ${wrapperSymbol}`);

  // Settle anything left open by an earlier interrupted run, so the assertions below are
  // about this run only. Also the honest thing to do: an open claim is burned balance the
  // account has not received back yet.
  const stale = (await wrapper.getUserClaims(me)).filter((c) => !c.claimed);
  if (stale.length > 0) {
    ok(`${stale.length} claim(s) left open by an earlier run — settling them first`);
    const proofs = [];
    for (const c of stale) {
      const { decryptedValue, signature } = await client.decryptForTx(BigInt(c.ctHash)).withoutPermit().execute();
      proofs.push({ ctHash: c.ctHash, value: decryptedValue, signature });
    }
    const cleanupTx = proofs.length === 1
      ? await wrapper.claimUnshielded(proofs[0].ctHash, proofs[0].value, proofs[0].signature)
      : await wrapper.claimUnshieldedBatch(
          proofs.map((p) => p.ctHash), proofs.map((p) => p.value), proofs.map((p) => p.signature));
    await cleanupTx.wait();
    ok(`recovered ${formatUnits(proofs.reduce((s, p) => s + p.value, 0n), Number(wrapperDecimals))} ${wrapperSymbol}`);
  }

  const startUnderlying = await underlying.balanceOf(me);
  ok(`starting public balance ${formatUnits(startUnderlying, Number(tokenDecimals))} ${tokenSymbol}`);

  const shieldValue = parseUnits(SHIELD_AMOUNT, Number(tokenDecimals));
  if (startUnderlying < shieldValue) {
    throw new Error(
      `Need ${SHIELD_AMOUNT} ${tokenSymbol} to run, have ${formatUnits(startUnderlying, Number(tokenDecimals))}. ` +
      `Set VERIFY_SHIELD_ERC20 lower or fund the account.`
    );
  }

  // ── 1. Approve + shield ────────────────────────────────────────────
  log(`Shielding ${SHIELD_AMOUNT} ${tokenSymbol}`);
  ok(await approveAndWait(underlying, wrapperAddress, me, shieldValue));

  const shieldTx = await wrapper.shield(me, shieldValue);
  ok(`shield tx ${shieldTx.hash}`);
  await shieldTx.wait();
  ok('confirmed');

  const handle = await waitForHandleChange(
    () => wrapper.confidentialBalanceOf(me), startHandle, 'shield'
  );
  ok(`handle ${handle.slice(0, 18)}…`);

  // ── 2. Decrypt for view ────────────────────────────────────────────
  log('Decrypting the shielded balance (decryptForView)');
  const balance = await client.decryptForView(BigInt(handle), FheTypes.Uint64).execute();
  ok(`balance = ${formatUnits(balance, Number(wrapperDecimals))} ${wrapperSymbol}`);

  const expectedDelta = shieldValue / rate;
  if (balance - startBalance !== expectedDelta) {
    throw new Error(`Expected +${expectedDelta} confidential units, got +${balance - startBalance}`);
  }
  ok('increased by exactly the shielded amount');

  const afterShieldUnderlying = await underlying.balanceOf(me);
  if (startUnderlying - afterShieldUnderlying !== shieldValue) {
    throw new Error('Public balance did not decrease by the shielded amount');
  }
  ok(`public balance now ${formatUnits(afterShieldUnderlying, Number(tokenDecimals))} ${tokenSymbol}`);

  // ── 3. Confidential transfer ───────────────────────────────────────
  const recipient = Wallet.createRandom().address;
  const transferAmount = expectedDelta / 2n;
  log(`Confidential transfer of ${formatUnits(transferAmount, Number(wrapperDecimals))} to ${recipient}`);

  const [encrypted] = await client
    .encryptInputs([Encryptable.uint64(transferAmount)])
    .onStep((s, ctx) => { if (ctx?.isStart) console.log(`    … ${s}`); })
    .execute();
  ok('amount encrypted (ZK proof verified)');

  const transferTx = await wrapper.confidentialTransfer(recipient, encrypted);
  ok(`tx ${transferTx.hash}`);
  await transferTx.wait();
  ok('confirmed');

  await waitForHandleChange(
    () => wrapper.confidentialBalanceOf(recipient), '0x' + '0'.repeat(64), 'transfer'
  );
  ok('recipient now holds an encrypted balance');

  const remaining = await client
    .decryptForView(BigInt(await wrapper.confidentialBalanceOf(me)), FheTypes.Uint64).execute();
  if (remaining !== balance - transferAmount) {
    throw new Error(`Expected ${balance - transferAmount} remaining, got ${remaining}`);
  }
  ok(`sender balance decreased by exactly the transferred amount (${formatUnits(remaining, Number(wrapperDecimals))})`);

  // ── 4. Unshield ────────────────────────────────────────────────────
  const unshieldAmount = expectedDelta - transferAmount;
  log(`Unshielding ${formatUnits(unshieldAmount, Number(wrapperDecimals))} ${wrapperSymbol}`);
  const unshieldTx = await wrapper.unshield(me, me, unshieldAmount);
  ok(`tx ${unshieldTx.hash}`);
  await unshieldTx.wait();
  ok('confirmed — balance burned, claim opened');

  let claims = await wrapper.getUserClaims(me);
  for (let attempt = 0; claims.length === 0 && attempt < 8; attempt++) {
    await new Promise((r) => setTimeout(r, 2000));
    claims = await wrapper.getUserClaims(me);
  }
  const open = claims.filter((c) => !c.claimed);
  if (open.length === 0) throw new Error('No open claim was created by unshield');
  ok(`${open.length} open claim(s)`);

  // ── 5 + 6. Decrypt for tx, then claim ──────────────────────────────
  const claim = open[open.length - 1];
  log('Decrypting the burned amount (decryptForTx, no permit)');
  const { decryptedValue, signature } = await client.decryptForTx(BigInt(claim.ctHash)).withoutPermit().execute();
  ok(`decrypted ${formatUnits(decryptedValue, Number(wrapperDecimals))} with a verifiable signature`);

  if (decryptedValue !== unshieldAmount) {
    throw new Error(`Claim decrypts to ${decryptedValue}, expected ${unshieldAmount}`);
  }
  ok('matches the amount that was burned');

  log(`Claiming the unshielded ${tokenSymbol}`);
  const before = await underlying.balanceOf(me);
  const claimTx = await wrapper.claimUnshielded(claim.ctHash, decryptedValue, signature);
  ok(`tx ${claimTx.hash}`);
  await claimTx.wait();
  ok('confirmed — proof verified on-chain');

  let after = await underlying.balanceOf(me);
  for (let attempt = 0; after === before && attempt < 8; attempt++) {
    await new Promise((r) => setTimeout(r, 2000));
    after = await underlying.balanceOf(me);
  }
  const returned = after - before;
  if (returned !== unshieldAmount * rate) {
    throw new Error(`Expected ${unshieldAmount * rate} back, got ${returned}`);
  }
  ok(`${formatUnits(returned, Number(tokenDecimals))} ${tokenSymbol} returned — exactly the burned amount`);

  // ── 7. Batched claim ───────────────────────────────────────────────
  // The wallet settles a whole token's claims in one transaction, which is what an
  // interrupted user ends up needing. Two claims are opened deliberately so the batch
  // path is exercised rather than falling through to the single-claim call.
  log('Opening two claims, then settling both in one claimUnshieldedBatch');

  const perClaim = expectedDelta / 4n;
  if (perClaim === 0n) {
    ok('shielded amount too small to split — skipping');
  } else {
    const refundValue = perClaim * 2n * rate;
    ok(await approveAndWait(underlying, wrapperAddress, me, refundValue));
    const shieldAgain = await wrapper.shield(me, refundValue);
    await shieldAgain.wait();
    ok(`re-shielded ${formatUnits(perClaim * 2n, Number(wrapperDecimals))} to fund two claims`);

    for (let i = 0; i < 2; i++) {
      const tx = await wrapper.unshield(me, me, perClaim);
      await tx.wait();
      ok(`unshield ${i + 1}/2 — tx ${tx.hash}`);
    }

    let open = (await wrapper.getUserClaims(me)).filter((c) => !c.claimed);
    for (let attempt = 0; open.length < 2 && attempt < 8; attempt++) {
      await new Promise((r) => setTimeout(r, 2000));
      open = (await wrapper.getUserClaims(me)).filter((c) => !c.claimed);
    }
    if (open.length < 2) throw new Error(`Expected 2 open claims, got ${open.length}`);
    ok(`${open.length} open claims`);

    const settled = [];
    for (const c of open) {
      const { decryptedValue, signature } = await client.decryptForTx(BigInt(c.ctHash)).withoutPermit().execute();
      settled.push({ ctHash: c.ctHash, value: decryptedValue, signature });
    }
    ok('both claims decrypted with verifiable signatures');

    const beforeBatch = await underlying.balanceOf(me);
    const batchTx = await wrapper.claimUnshieldedBatch(
      settled.map((s) => s.ctHash),
      settled.map((s) => s.value),
      settled.map((s) => s.signature)
    );
    ok(`batch tx ${batchTx.hash}`);
    const batchReceipt = await batchTx.wait();
    ok(`confirmed in ONE transaction (gas ${batchReceipt.gasUsed})`);

    let afterBatch = await underlying.balanceOf(me);
    for (let attempt = 0; afterBatch === beforeBatch && attempt < 8; attempt++) {
      await new Promise((r) => setTimeout(r, 2000));
      afterBatch = await underlying.balanceOf(me);
    }
    const expectedBack = settled.reduce((sum, s) => sum + s.value, 0n) * rate;
    if (afterBatch - beforeBatch !== expectedBack) {
      throw new Error(`Batch returned ${afterBatch - beforeBatch}, expected ${expectedBack}`);
    }
    ok(`${formatUnits(expectedBack, Number(tokenDecimals))} ${tokenSymbol} returned for both claims`);

    const stillOpen = (await wrapper.getUserClaims(me)).filter((c) => !c.claimed);
    if (stillOpen.length !== 0) throw new Error(`${stillOpen.length} claim(s) left unsettled after the batch`);
    ok('no claims left open');
  }

  console.log('\n════════════════════════════════════');
  console.log(`  ALL STEPS PASSED — ${target.chain.name}`);
  console.log('════════════════════════════════════');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`\n❌ FAILED at step ${step}:`, err.shortMessage ?? err.message);
    if (err.code) console.error('   code:', err.code);
    process.exit(1);
  });
