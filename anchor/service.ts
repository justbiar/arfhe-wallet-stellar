/**
 * The anchor, as a wallet sees it: SEP-1, SEP-10, SEP-6, SEP-38 and the one field the
 * anchor we replaced ignored — the customer's IBAN.
 *
 *   npm run anchor        # :8790
 *
 * Point a wallet at it by changing one constant (`ANCHOR_HOME_DOMAIN`); everything else is
 * discovered from the TOML, which is why this can stand in for the old one without
 * touching a single screen.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  PORT, HOME_DOMAIN, NETWORK_PASSPHRASE, ASSET_CODE, ASSET_ISSUER, FIAT_CODE,
  COLLECTION_IBAN, BANK_NAME, FEE_PERCENT, SIGNING_KEYPAIR, ORIGIN, rates,
} from "./config.js";
import { challenge, verify, accountFromToken } from "./auth.js";
import * as store from "./store.js";
import { distributionAddress, treasury } from "./stellar.js";
import { startWorker } from "./worker.js";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "cross-origin-resource-policy": "cross-origin",
};

const send = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { ...CORS, "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return {}; }
}

const money = (n: number): string => n.toFixed(7);

/** SEP-6's shape, which is what the wallet's client is written against. */
function toSep6(tx: store.AnchorTransaction) {
  return {
    id: tx.id,
    kind: tx.kind,
    status: tx.status,
    status_eta: tx.statusEta,
    more_info_url: `${ORIGIN}/sep6/tx/${tx.id}`,
    message: tx.message,
    started_at: tx.startedAt,
    updated_at: tx.updatedAt,
    completed_at: tx.completedAt,
    amount_in: tx.amountIn,
    amount_in_asset: tx.amountInAsset,
    amount_out: tx.amountOut,
    amount_out_asset: tx.amountOutAsset,
    amount_fee: tx.amountFee,
    stellar_transaction_id: tx.stellarTransactionId,
    external_transaction_id: null,
    refunded: false,
    to: tx.kind === "deposit" ? tx.account : tx.destIban,
    from: tx.kind === "deposit" ? COLLECTION_IBAN : tx.account,
  };
}

const TOML = () => `VERSION="2.7.0"
NETWORK_PASSPHRASE="${NETWORK_PASSPHRASE}"
SIGNING_KEY="${SIGNING_KEYPAIR.publicKey()}"
WEB_AUTH_ENDPOINT="${ORIGIN}/auth"
TRANSFER_SERVER="${ORIGIN}/sep6"
KYC_SERVER="${ORIGIN}/sep12"
ANCHOR_QUOTE_SERVER="${ORIGIN}/sep38"
ACCOUNTS=["${distributionAddress()}", "${SIGNING_KEYPAIR.publicKey()}"]

[DOCUMENTATION]
ORG_NAME="Arfhe Test Anchor"
ORG_URL="${ORIGIN}"
ORG_DESCRIPTION="Sandbox TRY <-> USDC anchor for Arfhe Wallet. Not a financial service. No real money moves."

[[CURRENCIES]]
code="${ASSET_CODE}"
issuer="${ASSET_ISSUER}"
status="test"
display_decimals=2
is_asset_anchored=true
`;

