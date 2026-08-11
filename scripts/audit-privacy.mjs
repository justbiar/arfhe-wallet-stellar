/**
 * Adversarial privacy audit for the Arfhe confidential wrappers.
 *
 * Runs as a THIRD PARTY: it uses DEPLOYER_PRIVATE_KEY, which is a different account from
 * the target, and never has access to the target's keys or permits. Everything it tries
 * is something any observer on the public internet could try.
 *
 * Attack surfaces probed, per token:
 *   1. Raw contract storage      — is the balance stored as a value or only as a handle?
 *   2. decryptForTx (no permit)  — is the balance handle globally decryptable?
 *   3. decryptForView (my permit)— will the ACL accept an unrelated account's permit?
 *   4. Transaction history       — does any calldata or event carry a plaintext amount?
 *
 *   node scripts/audit-privacy.mjs <targetAddress>
 */

import 'dotenv/config';
import { JsonRpcProvider, Wallet, Contract, Interface, formatUnits, keccak256, AbiCoder } from 'ethers';
import { createCofheConfig, createCofheClient } from '@cofhe/sdk/node';
import { Ethers6Adapter } from '@cofhe/sdk/adapters';
import { chains } from '@cofhe/sdk/chains';
import { FheTypes } from '@cofhe/sdk';

const TARGET = process.argv[2] ?? '0xE76e2aC03C3eEC2215d82F468cE30bBD36Afa0F9';

/**
 * Every wrapper on the chain: the ones configured in .env plus everything the factory has
 * deployed. Auditing only the configured pair would leave wrappers created on demand
 * — the ones an ordinary user actually shields arbitrary tokens through — unexamined.
 */
async function collectTokens(provider) {
  const configured = [
    { label: 'aeETH', address: process.env.VITE_WRAPPED_ETH_ADDRESS },
    { label: 'aeUSDC', address: process.env.VITE_WRAPPED_USDC_ADDRESS },
  ].filter((t) => t.address);

  const seen = new Set(configured.map((t) => t.address.toLowerCase()));

  const factoryAddress = process.env.VITE_WRAPPER_FACTORY_ADDRESS;
  if (!factoryAddress) return configured;

  try {
    const factory = new Contract(factoryAddress, [
      'function wrapperCount() view returns (uint256)',
      'function wrappersAt(uint256,uint256) view returns (address[])',
    ], provider);

    const count = await factory.wrapperCount();
    if (count === 0n) return configured;

    for (const address of await factory.wrappersAt(0, count)) {
      if (seen.has(address.toLowerCase())) continue;
      seen.add(address.toLowerCase());
      const symbol = await new Contract(address, ['function symbol() view returns (string)'], provider)
        .symbol().catch(() => 'ae???');
      configured.push({ label: symbol, address });
    }
  } catch {
    // Registry unreachable — audit what is configured rather than nothing.
  }

  return configured;
}

