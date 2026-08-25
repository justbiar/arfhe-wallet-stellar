/**
 * End-to-end verification of the confidential ETH flow on a live CoFHE testnet.
 *
 * Exercises every step the wallet UI drives, in order:
 *
 *   1. shieldNative      public ETH  -> encrypted balance
 *   2. decryptForView    read the encrypted balance back (needs a permit)
 *   3. confidentialTransfer  send an encrypted amount to a fresh address
 *   4. unshield          burn + open a claim
 *   5. decryptForTx      decrypt the burned amount with a verifiable signature
 *   6. claimUnshielded   settle the claim, ETH returns
 *
 * Spends real testnet ETH (~0.002 plus gas) from DEPLOYER_PRIVATE_KEY.
 *
 *   node scripts/verify-fhe.mjs [sepolia|arb|base]
 */

import 'dotenv/config';
import { JsonRpcProvider, Wallet, Contract, parseEther, formatUnits } from 'ethers';
import { createCofheConfig, createCofheClient } from '@cofhe/sdk/node';
import { Ethers6Adapter } from '@cofhe/sdk/adapters';
import { chains } from '@cofhe/sdk/chains';
import { Encryptable, FheTypes } from '@cofhe/sdk';

const NETWORKS = {
  sepolia: { chain: chains.sepolia, rpc: process.env.VITE_ALCHEMY_SEPOLIA_API_KEY, wrapper: process.env.VITE_WRAPPED_ETH_ADDRESS },
  arb: { chain: chains.arbSepolia, rpc: process.env.VITE_ALCHEMY_ARBSEPOLIA_API_KEY, wrapper: process.env.VITE_ARB_WRAPPED_ETH_ADDRESS },
  base: { chain: chains.baseSepolia, rpc: process.env.VITE_ALCHEMY_BASESEPOLIA_API_KEY, wrapper: process.env.VITE_BASE_WRAPPED_ETH_ADDRESS },
};

const ABI = [
  'function decimals() view returns (uint8)',
  'function rate() view returns (uint256)',
  'function confidentialBalanceOf(address) view returns (bytes32)',
  'function getUserClaims(address) view returns (tuple(bytes32 id,address to,bytes32 ctHash,uint64 decryptedAmount,bool claimed)[])',
  'function shieldNative(address to) payable returns (bytes32)',
  'function unshield(address from, address to, uint64 amount) returns (bytes32)',
  'function claimUnshielded(bytes32 id, uint64 decryptedAmount, bytes decryptionProof)',
  'function confidentialTransfer(address to, bytes32 encryptedAmount, bytes inputProof) returns (bytes32)',
];

/** Override on thinly funded chains: VERIFY_SHIELD_ETH=0.0005 node scripts/verify-fhe.mjs base */
const SHIELD_ETH = process.env.VERIFY_SHIELD_ETH ?? '0.002';

let step = 0;
const log = (msg) => console.log(`\n[${++step}] ${msg}`);
const ok = (msg) => console.log(`    ✓ ${msg}`);

