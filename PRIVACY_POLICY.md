# Privacy Policy

**Arfhe Wallet** — Privacy-first FHE-powered Crypto Wallet  
**Effective Date:** March 8, 2026  
**Last Updated:** September 2, 2026

---

## 1. Introduction

Arfhe Wallet ("we", "our", "the Extension") is an open-source Chrome browser extension that provides a self-custodial cryptocurrency wallet with Fully Homomorphic Encryption (FHE) privacy features.

This Privacy Policy explains what data Arfhe Wallet collects, how it is used, and your rights regarding your information.

## 2. Data We Do NOT Collect

- ❌ **No names, emails or phone numbers** — We never ask for them, and social sign-in does not pass your email address to us.
- ❌ **No private keys or recovery phrases** — These never leave your device in any form.
- ❌ **No analytics or tracking SDK** — No Google Analytics, Mixpanel, PostHog, Sentry or similar. There is no session recording and no advertising network.
- ❌ **No cookies** — The Extension does not set or read browser cookies.
- ❌ **No browsing history** — We do not monitor, collect, or transmit the pages you visit.
- ❌ **No transaction amounts** — Our servers never receive how much you sent, shielded or unshielded, nor who you sent it to.

## 2a. Data We DO Collect

We collect a small amount of pseudonymous data on infrastructure operated by ArfDAO. This
section is deliberately specific, because a privacy policy that claims to collect nothing
while the software collects something is worse than one that collects more and says so.

| What | When | Sent to |
|------|------|---------|
| Your wallet address | Once, when a wallet is created or imported | `/users/register` |
| How that wallet was created — one of `google`, `created`, `mnemonic`, `private_key` | Same request | `/users/register` |
| That an action of type `send`, `shield` or `unshield` occurred, and when | Each time you complete one | `/activity/log` |

That is the whole record. **No amount, no recipient, no token, no transaction hash and no
balance** is accepted or stored by either endpoint. The purpose is to understand how many
wallets exist and roughly how actively the product is used.

A wallet address is a public identifier, but it is persistent and unique to you, and our
servers necessarily see the IP address any request arrives from. We therefore treat this as
personally identifiable information rather than pretending it is anonymous.

If you use the built-in AI assistant, the messages you type — and the wallet context needed
to answer them, such as balances and account addresses — are sent to our proxy and from
there to OpenRouter, which routes them to a language model. Do not type anything into the
assistant that you would not want a third-party model provider to process. The assistant
never receives your private key or recovery phrase.

## 3. Data Stored Locally

Wallet data — keys, accounts, settings, caches — is stored **on your device** using the Chrome `storage.local` API. None of the following is transmitted anywhere:

| Data | Purpose | Storage |
|------|---------|---------|
| Encrypted private keys & mnemonics | Wallet access | AES-256-GCM encrypted, local only |
| Account addresses | Display & transaction building | Local only |
| Token balances & transaction history | UI display | Local cache, fetched from public blockchains |
| User preferences (theme, language, networks) | UI customization | Local only |
| Contact book entries | Address book | Local only |
| Auto-lock timer settings | Security | Local only |

**Important:** Your private keys and recovery phrases are encrypted with AES-256-GCM using a key derived from your password via PBKDF2 (100,000 iterations, SHA-256). They never leave your device in unencrypted form.

## 4. Network Communications

Arfhe Wallet communicates with the following external services **only to provide wallet functionality**:

### 4.1 Blockchain RPC Providers
- **Alchemy** (`*.alchemy.com`) — To read blockchain state and broadcast transactions
- **Public RPC endpoints** — For custom networks added by the user

**Data sent:** Wallet addresses, transaction data (when you initiate a transaction)  
**Purpose:** Core wallet operations (balance queries, transaction broadcasting)

### 4.2 Price & Token Data
- **CoinGecko API** — Token price data
- **Alchemy NFT API** — NFT metadata

**Data sent:** Token contract addresses, wallet addresses  
**Purpose:** Displaying portfolio values and NFT collections