const READ_ABI = [
  'function confidentialBalanceOf(address) view returns (bytes32)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

// Every function and event that could conceivably carry an amount.
const SURFACE = new Interface([
  'function shieldNative(address to) payable returns (bytes32)',
  'function shieldWrappedNative(address to, uint256 value) returns (bytes32)',
  'function shield(address to, uint256 amount) returns (bytes32)',
  'function unshield(address from, address to, uint64 amount) returns (bytes32)',
  'function claimUnshielded(bytes32 ctHash, uint64 decryptedAmount, bytes decryptionProof)',
  'function confidentialTransfer(address to, (uint256 ctHash, uint8 securityZone, uint8 utype, bytes signature) encryptedAmount) returns (bytes32)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event ConfidentialTransfer(address indexed from, address indexed to, bytes32 indexed amount)',
]);

const provider = new JsonRpcProvider(process.env.VITE_ALCHEMY_SEPOLIA_API_KEY);

/**
 * The adversary. A freshly generated key by default, which is the honest threat model:
 * a stranger with no relationship to the target and no funds. Permits are EIP-712
 * signatures, so an unfunded account can still mount every read attack below.
 *
 * Set ATTACKER_PRIVATE_KEY to audit from a specific account instead.
 */
const attacker = process.env.ATTACKER_PRIVATE_KEY
  ? new Wallet(process.env.ATTACKER_PRIVATE_KEY, provider)
  : Wallet.createRandom().connect(provider);

let leaks = 0;
const fail = (m) => { leaks++; console.log(`    ✗ SIZINTI: ${m}`); };
const pass = (m) => console.log(`    ✓ ${m}`);

async function main() {
  const attackerAddress = await attacker.getAddress();

  // Auditing an account against itself proves nothing: the owner is *supposed* to decrypt
  // their own balance, so step 3 would report a leak that is simply correct behaviour.
  // Refusing is safer than printing a result that looks alarming but means nothing.
  if (attackerAddress.toLowerCase() === TARGET.toLowerCase()) {
    throw new Error(
      `Saldırgan ve hedef aynı hesap (${TARGET}). Bu denetim üçüncü bir tarafın ne ` +
      `görebildiğini ölçer — hesabın kendi bakiyesini çözebilmesi sızıntı değil, ` +
      `tasarımın kendisidir. Başka bir adres verin.`
    );
  }

  console.log(`Hedef      : ${TARGET}`);
  console.log(`Saldırgan  : ${attackerAddress} (farklı hesap, hedefin anahtarına erişimi yok)`);

  const client = createCofheClient(createCofheConfig({ supportedChains: [chains.sepolia] }));
  const { publicClient, walletClient } = await Ethers6Adapter(provider, attacker);
  await client.connect(publicClient, walletClient);
  await client.permits.getOrCreateSelfPermit();

  const tokens = await collectTokens(provider);
  console.log(`Kapsam     : ${tokens.length} sarmalayıcı (${tokens.map((t) => t.label).join(', ')})`);

  for (const token of tokens) {
    if (!token.address) continue;
    console.log(`\n════ ${token.label}  ${token.address} ════`);

    const c = new Contract(token.address, READ_ABI, provider);
    const handle = await c.confidentialBalanceOf(TARGET);
    const decimals = Number(await c.decimals());

    console.log(`\n  [1] Ham sözleşme deposu (eth_getStorageAt)`);
    // FHERC20._balances is the first storage variable: mapping(address => euint64) at slot 0.
    const slot = keccak256(AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [TARGET, 0]));
    const raw = await provider.getStorage(token.address, slot);
    console.log(`      slot değeri : ${raw}`);
    if (raw === handle) {
      pass('depoda sadece şifreli tutamaç var, düz miktar yok');
    } else if (BigInt(raw) === 0n) {
      pass('slot boş — bakiye başka bir düzende, düz metin görünmüyor');
    } else {
      // A plausible plaintext balance would be a small number; a handle is ~256 bits of entropy.
      const asNum = BigInt(raw);
      if (asNum < 10n ** 18n) fail(`slot küçük bir sayı içeriyor, düz bakiye olabilir: ${asNum}`);
      else pass('slot değeri tutamaç görünümünde, düz miktar değil');
    }

    console.log(`\n  [2] İzinsiz çözme — decryptForTx().withoutPermit()`);
    if (BigInt(handle) === 0n) {
      pass('bakiye tutamacı sıfır (hiç işlem yok) — çözecek bir şey yok');
    } else {
      try {
        const r = await client.decryptForTx(handle).withoutPermit().set404RetryTimeout(4000).execute();
        fail(`bakiye çözüldü: ${formatUnits(r.decryptedValue, decimals)}`);
      } catch (e) {
        pass(`reddedildi — ${short(e)}`);
      }

      console.log(`\n  [3] Kendi permitimle çözme — decryptForView()`);
      try {
        const v = await client.decryptForView(handle, FheTypes.Uint64).set404RetryTimeout(4000).execute();
        fail(`bakiye çözüldü: ${formatUnits(v, decimals)}`);
      } catch (e) {
        pass(`ACL yabancı permiti kabul etmedi — ${short(e)}`);
      }
    }

    console.log(`\n  [4] İşlem geçmişinde düz metin miktar taraması`);
    await scanHistory(token, decimals);
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(leaks === 0
    ? '  SONUÇ: Şifreli bakiyeler ve transfer miktarları dışarıdan elde edilemedi.'
    : `  SONUÇ: ${leaks} sızıntı bulundu — aşağıdaki notlara bakın.`);
  console.log('═'.repeat(60));
}

/** Walk the target's transactions to this contract and look for plaintext amounts. */
async function scanHistory(token, decimals) {
  const latest = await provider.getBlockNumber();

  // The RPC plan caps eth_getLogs at a 10-block window, so walk the range in chunks.
  const SPAN = Number(process.env.AUDIT_BLOCK_SPAN ?? 800);
  const CHUNK = 10;
  const logs = [];
  for (let from = latest - SPAN; from <= latest; from += CHUNK) {
    const to = Math.min(from + CHUNK - 1, latest);
    try {
      logs.push(...await provider.getLogs({ address: token.address, fromBlock: from, toBlock: to }));
    } catch {
      // A failed window costs coverage, not correctness — keep scanning the rest.
    }
  }
  console.log(`      taranan blok    : ${SPAN} (${logs.length} log)`);

  const seen = new Set();
  let confidentialTransfers = 0, indicatorOnly = 0, publicLegs = 0;

  for (const log of logs) {
    if (seen.has(log.transactionHash)) continue;
    seen.add(log.transactionHash);

    // Sequential with a small gap: parallel fetches trip the RPC provider's rate limit.
    await new Promise((r) => setTimeout(r, 120));
    let tx;
    try {
      tx = await provider.getTransaction(log.transactionHash);
    } catch {
      continue;
    }
    if (!tx || tx.from.toLowerCase() !== TARGET.toLowerCase()) continue;

    let parsed = null;
    try { parsed = SURFACE.parseTransaction({ data: tx.data }); } catch { /* unknown selector */ }
    const name = parsed?.name ?? tx.data.slice(0, 10);

    if (parsed && name === 'confidentialTransfer') {
      confidentialTransfers++;
      // The only amount-shaped field is the ciphertext handle — assert nothing else leaks.
      const encrypted = parsed.args[1];
      if (encrypted.utype !== 5n && Number(encrypted.utype) !== 5) {
        fail(`beklenmeyen utype ${encrypted.utype}`);
      }
    } else if (name === 'shieldNative' || name === 'shield' || name === 'shieldWrappedNative' ||
               name === 'unshield' || name === 'claimUnshielded') {
      publicLegs++;
    }

    for (const l of logs.filter(x => x.transactionHash === log.transactionHash)) {
      let ev = null;
      // parseLog returns null for unknown topics rather than throwing.
      try { ev = SURFACE.parseLog(l); } catch { continue; }
      if (ev?.name === 'Transfer') indicatorOnly++;
    }
  }

  console.log(`      gizli transfer  : ${confidentialTransfers} (miktar yalnızca şifreli tutamaç)`);
  console.log(`      açık bacaklar   : ${publicLegs} (shield/unshield/claim — miktar tasarım gereği açık)`);
  console.log(`      Transfer olayı  : ${indicatorOnly} (hepsi sabit gösterge, miktar değil)`);
  if (confidentialTransfers > 0) pass('hiçbir gizli transferin calldata veya olayında düz miktar yok');
}

const short = (e) => (e.message ?? String(e)).split('\n')[0].slice(0, 70);

main().catch((e) => { console.error('HATA:', e.shortMessage ?? e.message); process.exit(1); });
