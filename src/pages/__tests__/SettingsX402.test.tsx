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

    expect(screen.getByRole('checkbox', { name: /enable x402 payments/i })).not.toBeChecked();
    expect(screen.getByLabelText('Per-payment cap')).toHaveValue(DEFAULT_X402_SETTINGS.perTransactionCapUsd);
    expect(screen.getByLabelText('Daily budget')).toHaveValue(DEFAULT_X402_SETTINGS.dailyBudgetCapUsd);
  });

  it('devre dışıyken tavan/bütçe alanları devre dışıdır', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByLabelText('Per-payment cap')).toBeDisabled());
    expect(screen.getByLabelText('Daily budget')).toBeDisabled();
  });

  it('etkinleştirince alanlar açılır ve servis üzerinden kaydedilir', async () => {
    renderPage();
    const toggle = await screen.findByRole('checkbox', { name: /enable x402 payments/i });
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

  it('mutlak sınırın üstünde bir değer girilirse blur\'da UI\'da da kırpılmış hâliyle görünür', async () => {
    await X402SettingsService.saveSettings({ ...DEFAULT_X402_SETTINGS, enabled: true });
    renderPage();

    const capInput = await screen.findByLabelText('Per-payment cap');
    fireEvent.change(capInput, { target: { value: String(X402_ABSOLUTE_CAPS.maxPerTransactionUsd + 50) } });
    fireEvent.blur(capInput);

    await waitFor(() => expect(capInput).toHaveValue(X402_ABSOLUTE_CAPS.maxPerTransactionUsd));
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
