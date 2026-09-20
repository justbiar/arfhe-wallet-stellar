/**
 * Gizli ödeme motoru — bordro, tedarik ve takasın ortak çekirdeği.
 *
 * Üçü de mekanik olarak aynı işlem: `confidential_transfer`. Farkları anlatıda —
 * bir→çok periyodik, bir→bir faturaya bağlı, çift yönlü netleştirme. Bu yüzden burada
 * tek bir motor var ve senaryo adı yalnızca bir etiket.
 *
 * ── Kanıt üretimi neden burada ──
 *
 * Her gizli transfer bir UltraHonk kanıtı istiyor ve onu `bb.js` üretiyor. bb.js kendi
 * Web Worker'ını `new Worker(new URL(...))` ile açtığı için paketleyiciden geçemiyor;
 * Node'da ise varsayılan yükleyici çalışıyor. Şirket tarafının sunucuda olmasının sebebi
 * kolaylık değil, bu — ve gerçekte de bordro sunucuda koşar.
 *
 * Çalışan tarafı buraya bağımlı değil: bakiyesini görmek için **çözme** yeter, kanıt
 * gerekmez. O yüzden cüzdan bu servisi hiç çağırmadan maaşı gösterebilir.
 */

import { Keypair } from "@stellar/stellar-sdk";
import { ChainClient, keypairSigner, type Signer } from "../vendor/ctd-sdk/src/chain/client.js";
import { addressToField } from "../vendor/ctd-sdk/src/crypto/address.js";
import { deriveKeys, type KeyPair } from "../vendor/ctd-sdk/src/crypto/keys.js";
import { randomScalar } from "../vendor/ctd-sdk/src/crypto/field.js";
import type { Point } from "../vendor/ctd-sdk/src/crypto/grumpkin.js";
import { buildRegisterWitness } from "../vendor/ctd-sdk/src/witness/register.js";
import { buildTransferWitness } from "../vendor/ctd-sdk/src/witness/transfer.js";
import { buildWithdrawWitness } from "../vendor/ctd-sdk/src/witness/withdraw.js";
import { CircuitProver } from "../vendor/ctd-sdk/src/proving/prover.js";
import { loadCircuit } from "../vendor/ctd-sdk/src/proving/artifacts.js";
import {
  submitRegister, submitDeposit, submitMerge, submitTransfer, submitWithdraw,
} from "../vendor/ctd-sdk/src/chain/contract.js";
import { StateEngine, MemoryStore } from "../vendor/ctd-sdk/src/state/index.js";
import { CT_DEPLOYMENT, RPC_URL, PASSPHRASE, AUDITOR_ID, toUnits, fromUnits } from "./deployment.js";
import { rampIn, rampOut, ensureTrustline, fundWithFriendbot, type RampOutResult } from "./anchor.js";

export interface Party {
  label: string;
  address: string;
  keypair: Keypair;
  keys: KeyPair;
  signer: Signer;
}

export interface PaymentResult {
  to: string;
  label: string;
  amount: string;
  hash: string;
  /** Kanıt üretimi dahil, uçtan uca. Jüriye söylenecek sayı bu. */
  seconds: number;
}

/**
 * Motor, uzun ömürlü bir nesne.
 *
 * `CircuitProver` başlatılması pahalı (wasm + CRS yükleniyor) ve yeniden kullanılmak
 * üzere tasarlanmış, o yüzden istek başına değil örnek başına bir kez kuruluyor.
 */
export class PayrollEngine {
  readonly client: ChainClient;
  readonly addrF: bigint;
  #auditorKey: Point | null = null;
  #registerProver = new CircuitProver(loadCircuit("register"));
  #transferProver = new CircuitProver(loadCircuit("transfer"));
  #withdrawProver = new CircuitProver(loadCircuit("withdraw"));

  constructor() {
    this.client = new ChainClient({
      rpcUrl: RPC_URL,
      networkPassphrase: PASSPHRASE,
      contracts: {
        token: CT_DEPLOYMENT.token,
        verifier: CT_DEPLOYMENT.verifier,
        auditor: CT_DEPLOYMENT.auditor,
      },
    });
    this.addrF = addressToField(CT_DEPLOYMENT.token);
  }