const server = createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }

    const url = new URL(req.url ?? "/", `http://${HOME_DOMAIN}`);
    const path = url.pathname;
    const account = accountFromToken(req.headers.authorization);

    // ── SEP-1 ──
    if (path === "/.well-known/stellar.toml") {
      res.writeHead(200, { ...CORS, "content-type": "text/plain" });
      return res.end(TOML());
    }

    if (path === "/health") {
      // The first three fields are what the panel's anchor page reads. Kept in the shape
      // the anchor this replaces used, so the page needed no change to point at us.
      return send(res, 200, {
        ok: true,
        service: "arfhe-mock-anchor",
        environment: "sandbox",
        stellar_mode: "live",
        network_passphrase: NETWORK_PASSPHRASE,
        asset: { code: ASSET_CODE, issuer: ASSET_ISSUER },
        distribution: distributionAddress(),
        treasury: await treasury(),
        rates: rates(),
      });
    }

    // ── SEP-10 ──
    if (path === "/auth" && req.method === "GET") {
      const who = url.searchParams.get("account");
      if (!who) return send(res, 400, { error: "account is required" });
      return send(res, 200, challenge(who));
    }

    if (path === "/auth" && req.method === "POST") {
      const body = await readBody(req);
      try {
        const { token } = verify(String(body.transaction ?? ""));
        return send(res, 200, { token });
      } catch (e) {
        return send(res, 400, { error: e instanceof Error ? e.message : "invalid challenge" });
      }
    }

    // ── SEP-38: one mid rate, two sides ──
    if (path === "/sep38/prices") {
      const { buy, sell } = rates();
      const sellAsset = url.searchParams.get("sell_asset") ?? "";
      const buyingUsdc = sellAsset.startsWith("iso4217");
      // Quoted in units of the SELL asset per unit of the BUY asset, which is why the
      // USDC->TRY direction is a fraction. Wallets that print it straight show "1 USDC =
      // 0.02 TRY"; that is the spec, not a bug, and it is on them to invert.
      const price = buyingUsdc ? buy : 1 / sell;
      return send(res, 200, {
        buy_assets: [{
          asset: buyingUsdc ? `stellar:${ASSET_CODE}:${ASSET_ISSUER}` : `iso4217:${FIAT_CODE}`,
          price: String(price),
          decimals: 7,
        }],
      });
    }

    // ── SEP-6 ──
    if (path === "/sep6/info") {
      return send(res, 200, {
        deposit: {
          [ASSET_CODE]: {
            enabled: true, authentication_required: true, fee_percent: FEE_PERCENT,
            funding_methods: ["bank_account"],
            fields: { type: { description: "How the TRY arrives.", choices: ["bank_account"], optional: false } },
          },
        },
        withdraw: {
          [ASSET_CODE]: {
            enabled: true, authentication_required: true, fee_percent: FEE_PERCENT,
            funding_methods: ["bank_account"],
            types: {
              bank_account: {
                fields: {
                  // Declared, because it is actually used. The anchor this replaces
                  // advertised no fields and discarded the destination it was given.
                  dest: { description: "IBAN the lira are paid to", optional: false },
                  dest_extra: { description: "Account holder's name", optional: true },
                },
              },
            },
          },
        },
        fee: { enabled: false },
        transactions: { enabled: true, authentication_required: true },
      });
    }

    if (path === "/sep6/deposit") {
      if (!account) return send(res, 403, { error: "authentication required" });
      const amountTry = url.searchParams.get("amount");
      const reference = store.referenceFor(account);
      const { buy } = rates();

      const gross = amountTry ? Number(amountTry) : null;
      const fee = gross !== null ? (gross * FEE_PERCENT) / 100 : null;
      const out = gross !== null && fee !== null ? (gross - fee) / buy : null;

      const tx = store.create({
        kind: "deposit",
        status: "pending_user_transfer_start",
        statusEta: null,
        message: `Send ${FIAT_CODE} to ${COLLECTION_IBAN} with reference ${reference}.`,
        account,
        amountIn: gross !== null ? gross.toFixed(2) : null,
        amountInAsset: `iso4217:${FIAT_CODE}`,
        amountOut: out !== null ? money(out) : null,
        amountOutAsset: `stellar:${ASSET_CODE}:${ASSET_ISSUER}`,
        amountFee: fee !== null ? fee.toFixed(2) : null,
        completedAt: null,
        stellarTransactionId: null,
        reference,
        destIban: null,
      });

      return send(res, 200, {
        id: tx.id,
        how: `Send ${FIAT_CODE} to ${COLLECTION_IBAN} at ${BANK_NAME} with the reference "${reference}".`,
        instructions: {
          bank_account_number: { value: COLLECTION_IBAN, description: "IBAN to send the transfer to" },
          bank_name: { value: BANK_NAME, description: "Bank" },
          external_transfer_memo: { value: reference, description: "Put this in the transfer description" },
        },
        fee_percent: FEE_PERCENT,
      });
    }

    if (path === "/sep6/withdraw") {
      if (!account) return send(res, 403, { error: "authentication required" });
      const amountUsdc = Number(url.searchParams.get("amount") ?? "0");
      if (!(amountUsdc > 0)) return send(res, 400, { error: "amount is required" });

      // The customer's IBAN, used as given. This is the entire reason this anchor exists.
      const dest = url.searchParams.get("dest");
      if (!dest || !/^TR\d{24}$/.test(dest.replace(/\s/g, ""))) {
        return send(res, 400, {
          error: "dest must be a Turkish IBAN (TR followed by 24 digits)",
          fields: { dest: { description: "IBAN the lira are paid to", optional: false } },
        });
      }

      const { sell } = rates();
      const feeUsdc = (amountUsdc * FEE_PERCENT) / 100;
      const outTry = (amountUsdc - feeUsdc) * sell;
      const memo = String(Math.floor(Math.random() * 9_000_000_000) + 1_000_000_000);

      const tx = store.create({
        kind: "withdrawal",
        status: "pending_user_transfer_start",
        statusEta: 10,
        message: `Send ${money(amountUsdc)} ${ASSET_CODE} to ${distributionAddress()} with memo ${memo}.`,
        account,
        amountIn: money(amountUsdc),
        amountInAsset: `stellar:${ASSET_CODE}:${ASSET_ISSUER}`,
        amountOut: outTry.toFixed(2),
        amountOutAsset: `iso4217:${FIAT_CODE}`,
        amountFee: money(feeUsdc),
        completedAt: null,
        stellarTransactionId: null,
        reference: memo,
        destIban: dest.replace(/\s/g, ""),
      });

      return send(res, 200, {
        id: tx.id,
        account_id: distributionAddress(),
        memo_type: "text",
        memo,
        eta: 10,
        fee_percent: FEE_PERCENT,
        extra_info: {
          message: `Send ${money(amountUsdc)} ${ASSET_CODE} to ${distributionAddress()} with memo ${memo}. ` +
            `${outTry.toFixed(2)} ${FIAT_CODE} will be paid (simulated) to ${dest}.`,
        },
      });
    }

    if (path === "/sep6/transactions") {
      if (!account) return send(res, 403, { error: "authentication required" });
      return send(res, 200, { transactions: store.forAccount(account).map(toSep6) });
    }

    if (path === "/sep6/transaction") {
      if (!account) return send(res, 403, { error: "authentication required" });
      const tx = store.get(url.searchParams.get("id") ?? "");
      if (!tx || tx.account !== account) return send(res, 404, { error: "transaction not found" });
      return send(res, 200, { transaction: toSep6(tx) });
    }

    /**
     * Sandbox only: the bank telling the anchor the lira arrived.
     *
     * A real anchor learns this from its bank. Kept on the same path the previous anchor
     * used so the wallet needs no second code path for the two of them.
     */
    if (path.startsWith("/sep6/tx/") && path.endsWith("/simulate-bank-transfer") && req.method === "POST") {
      if (!account) return send(res, 403, { error: "authentication required" });
      const id = path.slice("/sep6/tx/".length, -"/simulate-bank-transfer".length);
      const tx = store.get(id);
      if (!tx || tx.account !== account) return send(res, 404, { error: "transaction not found" });

      const body = await readBody(req);
      const gross = Number(body.amount ?? tx.amountIn ?? 0);
      if (!(gross > 0)) return send(res, 400, { error: "amount is required" });

      const { buy } = rates();
      const fee = (gross * FEE_PERCENT) / 100;
      store.update(id, {
        status: "pending_anchor",
        statusEta: 5,
        message: `${FIAT_CODE} received; paying ${ASSET_CODE} on Stellar.`,
        amountIn: gross.toFixed(2),
        amountFee: fee.toFixed(2),
        amountOut: money((gross - fee) / buy),
      });
      return send(res, 200, { ok: true });
    }

    return send(res, 404, { error: "not found" });
  } catch (e) {
    console.error("  [anchor] request failed:", e instanceof Error ? e.message : e);
    return send(res, 500, { error: e instanceof Error ? e.message : "unknown error" });
  }
});

server.listen(PORT, async () => {
  const { buy, sell } = rates();
  console.log(`arfhe test anchor :${PORT}`);
  console.log(`  toml         http://${HOME_DOMAIN}/.well-known/stellar.toml`);
  console.log(`  distribution ${distributionAddress()}`);
  console.log(`  rates        alış ${buy.toFixed(4)} / satış ${sell.toFixed(4)} ${FIAT_CODE}/${ASSET_CODE}`);

  const funds = await treasury();
  if (!funds) {
    console.log(`  ⚠ dağıtım hesabı zincirde yok — friendbot ile fonlayın, sonra USDC yükleyin`);
  } else if (Number(funds.usdc) <= 0) {
    console.log(`  ⚠ kasada USDC yok (XLM ${funds.xlm}) — yatırmalar pending_trust'ta bekler`);
  } else {
    console.log(`  treasury     ${funds.usdc} ${ASSET_CODE} · ${funds.xlm} XLM`);
  }

  startWorker();
});
