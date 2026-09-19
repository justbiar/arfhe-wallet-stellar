/// <reference types="vitest/globals" />
import * as React from 'react';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import i18n from '../../i18n.js';
import {
  Account as StellarAccount, Asset, BASE_FEE, Keypair, Networks, Operation, TransactionBuilder,
} from '@stellar/stellar-sdk';
import Approve from '../Approve';
import { WalletContext } from '../../AppContext';
import type { AppContext } from '../../AppContext';
import type Account from '../../backend/Account';

/**
 * Approve.stellar.test.tsx
 *
 * Bu ekran, bir sitenin imza isteğiyle kullanıcının kararı arasındaki tek durak. Buradaki
 * testler görünümü değil, o durağın tuttuğunu doğruluyor:
 *
 *   1. Ne imzalandığı ekranda yazıyor mu (özet, alıcı, ücret),
 *   2. Cüzdanın imzalamadığı bir ağ geldiğinde yüksek sesle reddediyor mu — ve
 *      imzalama fonksiyonuna hiç gitmiyor mu,
 *   3. Çözümlenemeyen bir operasyon uyarı olarak görünüyor mu.
 *
 * (2) en önemlisi: `TransactionBuilder.fromXDR` mainnet zarfını sorunsuz ayrıştırır, yani
 * testnet imzasıyla mainnet imzası arasındaki tek fark bu kontrolün varlığıdır.
 */

const SRC = 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6';
const DST = 'GBAW5XGWORWVFE2XTJYDTLDHXTY2Q2MO73HYCGB3XMFMQ562Q2W2GJQX';
const EVM_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const ORIGIN = 'https://anchor.example';
const SIGNED_XDR = 'SIGNED_ENVELOPE';

const signTransactionXdr = vi.fn(async () => SIGNED_XDR);
vi.mock('../../backend/StellarService.js', () => ({
  signTransactionXdr: (...args: unknown[]) => signTransactionXdr(...(args as [])),
}));

// Ağa çıkan oltalama kontrolü ve süsleme katmanı bu testin konusu değil.
vi.mock('../../backend/PhishingDetector.js', () => ({
  PhishingDetector: { checkDomain: vi.fn(async () => ({ riskLevel: 'SAFE', reasons: [] })) },
}));
vi.mock('../../components/HuntSurface.js', () => ({ default: () => null }));

function envelope(passphrase: string, op = Operation.payment({
  destination: DST, asset: Asset.native(), amount: '12.5',
})): string {
  return new TransactionBuilder(new StellarAccount(SRC, '1'), { fee: BASE_FEE, networkPassphrase: passphrase })
    .addOperation(op)
    .setTimeout(60)
    .build()
    .toXDR();
}

const canUseAccount = vi.fn(async () => true);

function makeContext(): AppContext {
  const account = { GetAddress: () => EVM_ADDRESS, name: 'Hesap 1' } as unknown as Account;
  return {
    storageManager: { isUnlocked: () => true, restoreSession: async () => true, getLocal: () => undefined },
    accountManager: { GetActive: () => account, accounts: [account], loadFromEncryptedStorage: async () => {}, SetActive: () => {} },
    networkProvider: { getActiveNetwork: () => ({ network_id: 'Sepolia', network_name: 'Sepolia', rpc_url: 'https://rpc.invalid', currency_symbol: 'ETH' }), listAllNetworks: () => [] },
    sitePermissions: { canUseAccount, get: async () => null, grant: async () => {} },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal mock for unit tests
  } as any as AppContext;
}

/** Park bir isteği, worker'ın yaptığı gibi. Approve onu doğrudan session'dan okur. */
function park(xdr: string, networkPassphrase: string) {
  const chromeApi = (globalThis as unknown as { chrome: typeof chrome }).chrome;
  return chromeApi.storage.session.set({
    arfhe_pending_approvals: [{
      id: 'req-1',
      method: 'stellar_signTransaction',
      params: [{ xdr, networkPassphrase }],
      origin: ORIGIN,
      createdAt: Date.now(),
    }],
  });
}

let sentMessages: Record<string, unknown>[] = [];