### 4.3 WalletConnect (Optional)
- **WalletConnect relay servers** — Only when the user explicitly connects to a dApp

**Data sent:** Session metadata, transaction requests  
**Purpose:** dApp connectivity (user-initiated only)

### 4.4 ArfDAO Backend (Usage Record)
- **ArfDAO backend** — Receives the pseudonymous record described in Section 2a

**Data sent:** Wallet address; how the wallet was created; that a send/shield/unshield happened, and when
**Purpose:** Counting wallets and measuring how actively the product is used
**Never sent:** Amounts, recipients, token identities, transaction hashes, balances

### 4.5 AI Assistant (Optional, user-initiated)
- **ArfDAO agent proxy → OpenRouter** — Only when you send a message to the assistant

**Data sent:** Your message, the conversation, and wallet context needed to answer it (balances, account addresses, network)
**Purpose:** Generating the assistant's reply
**Never sent:** Private keys, recovery phrases. The assistant cannot sign or broadcast anything; it can only propose an action for you to approve.

### 4.6 Fhenix FHE Network (Optional)
- **Fhenix Sepolia RPC** — For FHE shield/unshield operations

**Data sent:** Encrypted transaction data  
**Purpose:** Fully Homomorphic Encryption operations

### 4.5 Phishing Protection
- **MetaMask phishing list** (fetched from GitHub) — Domain blocklist

**Data sent:** None (the list is downloaded, not your browsing data)  
**Purpose:** Protecting users from known phishing sites

## 5. Permissions

The Extension requests the following Chrome permissions:

| Permission | Reason |
|------------|--------|
| `storage` | Store encrypted wallet data locally |
| `notifications` | Transaction confirmations and security alerts |
| `alarms` | Auto-lock timer functionality |
| `scripting` | DApp interaction via content scripts |
| `host_permissions (http/https)` | Communicate with blockchain RPC providers |

## 6. Third-Party Services

We do not sell or rent your data, and we do not share it for advertising or profiling. Data reaches the service providers listed below only as needed to operate the wallet — including OpenRouter, which processes assistant messages (Section 4.5). The blockchain RPC providers listed in Section 4 may have their own privacy policies:

- [Alchemy Privacy Policy](https://www.alchemy.com/policies/privacy-policy)
- [CoinGecko Privacy Policy](https://www.coingecko.com/en/privacy)
- [WalletConnect Privacy Policy](https://walletconnect.com/privacy)

## 7. Data Retention & Deletion

**On your device.** You can delete everything the Extension stores at any time by removing
it from Chrome, or by clearing its data from `chrome://extensions`. This erases the encrypted
vault along with it — if you have no backup of your recovery phrase, the wallet is gone with
it, and we cannot restore it for you.

**On our servers.** The pseudonymous record described in Section 2a is retained while the
product is operated. To have the rows for your wallet address deleted, write to the contact
address in Section 12 with the address in question. Because the record contains no name or
email, the wallet address is the only way we can identify what to delete.

## 8. Children's Privacy

Arfhe Wallet is not intended for use by individuals under the age of 18. We do not knowingly collect data from minors.

## 9. Security

- Private keys are encrypted with **AES-256-GCM** (PBKDF2-derived key, 600,000 iterations)
- All sensitive operations require password authentication
- Auto-lock functionality secures the wallet after inactivity
- Open-source codebase for community audit
- See our [Security Policy](SECURITY.md) for vulnerability reporting

## 10. Open Source

Arfhe Wallet is licensed under the MIT License. The repository is at
**https://github.com/ArfDAO/ArfheWallet**.

It is private at the time of writing, so this link will not open for everyone yet. This
section will be updated when the source is published, rather than describing the software as
publicly auditable before it actually is.

## 11. Changes to This Policy

We may update this Privacy Policy from time to time. Changes will be reflected in the "Last Updated" date above and published in the GitHub repository.

## 12. Contact

For privacy-related questions or concerns:

- **GitHub:** [github.com/ArfDAO/ArfheWallet](https://github.com/ArfDAO/ArfheWallet)
- **Email:** arfhewallet@protonmail.com
