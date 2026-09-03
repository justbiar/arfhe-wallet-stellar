Arfhe Wallet is a self-custodial Ethereum wallet built around fully homomorphic encryption (FHE). Alongside the ordinary public balance every wallet shows, it can hold *confidential* balances: token amounts that live on-chain as ciphertext, that the network can compute on, and that only you can read.

⚠️ PUBLIC TESTNET RELEASE — DO NOT USE WITH MAINNET FUNDS
This build runs on Sepolia, Base Sepolia and Arbitrum Sepolia only. It cannot be pointed at Ethereum mainnet, and no network can be added. Please create a fresh wallet for it rather than importing a phrase that holds real assets.

── CONFIDENTIAL BALANCES ──
Shield a token and its amount becomes an encrypted balance held by a confidential wrapper contract. The ciphertext is public; the number inside it is not. Unshield to convert back. Encryption and decryption happen in your browser, against the CoFHE coprocessor — the three networks above are the ones it runs on, which is why they are the ones shipped.

── YOUR KEYS STAY YOURS ──
• Keys are generated and stored locally, encrypted with a password you set (PBKDF2 + AES-GCM).
• There is no account, no custody and no key escrow. Nobody can move your funds for you — and nobody can recover them for you either, so keep your recovery phrase safe.
• Optional Google sign-in (via Web3Auth) derives a wallet without a phrase, for people who want one less thing to lose.

── SEE WHAT YOU ARE SIGNING ──
• Every transaction is simulated before you approve it, with the balance changes it would cause.
• Connection requests show which site is asking, which networks it wants and which permissions it is requesting.
• Known phishing domains are flagged on the approval screen.
• `eth_sign` — the method that signs opaque bytes which may turn out to be a transaction hash — is not offered at all.

── CONNECT TO dAPPS ──
• WalletConnect v2 for QR and deep-link connections.
• EIP-6963 provider discovery, so the wallet appears in a site's wallet picker alongside others instead of fighting over `window.ethereum`.
• A connections list on the home screen shows every site and session that currently has access, with one-tap disconnect.
• A dedicated page lists standing ERC-20 approvals so you can revoke the ones you no longer need.

── AN ASSISTANT THAT CANNOT SIGN ──
The built-in AI assistant can read balances, list your accounts, check approvals and look up faucets. When you ask it to move funds it produces a *proposal* — a preview you review and approve yourself. It has no path to your private key and cannot broadcast anything on its own. A policy engine caps what it may propose relative to your balance, and every state-changing action ends at a confirmation card in your hands.

── PRIVACY ──
• No analytics SDK, no session recording, no ad or tracking network.
• Balances are read from the RPC providers the wallet is configured with; nothing about your activity is sold or shared.
• Domain names for recipients are resolved only where you type them, never behind your back.

── ALSO INCLUDED ──
Multiple accounts from one recovery phrase, private-key import, an address book, transaction history with CSV export, portfolio value over time, spam-token filtering, English and Turkish interfaces, light and dark themes.

── PRIVACY POLICY ──
https://arfhewallet.dev/privacy

── CONTACT ──
Arfhe Wallet is built by ArfDAO — https://www.arfdao.dev
Security reports: security@arfdao.dev