async function main() {
  const key = process.argv[2] ?? 'sepolia';
  const target = NETWORKS[key];
  if (!target) throw new Error(`Unknown network "${key}" — use sepolia | arb | base`);
  if (!target.rpc) throw new Error(`No RPC configured for ${key}`);
  if (!target.wrapper) throw new Error(`No shielded ETH wrapper address configured for ${key}`);
  if (!process.env.DEPLOYER_PRIVATE_KEY) throw new Error('DEPLOYER_PRIVATE_KEY is not set');

  const provider = new JsonRpcProvider(target.rpc);
  const signer = new Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  const me = await signer.getAddress();
  const token = new Contract(target.wrapper, ABI, signer);

  console.log(`Network : ${target.chain.name} (${target.chain.id})`);
  console.log(`Account : ${me}`);
  console.log(`Wrapper : ${target.wrapper}`);

  const [decimals, rate] = await Promise.all([token.decimals(), token.rate()]);
  console.log(`Rate    : ${rate} (confidential decimals ${decimals})`);

  // ── Connect the SDK ────────────────────────────────────────────────
  log('Connecting @cofhe/sdk');
  const client = createCofheClient(createCofheConfig({ supportedChains: [target.chain] }));
  const { publicClient, walletClient } = await Ethers6Adapter(provider, signer);
  await client.connect(publicClient, walletClient);
  ok(`connected as ${client.connection.account}`);

  // ── 0. Existing balance ────────────────────────────────────────────
  // The account may already hold shielded funds from an earlier run, so every assertion
  // below is on the *delta* rather than an absolute. Makes the script safely re-runnable.
  log('Reading any existing shielded balance');
  await client.acp.getOrCreateSelfACP();
  const startHandle = await token.confidentialBalanceOf(me);
  const startBalance = BigInt(startHandle) === 0n
    ? 0n
    : await client.decryptForView(BigInt(startHandle), FheTypes.Uint64).execute();
  ok(`starting balance ${formatUnits(startBalance, Number(decimals))}`);

  // ── 1. Shield ──────────────────────────────────────────────────────
  log(`Shielding ${SHIELD_ETH} ETH`);
  const shieldTx = await token.shieldNative(me, { value: parseEther(SHIELD_ETH) });
  ok(`tx ${shieldTx.hash}`);
  await shieldTx.wait();
  ok('confirmed');

  // Some RPCs serve pre-transaction state briefly after the receipt lands. Waiting for
  // the handle to *change* catches that; waiting only for non-zero does not, because a
  // stale read of an existing balance is already non-zero.
  let handle = await token.confidentialBalanceOf(me);
  for (let attempt = 0; handle === startHandle && attempt < 8; attempt++) {
    await new Promise((r) => setTimeout(r, 2500));
    handle = await token.confidentialBalanceOf(me);
  }
  if (handle === startHandle) throw new Error('Balance handle did not change after shielding (stale RPC?)');
  if (BigInt(handle) === 0n) throw new Error('confidentialBalanceOf is still the zero handle after shielding');
  ok(`handle ${handle.slice(0, 18)}…`);

  // ── 2. Decrypt for view ────────────────────────────────────────────
  log('Decrypting balance (decryptForView)');
  const balance = await client.decryptForView(BigInt(handle), FheTypes.Uint64).execute();
  ok(`balance = ${formatUnits(balance, Number(decimals))}`);

  const expectedDelta = parseEther(SHIELD_ETH) / rate;
  const actualDelta = balance - startBalance;
  if (actualDelta !== expectedDelta) {
    throw new Error(`Expected +${expectedDelta} confidential units, got +${actualDelta}`);
  }
  ok('increased by exactly the shielded amount');

  // ── 3. Confidential transfer ───────────────────────────────────────
  const recipient = Wallet.createRandom().address;
  const transferAmount = expectedDelta / 2n;
  log(`Confidential transfer of ${formatUnits(transferAmount, Number(decimals))} to ${recipient}`);

  // SDK 0.7 returns per-input hashes plus one batch proof, and binds the consuming
  // contract into the signed digest. The struct below is what the wrapper's ABI takes.
  const item = Encryptable.uint64(transferAmount);
  const [hash, proof] = await client
    .encryptInputs([item])
    .setConsumingContract(target.wrapper)
    .onStep((s, ctx) => { if (ctx?.isStart) console.log(`    … ${s}`); })
    .execute();
  ok('amount encrypted (ZK proof verified)');

  const transferTx = await token.confidentialTransfer(recipient, hash, proof);
  ok(`tx ${transferTx.hash}`);
  await transferTx.wait();
  ok('confirmed');

  let recipientHandle = await token.confidentialBalanceOf(recipient);
  for (let attempt = 0; BigInt(recipientHandle) === 0n && attempt < 8; attempt++) {
    await new Promise((r) => setTimeout(r, 2500));
    recipientHandle = await token.confidentialBalanceOf(recipient);
  }
  if (BigInt(recipientHandle) === 0n) throw new Error('Recipient balance handle is still zero');
  ok('recipient now holds an encrypted balance');

  const remaining = await client.decryptForView(BigInt(await token.confidentialBalanceOf(me)), FheTypes.Uint64).execute();
  ok(`sender balance now ${formatUnits(remaining, Number(decimals))}`);
  if (remaining !== balance - transferAmount) {
    throw new Error(`Expected ${balance - transferAmount} remaining, got ${remaining}`);
  }
  ok('sender balance decreased by exactly the transferred amount');

  // ── 4. Unshield ────────────────────────────────────────────────────
  log(`Unshielding ${formatUnits(remaining, Number(decimals))}`);
  const unshieldTx = await token.unshield(me, me, remaining);
  ok(`tx ${unshieldTx.hash}`);
  await unshieldTx.wait();
  ok('confirmed — balance burned, claim opened');

  let claims = await token.getUserClaims(me);
  for (let attempt = 0; claims.length === 0 && attempt < 6; attempt++) {
    await new Promise((r) => setTimeout(r, 2000));
    claims = await token.getUserClaims(me);
  }
  if (claims.length === 0) throw new Error('No claim was created by unshield');
  ok(`${claims.length} pending claim(s)`);

  // ── 5 + 6. Decrypt for tx, then claim ──────────────────────────────
  const claim = claims[claims.length - 1];
  log('Decrypting burned amount (decryptForTx, no permit)');
  const { decryptedValue, signature } = await client.decryptForTx(BigInt(claim.ctHash)).withoutACP().execute();
  ok(`decrypted ${formatUnits(decryptedValue, Number(decimals))} with a verifiable signature`);

  log('Claiming unshielded ETH');
  const ethBefore = await provider.getBalance(me);
  const claimTx = await token.claimUnshielded(claim.id, decryptedValue, signature);
  ok(`tx ${claimTx.hash}`);
  const receipt = await claimTx.wait();
  ok('confirmed — proof verified on-chain');

  const ethAfter = await provider.getBalance(me);
  const gas = receipt.gasUsed * receipt.gasPrice;
  const netReturned = ethAfter - ethBefore + gas;
  ok(`ETH returned: ${formatUnits(netReturned, 18)}`);

  const remainingClaims = await token.getUserClaims(me);
  ok(`pending claims now: ${remainingClaims.length}`);

  console.log('\n════════════════════════════════════');
  console.log('  ALL STEPS PASSED');
  console.log('════════════════════════════════════');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`\n❌ FAILED at step ${step}:`, err.shortMessage ?? err.message);
    if (err.code) console.error('   code:', err.code);
    process.exit(1);
  });