  /** Denetçinin açık anahtarı. Her transfer ciphertext'i buna da şifreleniyor. */
  async auditorKey(): Promise<Point> {
    if (!this.#auditorKey) this.#auditorKey = await this.client.auditorKey(AUDITOR_ID);
    return this.#auditorKey;
  }

  /** Yeni bir taraf: Stellar hesabı fonlanır, gizli anahtarları türetilir. */
  async createParty(label: string): Promise<Party> {
    const keypair = Keypair.random();
    await fundWithFriendbot(keypair.publicKey());
    return {
      label,
      address: keypair.publicKey(),
      keypair,
      keys: deriveKeys(randomScalar(), this.addrF),
      signer: keypairSigner(keypair.secret(), PASSPHRASE),
    };
  }

  /** Gizli katmana kaydolma. Ödeme alabilmek için şart — alıcı da kayıtlı olmalı. */
  async register(party: Party): Promise<void> {
    const w = buildRegisterWitness(party.keys);
    const { proof } = await this.#registerProver.prove(w.inputs);
    await submitRegister(this.client, party.signer, party.address, AUDITOR_ID, w, proof);
  }

  /** Anchor'dan TRY karşılığı USDC. Bu adım zincirde AÇIK ve öyle olmak zorunda. */
  async fundFromAnchor(party: Party, amountTry: string): Promise<string> {
    return rampIn(party.keypair, amountTry);
  }

  /**
   * Açık USDC'yi gizli bakiyeye çevirir.
   *
   * `deposit` parayı "alıcı" bakiyesine koyuyor, `merge` onu harcanabilir hale getiriyor.
   * İkisi ayrı, çünkü gelen para alıcıdan bir işlem beklemeden birikebiliyor.
   */
  async shield(party: Party, amountUsdc: string): Promise<void> {
    const units = toUnits(amountUsdc);
    await submitDeposit(this.client, party.signer, party.address, party.address, units);
    await submitMerge(this.client, party.signer, party.address);
  }

  /**
   * Maaşı nakde çevirme: gizli bakiye → açık USDC → anchor → IBAN'a TRY.
   *
   * Üç adım, üçü de ayrı bir sebepten ayrı:
   *
   *   merge    — gelen para ayrı bir kovada birikiyor ve harcanabilir değil. Alıcının kendi
   *              imzası olmadan kimse onu harcanabilir yapamaz; bu, ödeme almanın alıcıdan
   *              bir işlem beklememesinin bedeli.
   *   withdraw — gizli bakiyeden açık deftere dönüş. **Tutar burada açığa çıkıyor**, çünkü
   *              açık defterin tuttuğu şey bir sayı. Gizlenen, bu iki uç arasındaki hareket.
   *   rampOut  — açık USDC'yi anchor'a gönderip karşılığında IBAN'a TRY almak.
   *
   * Ara adımın sızıntısı gerçek ve kaçınılmaz: çekim anında zincire bakan biri bu adresin
   * ne kadar bozdurduğunu görür. Göremediği şey o paranın hangi maaş olduğu — ödeme zaten
   * gizliydi ve bakiyenin geçmişi hâlâ gizli.
   */
  async cashOut(party: Party, iban: string): Promise<{
    merged: string | null;
    unshielded: { amount: string; hash: string };
    ramp: RampOutResult;
  }> {
    // Güven hattı önce: `withdraw` kontrattan klasik USDC gönderiyor ve hattı olmayan bir
    // hesap onu kabul edemiyor. Kanıt doğrulandıktan sonra düşen bir işlem, sebebi zincirin
    // derinliğinde kalan bir hata demek.
    await ensureTrustline(party.keypair, CT_DEPLOYMENT.underlyingIssuer);

    const state = this.stateFor(party);
    await state.sync();

    // Gelen bakiye varsa harcanabilir hale getir. Yoksa merge boşuna bir işlem olur.
    let merged: string | null = null;
    const before = await state.current();
    if (before.receiving.v > 0n) {
      const r = await submitMerge(this.client, party.signer, party.address);
      merged = r.hash;
      await state.sync();
    }

    const current = await state.current();
    if (current.spendable.v <= 0n) throw new Error(`${party.label} için harcanabilir bakiye yok`);

    const kAud = await this.auditorKey();
    const w = buildWithdrawWitness({
      keys: party.keys,
      v: current.spendable.v,
      r: current.spendable.r,
      amount: current.spendable.v,
      kAudS: kAud,
    });
    const { proof } = await this.#withdrawProver.prove(w.inputs);
    const out = await submitWithdraw(
      this.client, party.signer, party.address, party.address, current.spendable.v, w, proof,
    );
    await state.sync();

    const amount = fromUnits(current.spendable.v);
    return { merged, unshielded: { amount, hash: out.hash }, ramp: await rampOut(party.keypair, amount, iban) };
  }

  /** Bir tarafın gizli bakiyesi, zincirdeki olaylardan yeniden kurularak. */
  async balance(party: Party): Promise<{ spendable: string; receiving: string }> {
    const engine = this.stateFor(party);
    const s = await engine.sync();
    return { spendable: fromUnits(s.spendable.v), receiving: fromUnits(s.receiving.v) };
  }

  stateFor(party: Party): StateEngine {
    return new StateEngine({
      client: this.client,
      store: new MemoryStore(),
      keys: party.keys,
      address: party.address,
      fromLedger: CT_DEPLOYMENT.deployedAtLedger,
    });
  }

  /**
   * Gizli ödeme. Zincire tutar yazılmıyor.
   *
   * Ödemeler sırayla yapılıyor: her transfer gönderenin harcanabilir notunu tüketip
   * yenisini yaratıyor, yani bir sonraki kanıt bir öncekinin sonucuna dayanıyor. Paralel
   * göndermek aynı notu iki kez harcamaya çalışmak olurdu.
   */
  async pay(
    from: Party,
    payments: { to: Party; amount: string }[],
  ): Promise<PaymentResult[]> {
    const kAud = await this.auditorKey();
    const state = this.stateFor(from);
    await state.sync();

    const results: PaymentResult[] = [];
    for (const { to, amount } of payments) {
      const started = Date.now();
      const current = await state.current();
      const w = buildTransferWitness({
        keys: from.keys,
        v: current.spendable.v,
        r: current.spendable.r,
        amount: toUnits(amount),
        pvkB: to.keys.PVK,
        kAudR: kAud,
        kAudS: kAud,
      });
      const { proof } = await this.#transferProver.prove(w.inputs);
      const r = await submitTransfer(this.client, from.signer, from.address, to.address, w, proof);
      await state.sync();
      results.push({
        to: to.address,
        label: to.label,
        amount,
        hash: r.hash,
        seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
      });
    }
    return results;
  }

  async close(): Promise<void> {
    await Promise.all([
      this.#registerProver.destroy(), this.#transferProver.destroy(), this.#withdrawProver.destroy(),
    ]);
  }
}