beforeEach(() => {
  sentMessages = [];
  signTransactionXdr.mockClear();
  canUseAccount.mockClear();
  const chromeApi = (globalThis as unknown as { chrome: { runtime: Record<string, unknown> } }).chrome;
  chromeApi.runtime.sendMessage = vi.fn((message: Record<string, unknown>, cb?: (r: unknown) => void) => {
    sentMessages.push(message);
    cb?.({ success: true, request: null });
  });
  window.close = vi.fn();
  window.location.hash = '#/approve';
});

async function renderApprove() {
  const view = render(
    <WalletContext.Provider value={makeContext()}>
      <Approve />
    </WalletContext.Provider>
  );
  // Parked isteğin okunması ve zarfın çözümlenmesi iki ayrı tur; ikisi de asenkron.
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return view;
}

/** Onay düğmesi — dil ayarından bağımsız olsun diye etiketi i18n'den alıyoruz. */
function confirmButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: i18n.t('approve.confirm') }) as HTMLButtonElement;
}

describe('Approve — Stellar imzalama', () => {
  it('testnet ödemesini çözer, ne imzalandığını gösterir ve onaylanınca imzalar', async () => {
    await park(envelope(Networks.TESTNET), Networks.TESTNET);
    await renderApprove();

    // SDK tutarı yedi ondalığa normalize eder; ekranda telde ne varsa o yazar.
    await waitFor(() => expect(screen.getByText(/12\.5000000 XLM/)).toBeInTheDocument());
    expect(screen.getByText(new RegExp(DST))).toBeInTheDocument();
    expect(screen.getByText(ORIGIN)).toBeInTheDocument();

    const confirm = confirmButton();
    expect(confirm).not.toBeDisabled();

    await act(async () => { fireEvent.click(confirm); });

    expect(signTransactionXdr).toHaveBeenCalledTimes(1);
    const result = sentMessages.find((m) => m.type === 'APPROVAL_RESULT');
    expect(result).toMatchObject({ requestId: 'req-1', origin: ORIGIN, result: SIGNED_XDR });
  });

  it('mainnet zarfını reddeder, imzalama yoluna hiç girmez', async () => {
    await park(envelope(Networks.PUBLIC), Networks.PUBLIC);
    await renderApprove();

    // Sebep ekranda yazıyor — "bir şeyler ters gitti" değil, hangi ağ olduğu.
    await waitFor(() => expect(screen.getByText(/desteklenmiyor/i)).toBeInTheDocument());
    expect(confirmButton()).toBeDisabled();

    // Çözümlenmemiş bir zarf gösterilmez: işlem ayrıntıları da ekranda olmamalı.
    expect(screen.queryByText(new RegExp(DST))).not.toBeInTheDocument();
    expect(signTransactionXdr).not.toHaveBeenCalled();
  });

  it('çözümlenemeyen operasyonu uyarı olarak gösterir, özet uydurmaz', async () => {
    const op = Operation.bumpSequence({ bumpTo: '120' });
    await park(envelope(Networks.TESTNET, op as ReturnType<typeof Operation.payment>), Networks.TESTNET);
    await renderApprove();

    await waitFor(() => expect(screen.getByText('bumpSequence')).toBeInTheDocument());
    expect(screen.getByText(i18n.t('approve.stellarUnknownOp'))).toBeInTheDocument();
    expect(screen.getByText(i18n.t('approve.stellarUnknownWarning', { n: 1 }))).toBeInTheDocument();

    // Uyarı imzayı engellemez — kullanıcı yine de karar verebilir; engellenen şey,
    // çözümlenemeyen bir zarfın olduğundan başka türlü görünmesi.
    expect(confirmButton()).not.toBeDisabled();
  });

  it('sitenin bağlı olmadığı bir hesapla imzalamaz', async () => {
    canUseAccount.mockResolvedValueOnce(false);
    await park(envelope(Networks.TESTNET), Networks.TESTNET);
    await renderApprove();

    await act(async () => { fireEvent.click(confirmButton()); });

    expect(signTransactionXdr).not.toHaveBeenCalled();
    expect(screen.getByText(/connected to a different account/i)).toBeInTheDocument();
    expect(Keypair.fromPublicKey(SRC).publicKey()).toBe(SRC); // zarf gerçek bir hesaba ait
  });
});
