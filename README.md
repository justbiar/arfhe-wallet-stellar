<p align="center">
  <img src="public/Arfhe-logo.png" alt="Arfhe Wallet" width="88" />
</p>

<h1 align="center">Arfhe Wallet</h1>

<p align="center">
  <strong>A browser wallet where your balances and transfer amounts stay encrypted on-chain.</strong><br/>
  Built on Fully Homomorphic Encryption — lattice cryptography that a quantum computer does not break.
</p>

<p align="center">
  <a href="#what-this-is">What it is</a> •
  <a href="#how-the-privacy-works">Privacy</a> •
  <a href="#quantum-resistance-precisely">Quantum</a> •
  <a href="#stellar-the-same-question-on-a-different-network">Stellar</a> •
  <a href="#the-agent">Agent</a> •
  <a href="#getting-started">Getting started</a> •
  <a href="#verifying-it-yourself">Verify it</a> •
  <a href="#security">Security</a>
</p>

<p align="center">
  <img alt="Manifest V3" src="https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5-3178C6" />
  <img alt="Tests" src="https://img.shields.io/badge/tests-992%20passing-22c55e" />
  <img alt="Status" src="https://img.shields.io/badge/status-testnet%20preview-f59e0b" />
  <img alt="License" src="https://img.shields.io/badge/license-MIT-blue" />
</p>

---

> **Testnet preview (v0.9.0).** Arfhe runs on public testnets and has not been through an
> external security audit. Do not put mainnet funds in it yet.

---

## What this is

Every balance and every transfer on a public blockchain is visible to anyone. That is not a
bug in Ethereum — it is how it works. Most "privacy" tools hide *who* by mixing addresses.
Arfhe hides *how much*.

A shielded balance is stored on-chain as ciphertext. The contract can add to it, subtract
from it and compare it — **without ever decrypting it**. Not the block explorer, not the
node operator, not the person you paid, not us. Only the key holder can read the number.

That is what Fully Homomorphic Encryption buys: arithmetic on encrypted data.

Arfhe is a Chrome extension (Manifest V3) that puts this behind an ordinary wallet — send,
receive, swap, connect to dApps — plus an assistant that runs against your own model
provider and never sees your balances.

---

## How the privacy works

Shielding wraps an ordinary token into a **confidential token** (an `FHERC20`). The wrapper
holds the real asset 1:1 and issues you an encrypted balance.

```
  public ERC-20 / ETH                        confidential balance
  ┌──────────────────┐   shield              ┌──────────────────┐
  │   100 USDC       │ ────────────────────► │  euint64 ciphertext │
  │   (visible)      │ ◄──────────────────── │  (unreadable)    │
  └──────────────────┘   unshield + claim    └──────────────────┘
                                                     │
                                        confidentialTransfer
                                                     ▼
                                          recipient's ciphertext
                                     (amount never appears on-chain)
```

**What an observer sees**

| | Visible on-chain |
|---|---|
| Shield | Yes — you moved N tokens into the wrapper |
| Confidential transfer | **Only that a transfer happened.** Sender, recipient, and an encrypted handle. The amount is not on-chain in any form |
| Unshield | Yes — the burn names an amount, because tokens are being returned to the public ledger |
| Balance | **Never.** `confidentialBalanceOf` returns a ciphertext handle, not a number |

So the private window is *between* shield and unshield. Amounts moved inside it are
unrecoverable by anyone but the participants — and we ship a script that tries to break
that from a stranger's point of view (see [Verifying it yourself](#verifying-it-yourself)).

### The pieces

| Component | Role |
|---|---|
| [`ArfheShieldedETH`](contracts/ArfheShieldedETH.sol) | Confidential ETH/WETH wrapper |
| [`ArfheShieldedERC20`](contracts/ArfheShieldedERC20.sol) | Confidential wrapper for any standard ERC-20 |
| [`ArfheWrapperFactory`](contracts/ArfheWrapperFactory.sol) | Deploys and indexes wrappers, one per token, permissionlessly |
| CoFHE coprocessor | Performs the encrypted arithmetic off-chain; the chain stores only handles |
| Threshold Network | Produces verifiable decryptions for unshield claims |

Contracts inherit Fhenix's audited `fhenix-confidential-contracts`; Arfhe adds the factory
and a deliberate override making `balanceOf` and `totalSupply` return zero. The standard
fills them with a ~7984 activity counter so explorers register the token — but every wallet
renders that counter as a real holding, showing users money they do not have, and it
publishes how many confidential transfers an address has made.

### Any ERC-20, not a fixed list

