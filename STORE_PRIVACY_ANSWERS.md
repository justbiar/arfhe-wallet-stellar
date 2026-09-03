# Chrome Web Store — Privacy practices & Settings answers

Copy each block into the matching field. Every claim below is checkable against the
source at https://github.com/ArfDAO/ArfheWallet.

---

## Category
Productivity  (sub-category: Workflow & Planning)

## Language
English (United States)

---

## Single purpose description

Arfhe Wallet is a self-custodial Ethereum wallet. Its single purpose is to let a person
hold keys, view balances, and sign transactions on the Ethereum test networks it
supports — including confidential (FHE-encrypted) token balances, which is the feature
that distinguishes it from an ordinary wallet. Everything in the extension serves that
one purpose: creating or importing an account, reading balances, connecting to a site,
and approving a transaction.

---

## Permission justifications

### storage
Used to keep the wallet itself: the encrypted key vault, account names, the user's
network and language preferences, cached token metadata, and the list of sites the user
has granted access to.

`chrome.storage.local` holds the encrypted vault and settings; `chrome.storage.session`
holds the derived encryption key only while the wallet is unlocked, so the key is
discarded when the browser session ends rather than persisting to disk. Private keys are
never stored in plaintext — they are encrypted with a key derived from the user's
password via PBKDF2 (100,000 iterations, SHA-256) and sealed with AES-GCM.

Without this permission the wallet cannot remember an account between popup openings,
which is the same as not being a wallet.

### alarms
The extension's background service worker is stopped by Chrome when idle. Alarms are the
only supported way to schedule work that must continue after that. They are used for
exactly four recurring jobs:

- watching a transaction the user has already submitted, so its confirmation can be
  reported instead of leaving the user guessing;
- scanning for incoming transfers to the user's own addresses;
- keeping the toolbar badge count (pending items) accurate;
- retrying a queued registration request that failed while offline.

No alarm sends user data anywhere; each one reads chain state or updates local UI state.

### notifications
Used to tell the user about events they asked to be told about, and nothing else:
a transaction they submitted was confirmed, a transaction they submitted failed, or funds
arrived at one of their addresses. These fire only for the user's own accounts and carry
no marketing, promotional or third-party content. A wallet that cannot report the outcome
of a transaction the user just signed leaves them refreshing a block explorer instead.

### Host permissions (http://*/*, https://*/*, ws://*/*, wss://*/*)
Two uses, both intrinsic to being a wallet:

1. **Talking to blockchain nodes.** The wallet reads balances and submits transactions
   over JSON-RPC to Ethereum node providers, and connects to the WalletConnect relay over
   a WebSocket (wss://relay.walletconnect.org). Users may also point the wallet at their
   own node, whose address cannot be known in advance — which is why the pattern cannot be
   narrowed to a fixed list.

2. **Announcing the wallet to web pages.** A content script runs on pages so a dApp can
   discover the wallet through the EIP-6963 standard and request a connection. Any site
   may be a dApp, so the content script must be able to run on any site. It injects only a
   provider object; it does not read page content, does not modify pages, and sends
   nothing anywhere until the user explicitly approves a connection for that specific site.

No user data is collected from visited pages. A site gets access only to the account
addresses the user approves for it, and that grant can be revoked from inside the wallet.

### Remote code
The extension does **not** execute remote code. All JavaScript and WebAssembly is bundled
in the package and shipped with it — including the 3.2 MB FHE library (`tfhe_bg.wasm`),
which is a local file, not a download. The Content Security Policy in the manifest
enforces this: `script-src 'self' 'wasm-unsafe-eval'` permits no remote script origin at
all.

`'wasm-unsafe-eval'` is present because instantiating bundled WebAssembly requires it. It
does not allow remote code; it allows the extension's own, already-shipped `.wasm` file to
be compiled. Network access is used only for data — JSON-RPC responses, token prices,
icons — never for code.

---

## Data usage certification

Declare the following, then tick the three certification boxes.

**Data collected:** none of the listed categories.

The extension does not collect, transmit or sell personally identifiable information,
health information, financial and payment information, authentication information,
personal communications, location, web history, or user activity. Private keys and the
recovery phrase never leave the device and are never transmitted.

The wallet does record — against a pseudonymous wallet address, on infrastructure operated
by ArfDAO — that an action of a given type occurred (a send, a shield, an unshield). No
amount, no counterparty and no transaction content is accepted or stored by that endpoint.
If this must be declared, it falls under "user activity"; it carries no personally
identifiable information.

**Certifications to tick:**
- I do not sell or transfer user data to third parties, outside of approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

---

## Settings page

**Contact email:** an address you control and can verify — Google sends a confirmation
link to it, and the listing cannot be published until you click it.

**Privacy policy URL:** required, because the extension requests host permissions.
`PRIVACY_POLICY.md` exists in the repository but a URL must be publicly reachable.
Publish it under the DAO's site (for example https://www.arfdao.dev/privacy) and paste
that address here. A raw GitHub link works if nothing else is ready.
