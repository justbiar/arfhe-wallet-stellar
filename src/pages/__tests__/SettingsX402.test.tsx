/// <reference types="vitest/globals" />
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router';
import '../../i18n.js';
import SettingsX402 from '../SettingsX402';
import { X402SettingsService, DEFAULT_X402_SETTINGS } from '../../backend/X402SettingsService';
import { X402_ABSOLUTE_CAPS } from '../../backend/AgentPolicyEngine';

/**
 * SettingsX402 testleri
 *
 * X402SettingsService gerçek (chrome.storage mock'u setup.ts'den geliyor, her testten önce
 * temizleniyor) — bu bir entegrasyon testi: sayfanın gerçekten servis üzerinden okuyup
 * yazdığını, ve clamp'in UI'da da yansıdığını doğrular.
 */

function renderPage() {
  return render(
    <MemoryRouter>
      <SettingsX402 />
    </MemoryRouter>
  );
}

describe('SettingsX402', () => {
  beforeEach(async () => {
    await chrome.storage.local.clear();
  });

  it('varsayılan ayarları yükler: kapalı, konservatif tavan/bütçe gösterir', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByLabelText('Per-payment cap')).toBeInTheDocument());

    expect(screen.getByRole('switch', { name: /enable x402 payments/i })).not.toBeChecked();
    expect(screen.getByLabelText('Per-payment cap')).toHaveValue(String(DEFAULT_X402_SETTINGS.perTransactionCapUsd));
    expect(screen.getByLabelText('Daily budget')).toHaveValue(String(DEFAULT_X402_SETTINGS.dailyBudgetCapUsd));
  });

  it('devre dışıyken tavan/bütçe alanları devre dışıdır', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByLabelText('Per-payment cap')).toBeDisabled());
    expect(screen.getByLabelText('Daily budget')).toBeDisabled();
  });

  it('etkinleştirince alanlar açılır ve servis üzerinden kaydedilir', async () => {
    renderPage();
    const toggle = await screen.findByRole('switch', { name: /enable x402 payments/i });
    fireEvent.click(toggle);

    await waitFor(async () => {
      const saved = await X402SettingsService.getSettings();
      expect(saved.enabled).toBe(true);
    });
    expect(screen.getByLabelText('Per-payment cap')).toBeEnabled();
  });

  it('tavan alanına yazıp blur olunca değer servis üzerinden kaydedilir', async () => {
    await X402SettingsService.saveSettings({ ...DEFAULT_X402_SETTINGS, enabled: true });
    renderPage();

    const capInput = await screen.findByLabelText('Per-payment cap');
    fireEvent.change(capInput, { target: { value: '0.35' } });
    fireEvent.blur(capInput);

    await waitFor(async () => {
      const saved = await X402SettingsService.getSettings();
      expect(saved.perTransactionCapUsd).toBe(0.35);
    });
  });

  it(
    'aynı alana art arda iki commit yapılıp ilki (eski) İKİNCİDEN (yeni) SONRA çözülürse, ' +
      'input geriye/eski değere dönmez — persist() istekleri sıralı değil, ama sonuç yine de ' +
      'en güncel commit\'i yansıtmalı (görülen bug: bir alana yazılan değer, daha önce başlamış ' +
      'ama geç çözülen bir kaydın üzerine yazmasıyla sessizce eski bir değere dönüyordu)',
    async () => {
      await X402SettingsService.saveSettings({ ...DEFAULT_X402_SETTINGS, enabled: true });
      renderPage();
      const capInput = await screen.findByLabelText('Per-payment cap');

      let resolveFirst!: (value: typeof DEFAULT_X402_SETTINGS) => void;
      const firstCommitPromise = new Promise<typeof DEFAULT_X402_SETTINGS>((resolve) => {
        resolveFirst = resolve;
      });
      const spy = vi
        .spyOn(X402SettingsService, 'saveSettings')
        // 1. commit (0.05) — bilerek askıda bırakılıyor, hemen çözülmüyor.
        .mockImplementationOnce(() => firstCommitPromise)
        // 2. commit (0.08) — normal şekilde hemen çözülür.
        .mockImplementationOnce(async (s) => s);

      fireEvent.change(capInput, { target: { value: '0.05' } });
      fireEvent.blur(capInput); // persist #1 tetiklendi, askıda kaldı

      fireEvent.change(capInput, { target: { value: '0.08' } });
      fireEvent.blur(capInput); // persist #2 tetiklendi VE hemen çözüldü

      await waitFor(() => expect(capInput).toHaveValue('0.08'));

      // Şimdi #1 (eski, geç kalan) çözülüyor — guard olmasaydı bu, input'u yanlışlıkla
      // kullanıcının çoktan değiştirdiği "0.08"in üzerine "0.05"e geri döndürürdü.
      resolveFirst({ enabled: true, perTransactionCapUsd: 0.05, dailyBudgetCapUsd: DEFAULT_X402_SETTINGS.dailyBudgetCapUsd });
      await new Promise((r) => setTimeout(r, 0));

      expect(capInput).toHaveValue('0.08');
      spy.mockRestore();
    }
  );

  it(
    'sayısal olmayan bir karakter (ör. harf) input\'a state\'e hiç yansımaz — ' +
      'type="text"\'e geçildiği için (native type="number"\'ın filtrelemesi artık yok) ' +
      'bu artık DECIMAL_INPUT_PATTERN\'in kendi işi',
    async () => {
      await X402SettingsService.saveSettings({ ...DEFAULT_X402_SETTINGS, enabled: true });
      renderPage();

      const capInput = await screen.findByLabelText('Per-payment cap');
      fireEvent.change(capInput, { target: { value: '0.5' } });
      expect(capInput).toHaveValue('0.5');

      fireEvent.change(capInput, { target: { value: '0.5abc' } });
      // Geçersiz karakter içeren değer reddedildi, alan bir önceki geçerli değerinde kaldı.
      expect(capInput).toHaveValue('0.5');
    }
  );

  it('mutlak sınırın üstünde bir değer girilirse blur\'da UI\'da da kırpılmış hâliyle görünür', async () => {
    await X402SettingsService.saveSettings({ ...DEFAULT_X402_SETTINGS, enabled: true });
    renderPage();

    const capInput = await screen.findByLabelText('Per-payment cap');
    fireEvent.change(capInput, { target: { value: String(X402_ABSOLUTE_CAPS.maxPerTransactionUsd + 50) } });
    fireEvent.blur(capInput);

    await waitFor(() => expect(capInput).toHaveValue(String(X402_ABSOLUTE_CAPS.maxPerTransactionUsd)));
  });

  it('mutlak sınırları içeren bir bilgilendirme metni gösterir', async () => {
    renderPage();
    await waitFor(() =>
      expect(
        screen.getByText(new RegExp(`\\$${X402_ABSOLUTE_CAPS.maxPerTransactionUsd.toFixed(2)}`))
      ).toBeInTheDocument()
    );
  });
});