The factory means shielding is not limited to tokens someone hardcoded. The first user to
shield a token pays a one-time deployment; everyone after reuses the same wrapper. One
wrapper per underlying is enforced on-chain — two wrappers would split the backing pool, so
funds shielded through one could not be unshielded through the other.

> Rebasing and fee-on-transfer tokens break the 1:1 backing invariant and must not be
> wrapped. This cannot be detected reliably on-chain, so the wallet warns before creating a
> wrapper. Registration is not an endorsement.

### Unshielding is two steps, on purpose

An encrypted balance cannot simply be handed back — someone has to learn the number first.
`unshield` burns the balance and marks the burned handle publicly decryptable; the amount is
then decrypted off-chain with a Threshold Network signature, and `claimUnshielded` verifies
that proof before releasing funds.

If the popup closes between those steps, the burned balance would be stranded. Arfhe records
the intent the moment the burn confirms and retries automatically whenever the wallet is
open and unlocked. A locked wallet deliberately cannot participate — settling needs a
signature, and the signing key exists only in memory while unlocked. Handing that key to a
background worker to automate it would defeat the lock.

### One rule that shapes everything

**FHE operations cannot revert on insufficient funds.** Reverting would leak the balance —
the failure itself tells you the amount was too large. Instead the protocol moves an
encrypted zero. A transfer that "succeeds" while moving nothing is indistinguishable from a
real one, so Arfhe decrypts and checks your balance *before* every confidential transfer and
unshield, and refuses rather than letting it happen.

---

## Quantum resistance, precisely

FHE here is TFHE, whose security rests on **Learning With Errors** over lattices. Unlike
RSA and elliptic curves, LWE has no known quantum attack — Shor's algorithm does not apply,
and it is the same family NIST selected for its post-quantum standards.

This matters more for privacy than for ordinary key security, because of **harvest now,
decrypt later**: an adversary can archive today's blockchain and wait. Everything a public
chain reveals is already permanently harvested. Amounts encrypted under LWE are not — they
do not become readable when a quantum computer arrives.

**Being exact about what is and is not covered:**

| Layer | Primitive | Quantum-resistant |
|---|---|---|
| Confidential balances and amounts | TFHE (lattice / LWE) | **Yes** |
| Encrypted-input proofs | Lattice-based ZK | **Yes** |
| Local vault | AES-256-GCM, PBKDF2-SHA256 | **Yes** in practice — Grover only halves symmetric strength |
| Account keys and signatures | secp256k1 ECDSA | **No** |

That last row is honest and important. Your Ethereum private key is elliptic-curve, so a
future quantum computer could derive it from your public key — and that is true of every
Ethereum wallet that exists, because it is a property of the chain, not of Arfhe. Migrating
signatures is an ecosystem-level change no wallet can make alone.

**What Arfhe changes is the confidentiality of your history.** Your amounts stay secret
against an adversary who is recording everything today and waiting for better hardware.
Anyone claiming a wallet is "fully quantum-proof" while signing with secp256k1 is
overselling; we would rather tell you where the line is.

---

## The Agent

A built-in assistant, designed so that using it does not undo the privacy of the wallet
it lives in.

**Three modes**

- **Local (`arfhe`)** — answers questions about your balance, address and network from
  wallet state **on your device**. No API key, no network request, nothing leaves.
- **Bring your own model** — OpenAI, Anthropic, or any OpenAI-compatible endpoint, called
  directly from your browser with **your** key. Also configurable with MCP servers.
- **Hosted (Arfio)** — a Cloudflare Worker in `backend-proxy/` fronts OpenRouter so the
  agent works without the user holding a key. This one does involve an Arfhe-operated
  server; see below.

**What is sent, exactly:** the system prompt, chat history and your message. Wallet state —
balances, addresses, shielded holdings — is passed **only** to the local assistant and is
never included in an outbound request. If you type your own address into the chat, that
goes out, because you sent it.

**On the hosted mode:** your messages pass through Arfhe's Worker on the way to OpenRouter.
Choose local or bring-your-own if you would rather they did not. There is no telemetry or
analytics anywhere in this codebase, and no inference happens on Arfhe hardware — the
Worker relays, it does not read or retain.

### Backend proxy & RAG knowledge base

`backend-proxy/` is a Cloudflare Worker that fronts OpenRouter for the hosted agent and
also serves `POST /agent/retrieve-context`, which embeds the user's message (Workers AI,
`@cf/baai/bge-m3`) and returns the most relevant excerpts of
[FHE_COMPLETE_GUIDE.md](./FHE_COMPLETE_GUIDE.md) for `AgentOrchestrator` to splice into the
system prompt.

