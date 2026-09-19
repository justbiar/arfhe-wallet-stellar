/// <reference types="vitest/globals" />
import * as React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router';
import i18n from '../../i18n.js';
import SettingsStellar from '../SettingsStellar';
import { WalletContext } from '../../AppContext';
import type { AppContext } from '../../AppContext';
import type Account from '../../backend/Account';

/**
 * SettingsStellar.test.tsx
 *
 * Bu ekran dört durumun hangisinde olduğunu söylemek zorunda: aktif hesap yok, kurtarma
 * ifadesi yok, hesap zincirde yok, ya da bakiyeler burada. Dördü de birbirinden farklı
 * şeyler ve hiçbiri "hata" değil.
 *
 * İlk test bir regresyonu tutuyor: hesap yokken effect erken dönüyordu ve `loading` hiç
 * kapanmıyordu — ekran sonsuza kadar dönen bir spinner gösteriyordu. Boş bir ekran,
 * cevabı olmayan bir sorudan daha kötüdür.
 */

const ADDRESS = 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6';

const getAddress = vi.fn();
const getBalances = vi.fn();
vi.mock('../../backend/StellarService.js', () => ({
  getAddress: (...a: unknown[]) => getAddress(...a),
  getBalances: (...a: unknown[]) => getBalances(...a),
}));

function contextWith(account: Account | undefined): AppContext {
  return {
    accountManager: { GetActive: () => account },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal mock
  } as any as AppContext;
}

const anAccount = { GetAddress: () => '0xabc', name: 'Hesap 1' } as unknown as Account;

function renderWith(account: Account | undefined) {
  return render(
    <MemoryRouter>
      <WalletContext.Provider value={contextWith(account)}>
        <SettingsStellar />
      </WalletContext.Provider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  getAddress.mockReset();
  getBalances.mockReset();
});

describe('SettingsStellar', () => {
  it('aktif hesap yokken sonsuza kadar dönmez, durumu söyler', async () => {
    renderWith(undefined);
    await waitFor(() => expect(screen.getByText(i18n.t('stellar.noAccount'))).toBeInTheDocument());
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(getAddress).not.toHaveBeenCalled();
  });

  it('kurtarma ifadesi olmayan hesapta nedenini açıklar', async () => {
    getAddress.mockResolvedValue(null);
    renderWith(anAccount);
    await waitFor(() => expect(screen.getByText(i18n.t('stellar.noMnemonic'))).toBeInTheDocument());
    // Türetilecek anahtar yoksa Horizon'a hiç gidilmez.
    expect(getBalances).not.toHaveBeenCalled();
  });

  it('fonlanmamış hesabı hata değil, durum olarak gösterir', async () => {
    getAddress.mockResolvedValue(ADDRESS);
    getBalances.mockResolvedValue({ exists: false, balances: [] });
    renderWith(anAccount);
    await waitFor(() => expect(screen.getByText(i18n.t('stellar.notFunded'))).toBeInTheDocument());
    expect(screen.getByText(ADDRESS)).toBeInTheDocument();
  });

  it('bakiyeleri adresle birlikte gösterir', async () => {
    getAddress.mockResolvedValue(ADDRESS);
    getBalances.mockResolvedValue({
      exists: true,
      balances: [
        { code: 'XLM', issuer: null, balance: '10000.0000000', isNative: true },
        { code: 'USDC', issuer: 'GBBD47IF', balance: '2.0396090', isNative: false },
      ],
    });
    renderWith(anAccount);
    await waitFor(() => expect(screen.getByText('10000.0000000')).toBeInTheDocument());
    expect(screen.getByText('USDC')).toBeInTheDocument();
    expect(screen.getByText('2.0396090')).toBeInTheDocument();
  });

  it('türetme patlarsa sessizce boş kalmaz', async () => {
    getAddress.mockRejectedValue(new Error('modül yüklenemedi'));
    renderWith(anAccount);
    await waitFor(() => expect(screen.queryByRole('progressbar')).not.toBeInTheDocument());
    // Mesaj toUserMessage'dan geçiyor; önemli olan ekranın bir şey söylemesi.
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});
