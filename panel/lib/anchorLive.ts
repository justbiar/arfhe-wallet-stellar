/**
 * Live readings from the anchor, for the product page.
 *
 * The Confidential Anchor page argued for something without ever showing it running. These
 * are the numbers the anchor publishes about itself — status, rates, limits — fetched when
 * the page opens, so the claim and the thing being claimed are on the same screen.
 *
 * Every value here comes from the anchor's own endpoints. Nothing is hardcoded except which
 * anchor to ask, and nothing is smoothed over: an endpoint that does not answer is reported
 * as not answering rather than replaced with a plausible number.
 */

import { ANCHOR_HOME_DOMAIN, ANCHOR_ASSET_CODE, FIAT_CODE } from "./anchor";

const BASE = `https://${ANCHOR_HOME_DOMAIN}`;

export interface AnchorHealth {
  ok: boolean;
  environment: string;
  stellarMode: string;
  networkPassphrase: string;
}

export interface AnchorRates {
  /** TRY paid per 1 USDC when buying USDC (the on-ramp direction). */
  buy: string | null;
  /** TRY received per 1 USDC when selling USDC (the off-ramp direction). */
  sell: string | null;
}

export interface AnchorLimits {
  depositMin: number | null;
  depositMax: number | null;
  withdrawMin: number | null;
  feePercent: number | null;
}

export interface AnchorLive {
  health: AnchorHealth | null;
  rates: AnchorRates;
  limits: AnchorLimits;
  assetIssuer: string | null;
}

async function getJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${BASE}${path}`);
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    // Offline, blocked, or the anchor is down. The page says so; it does not invent.
    return null;
  }
}

/**
 * SEP-38 quotes both ways.
 *
 * Asked as two separate questions because the spread is the point: buying and selling do
 * not happen at the same number, and showing one rate would hide the anchor's margin.
 */
async function readRates(issuer: string | null): Promise<AnchorRates> {
  if (!issuer) return { buy: null, sell: null };
  const usdc = `stellar:${ANCHOR_ASSET_CODE}:${issuer}`;
  const fiat = `iso4217:${FIAT_CODE}`;

  const [buying, selling] = await Promise.all([
    getJson(`/sep38/prices?sell_asset=${encodeURIComponent(fiat)}&sell_amount=100&buy_asset=${encodeURIComponent(usdc)}`),
    getJson(`/sep38/prices?sell_asset=${encodeURIComponent(usdc)}&sell_amount=1&buy_asset=${encodeURIComponent(fiat)}`),
  ]);

  const pick = (body: Record<string, unknown> | null) => {
    const assets = body?.buy_assets as { price?: string }[] | undefined;
    return assets?.[0]?.price ?? null;
  };

  // SEP-38 quotes a price in units of the SELL asset per unit of the BUY asset. Buying
  // USDC with TRY therefore already reads as TRY-per-USDC, but selling USDC for TRY comes
  // back as USDC-per-TRY — 0.0206, not 48.54. Printing it straight put "1 USDC = 0.0206
  // TRY" on the page, which is the same rate stated upside down and reads as a collapse.
  const sellRaw = pick(selling);
  const sellPerUsdc = sellRaw && Number(sellRaw) > 0 ? String(1 / Number(sellRaw)) : null;

  return { buy: pick(buying), sell: sellPerUsdc };
}

/** The asset's issuer, discovered from stellar.toml rather than assumed. */
async function readIssuer(): Promise<string | null> {
  try {
    const res = await fetch(`${BASE}/.well-known/stellar.toml`);
    if (!res.ok) return null;
    const toml = await res.text();
    const block = toml
      .split(/\[\[CURRENCIES\]\]/)
      .find((b) => new RegExp(`code\\s*=\\s*"${ANCHOR_ASSET_CODE}"`).test(b));
    return block?.match(/issuer\s*=\s*"([^"]+)"/)?.[1] ?? null;
  } catch {
    return null;
  }
}

async function readLimits(): Promise<AnchorLimits> {
  const info = await getJson("/sep6/info");
  const asset = (info?.deposit as Record<string, Record<string, unknown>> | undefined)?.[ANCHOR_ASSET_CODE];
  const withdraw = (info?.withdraw as Record<string, Record<string, unknown>> | undefined)?.[ANCHOR_ASSET_CODE];
  return {
    // NOTE: these are the anchor's own numbers and they are NOT the TRY limits the deposit
    // endpoint enforces — /sep6/info answers in the asset's units while `deposit?amount=`
    // is TRY. Shown as the anchor states them, labelled as such. See stellar.md §4.
    depositMin: typeof asset?.min_amount === "number" ? asset.min_amount : null,
    depositMax: typeof asset?.max_amount === "number" ? asset.max_amount : null,
    withdrawMin: typeof withdraw?.min_amount === "number" ? withdraw.min_amount : null,
    feePercent: typeof asset?.fee_percent === "number" ? asset.fee_percent : null,
  };
}

export async function readAnchorLive(): Promise<AnchorLive> {
  const [healthBody, issuer] = await Promise.all([getJson("/health"), readIssuer()]);
  const [rates, limits] = await Promise.all([readRates(issuer), readLimits()]);

  return {
    health: healthBody
      ? {
          ok: healthBody.ok === true,
          environment: String(healthBody.environment ?? "—"),
          stellarMode: String(healthBody.stellar_mode ?? "—"),
          networkPassphrase: String(healthBody.network_passphrase ?? "—"),
        }
      : null,
    rates,
    limits,
    assetIssuer: issuer,
  };
}
