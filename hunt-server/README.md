# Arfhe hunt server

Hands out phrase fragments to wallets that have earned them.

## Why this exists

The fragments used to be literals in the extension's source. Someone gave the built folder
to a language model and read every word out of it in under a minute. That is not a failure
of hiding — a bundle is a recipe for what it displays, and any reader of the recipe can cook
it. Obfuscation costs a person an afternoon and a machine a few seconds.

So the words live here, on a machine the finder does not control, and are handed over only
to a caller who can prove they did something the bundle cannot fake for them.

## The gate budget is not decoration

There is no BIP-39 passphrase in this design, so these gates are the entire protection.
Brute-forcing the missing words of a 24-word phrase, measured:

| missing | time (ordinary multi-core machine) |
|--------:|------------------------------------|
| 2 | 0.1 seconds |
| 3 | 5 minutes |
| 4 | 6.6 days — hours on rented GPUs |
| 6 | 76,000 years |

With 12 words published on social media (treat those as public), an attacker who also
collects the wallet's easy fragments needs only to close the gap:

- 3 easy fragments → 6 words missing → safe
- 4 easy fragments → 4 words missing → **hunt over in under a week**

**At most three fragments may use the `signature` gate.** `fragments.example.json` is built
to that limit. Raising it ends the hunt.

## Setup

```bash
cp fragments.example.json fragments.json   # then fill in the real words
npm i ethers                                # or symlink the wallet's node_modules
```

Environment:

```
PORT=8787
FRAGMENTS_FILE=./fragments.json
CLAIMS_FILE=./claims.json
RPC_SEPOLIA=https://eth-sepolia.g.alchemy.com/v2/<key>
RPC_ARB_SEPOLIA=https://arb-sepolia.g.alchemy.com/v2/<key>
RPC_BASE_SEPOLIA=https://base-sepolia.g.alchemy.com/v2/<key>
ALLOWED_ORIGINS=chrome-extension://jdihllmgakeejednibihnpclbddgfchp
```

Run it behind the nginx that already terminates TLS for `mcp.arfhewallet.dev`, then point
the wallet at it:

```
VITE_HUNT_API_URL=https://mcp.arfhewallet.dev/hunt-api
```

Leaving `VITE_HUNT_API_URL` empty switches the hunt off — the marks stay silent and no
request is made.

## Endpoints

| | |
|---|---|
| `POST /hunt/nonce` | issues a single-use nonce |
| `POST /hunt/fragment` | `{fragmentId, address, signature, nonce}` → `{words}` or a reason |
| `POST /hunt/stats` | how many claimed each fragment |

## What this does not fix

**A finder can share what they found.** No design prevents that; `claims.json` at least tells
you who got there first.

**An AI agent can still play** — install the wallet, shield on testnet, call the endpoint.
That is not a bypass, that is the game. What it can no longer do is read the answers out of
the bundle in a minute.

**Whoever holds this server holds the words.** Its security is now the hunt's security.

---

## The decoy (team note — this file does not ship)

`public/hunt-manifest.json` ships in the extension folder and looks like the map this hunt
used to keep in source. It is not one. Its twelve words are a valid BIP-39 phrase that opens
an empty wallet, and read in order they are the message:

> nice try — you must open real one, find word inside — human effort

It carries no explanation of itself. An earlier draft had a `note` field saying "this is a
decoy", which defeated the point: a model summarising the folder would have read that note
and warned its user, and the shortcut would have cost them nothing. Without it the file is
indistinguishable from a real map until someone imports the phrase and finds an empty wallet.

Two reasons it exists:

- **A canary.** Those twelve words appear nowhere else. If that phrase turns up in a
  submission, a Discord message or a screenshot, we know exactly which shortcut produced it.
- **An answer.** Someone who pastes the folder into a model gets a plausible result rather
  than nothing, spends an afternoon on it, and is told — by the words themselves — what they
  would have had to do instead.

It is data, not a prompt injection. Nothing in it is written to steer a model's behaviour:
an injection cannot choose its reader, and the next agent to read this repository is as
likely to be one of ours running a review or a CI scan.

**Regenerate it if it leaks**, and check any replacement is a valid phrase — an invalid
checksum announces itself as fake the moment anyone tries it.