`VITE_AGENT_PROXY_URL` is the one setting not read from `.env` — it is per Vite mode, so
see `.env.development` (`pnpm dev`, local `wrangler dev`) against `.env.production`
(`pnpm build`, deployed Worker).

See `backend-proxy/README.md` for running its tests and — importantly — **how to regenerate
the committed chunk embeddings after editing `backend-proxy/src/knowledge/chunks.ts`**. The
vector JSON is derived data, not hand-written, and goes silently out of sync otherwise.

---

## Networks

The wallet ships with three networks — the chains the CoFHE coprocessor runs on, and
therefore the only ones where confidential balances exist at all:

| Network | Chain ID |
|---|---|
| Ethereum Sepolia | 11155111 |
| Arbitrum Sepolia | 421614 |
| Base Sepolia | 84532 |

**Every other chain is yours to add.** A network added from Settings → Networks is not
second-class: the same balance discovery, history scan, sends and dApp connections serve
it. What it does not get is the indexer behind the built-in chains, so instant history is
replaced by a recent-block scan.

Each shipped network's RPC endpoint is editable, with an optional fallback for when the
primary is rate-limited or down. The editor asks the endpoint which chain it serves before
accepting it — an RPC for the wrong chain answers every call plausibly and would sign
transactions for a chain you did not intend.

Adding a network tells you up front whether it supports confidential transactions.

---

## Stellar: the same question, on a different network

FHE is how the EVM side hides amounts. **Stellar has no FHE** — measured rather than
assumed: the closest thing on the network is a twisted-ElGamal prototype that is only
*additively* homomorphic, and a single transfer through it costs ~2.85B CPU instructions
against a testnet ceiling of 400M. So confidentiality here is built the way the protocol
actually supports it — **commitments plus zero-knowledge proofs**, on the BN254 / BLS12-381
and Poseidon host functions Stellar exposes (CAP-0059, CAP-0074, CAP-0075, CAP-0080).

What runs today:

| Piece | What it is | Run it |
|---|---|---|
| Confidential payment service | Payroll, supplier payments and institutional settlement over a confidential USDC layer deployed on testnet | `npm run payroll` → `payroll/` |
| Our own SEP-6 anchor | A TRY ⇄ USDC ramp: SEP-1/6/10/12/38, and it honours the IBAN a withdrawal names | `npm run anchor` → `anchor/` |
| Demo site | The bridge, the confidential-payment demo, the privacy pool, the roadmap | `npm run dev:panel` → `panel/` |
| Bank mode in the wallet | A TRY balance and an IBAN next to the Web3 side, the way a Turkish exchange presents it | `src/pages/Bank.tsx` |

**Measured, in both directions.** 2730 TRY became 55.68 USDC and paid three salaries at
~5s per payment; `GET /chain/:hash` returns what the ledger actually holds, and none of the
amounts are in it. A 250 TRY deposit arrived as 5.07 USDC, and a withdrawal paid 96.61 TRY
to the IBAN it was given.

**What is simulated and what is not.** The bank and the identity checks are a sandbox — no
institution issues these IBANs and no lira moves. Everything on the Stellar side is real
testnet: real accounts, real trustlines, real payments you can look up on Horizon.

The anchor is ours because the public sandbox anchor we first built against kept answering
HTTP after it had stopped paying, and it ignored the destination a withdrawal named — three
different IBANs came back with the same payout account. A demo cannot depend on a service
nobody can restart. The design notes, and the traps worth not rediscovering, are in
[`stellar.md`](stellar.md) and [`anchor/README.md`](anchor/README.md).

---

## Installing the testnet build

This is a **testnet release**. It talks to Sepolia, Base Sepolia and Arbitrum Sepolia, and
nothing on it is worth money. Do not put mainnet funds anywhere near it.

1. Download and unzip the release, so you have a folder containing `manifest.json`.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right) — and leave it on. Chrome disables unpacked
   extensions when it is switched off, and the wallet stops working until it is back.
4. **Load unpacked** → select the unzipped folder.

Chrome will warn that the extension can *"read and change all your data on all websites"*.
That is accurate, and it is what any browser wallet needs: a site asks for your address by
talking to a script the wallet injects into the page, so the wallet has to be allowed on
the pages you visit. What it does with that access is in [Websites](#websites) — it answers
the chain id to anyone, and nothing else until you approve a connection.

The extension id is fixed at `jdihllmgakeejednibihnpclbddgfchp`. If yours differs, the
folder you loaded is not this build.

### Before you write anything down

The recovery phrase shown on first run is the only copy. There is no account to reset and
nobody to ask — see [Key handling](#key-handling) for why that is deliberate rather than an
omission.

## Getting started

**Requirements:** Node 20+, pnpm, and Chrome (or any Chromium browser).

```bash
git clone https://github.com/justbiar/arfhe-wallet-stellar.git
cd arfhe-wallet-stellar
pnpm install
cp .env.example .env      # add your RPC keys and contract addresses
pnpm build
```

Then load it:

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select the `dist/` folder

> Loading the wrong folder is the most common setup mistake — the version shown in
> **Settings → About** is baked into the build, so if it does not match
> `extension/manifest.json`, Chrome is running a different copy.

### Configuration

`.env.example` documents every variable. The ones that matter:

| Variable | Purpose |
|---|---|
| `VITE_ALCHEMY_*_API_KEY` | RPC + token/NFT indexing per network |
| `VITE_*_WRAPPED_ETH_ADDRESS` | Confidential ETH wrapper |
| `VITE_*_WRAPPED_USDC_ADDRESS` | Confidential USDC wrapper — **must be the factory-registered one** |
| `VITE_*_WRAPPER_FACTORY_ADDRESS` | Wrapper registry, what makes arbitrary ERC-20s shieldable |
| `VITE_WEB3AUTH_CLIENT_ID` | Optional social login |

### Deploying the contracts

```bash
cd deploy
npm install
npm run compile
npm run deploy:sepolia     # or deploy:arb / deploy:base
```

The script prints the lines to paste into `.env`. It creates the USDC wrapper **through the
factory** — deploying one standalone leaves it out of the registry, and the first user to
enable shielding would cause a second wrapper for the same token.

---

## Verifying it yourself

Privacy claims should not be taken on trust. Four scripts run against **real networks** —
no mocks, no simulated data. They need `DEPLOYER_PRIVATE_KEY` and spend testnet gas.

```bash
pnpm verify:discovery -- all        # read-only: shielded holdings, one wrapper per token
pnpm verify:fhe -- sepolia          # native ETH: shield → transfer → unshield → claim
pnpm verify:fhe:erc20 -- base       # any ERC-20: same loop, plus createWrapper and a batched claim
pnpm audit:privacy -- <address>     # third-party attempt to read someone's balances
```

`audit:privacy` is the interesting one. It plays an attacker with **no relationship to the
target and no funds** — a freshly generated key, which is enough because permits are EIP-712
signatures. It tries to read raw contract storage, decrypt without a permit, decrypt with its
own permit, and scan transaction calldata and events for a plaintext amount.

```
[1] Raw contract storage        ✓ only a ciphertext handle, no plaintext
[2] decryptForTx (no permit)    ✓ refused — not_publicly_allowed
[3] decryptForView (own permit) ✓ refused — permit_denied
[4] calldata / event scan       ✓ no confidential transfer carries an amount

RESULT: encrypted balances and transfer amounts could not be obtained from outside.
```

It refuses to run when the attacker and target are the same account — an account decrypting
its own balance is the design working, not a leak, and reporting it as one would be noise.

```bash
pnpm test:run    # 373 unit tests
pnpm build       # type-check + production bundle
```

---

## Security

### Key handling

Your seed phrase and private keys are encrypted with **AES-256-GCM** under a key derived by
**PBKDF2-SHA256, 100,000 iterations**, with a random salt and a fresh IV per record. The
password is never stored — only a verification hash. Decrypted keys exist **only in memory
while the wallet is unlocked**.

Nothing sensitive is written before a password exists. During onboarding the new account
stays in memory until you set one; abandoning setup on the recovery-phrase screen leaves
nothing on disk.

The recovery phrase must be **confirmed back** before setup completes — three random word
positions. Showing the words and accepting "I saved it" on trust verifies nothing, and a
phrase never written down is the most common way people lose a wallet permanently.

### Locking

Auto-lock is configurable (default 5 minutes) and enforced two ways: a timer while the popup
is open, and an independent wall-clock check that cannot drift if the timer is throttled or
reset. When the popup is closed, reopening compares the last activity time — captured the
instant the code loads, before anything can overwrite it — against your timeout.

Locking wipes the decryption key, every account's key material, the FHE session, and the
balance cache from memory.

### Websites

Sites connect through the injected provider (`window.ethereum`, announced via **EIP-6963**)
or **WalletConnect v2**. Both go through an approval screen showing the origin, a phishing
check, the decoded request, and a warning when the call touches your confidential balances.

- **Per-origin permissions.** A grant names exact origins and exact accounts. No wildcards —
  `app.uniswap.org` does not inherit from `uniswap.org`. Revocable individually from Revoke
  or Settings.
- **Nothing before consent.** An unconnected site cannot read your address, your balance, or
  anything else. `eth_accounts` never prompts, so a site cannot spam approval windows.
- **The worker cannot sign.** The service worker routes and gates; signing happens in an
  unlocked extension page. The decrypted key is never in the background context.
- **Chain and account are enforced.** A request naming a chain or account other than the
  active one is refused, not silently redirected onto whatever is selected.
- **`eth_sign` is not supported.** It asks for a signature over bytes you cannot read —
  possibly a transaction hash. Not advertised, not implemented.

### Reporting a vulnerability

Please do not open a public issue. Email **security@arfhe.xyz** with a description and
reproduction steps. This project is pre-audit; findings are genuinely welcome.

---

## Architecture

```
src/
├── backend/                    # Wallet core — no React
│   ├── FheCofheService.ts      # CoFHE SDK lifecycle, permits, encrypt/decrypt
│   ├── Network.ts              # RPC, balances, transactions, all FHE contract calls
│   ├── StorageManager.ts       # AES-GCM vault, lock/unlock, session
│   ├── AccountManager.ts       # HD accounts, import/export
│   ├── SitePermissionService.ts# Per-origin dApp grants
│   ├── PendingClaimQueue.ts    # Unshield claims that survive a closed popup
│   ├── DataCacheService.ts     # Encrypted, persistent balance cache
│   └── AgentService.ts         # Local assistant + BYO-model providers
├── pages/                      # Home, Portfolio, History, Explore, Settings, Approve…
├── components/panels/          # Send, Receive, Shield, Swap
└── locales/                    # English, Turkish

contracts/                      # Confidential wrappers + factory
scripts/                        # Live-network verification and privacy audit
service-worker.js               # MV3 background: dApp routing, permission gate, monitoring
extension/                      # Manifest, content script, injected provider

anchor/                         # Our SEP-6 anchor: TRY ⇄ USDC, SEP-1/10/12/38
payroll/                        # Confidential payment service over Stellar
panel/                          # The demo site (bridge, private payments, roadmap)
vendor/ctd-sdk/                 # Confidential Token SDK, vendored — changes noted in its README
```

**Stack:** React 19 · TypeScript 5 · Vite · MUI · ethers v6 · `@cofhe/sdk` 0.5.2 ·
`tfhe` 0.11.1 · `@fhenixprotocol/cofhe-contracts` 0.1.3 ·
`fhenix-confidential-contracts` 0.3.1 · Solidity ^0.8.25

Deeper documentation of the FHE layer — unit systems, decimals, failure modes, RPC
staleness — is in **[FHE_COMPLETE_GUIDE.md](FHE_COMPLETE_GUIDE.md)**.

---

## Known limits

Stated plainly, because a privacy wallet that overstates itself is worse than one that does not.

- **No external audit yet.** Testnet only.
- **Shield and unshield amounts are public.** They cross the boundary between the public and
  confidential ledgers, so they must be. Privacy applies to what happens in between.
- **Confidential swaps are not implemented.** Swapping against a public pool cannot hide the
  amount — the pool's reserve change *is* the amount. A private swap needs either encrypted
  reserves or peer matching; both are real designs, neither is shipped here, and we will not
  label a public swap "confidential".
- **Confidential precision is 6 decimals.** Balances are `euint64`; ETH converts at a rate of
  1e12. Amounts below one confidential unit are refunded as dust rather than silently absorbed.
- **Signatures are not post-quantum.** See [above](#quantum-resistance-precisely).
- **Stellar confidentiality is not FHE.** It is commitments and zero-knowledge proofs. The
  name comes from the EVM side, where the arithmetic really does happen on ciphertext; on
  Stellar the amount is hidden by never being published, and proven correct instead.
- **The fiat rail is a sandbox.** The anchor, its IBANs and the bank screen are ours and
  simulate an institution. The Stellar leg underneath them is real testnet.
- **NFTs need an indexer.** Token IDs cannot be enumerated from a plain RPC, so the gallery is
  empty on networks without Alchemy NFT support rather than guessing.

---

## Contributing

Issues and pull requests are welcome. Please run `pnpm test:run` and `pnpm build` before
opening one. For anything touching the FHE path, read
[FHE_COMPLETE_GUIDE.md](FHE_COMPLETE_GUIDE.md) first — several rules there (zero-replacement,
the unit systems, RPC staleness) are easy to break without noticing.

## License

[MIT](LICENSE) © Arf DAO

## Acknowledgements

Built on [Fhenix](https://fhenix.zone) CoFHE and the
[Zama](https://zama.ai) TFHE library.
