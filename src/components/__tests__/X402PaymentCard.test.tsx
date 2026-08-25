/// <reference types="vitest/globals" />
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import '../../i18n.js';
import X402PaymentCard from '../X402PaymentCard';

/**
 * X402PaymentCard testleri
 *
 * Bu kart yalnızca AUTOMATIK (onay istemeyen) x402 ödemeleri için render edilir —
 * ConfirmationCard akışının bir parçası değildir, hiçbir onay/red butonu yoktur. Amaç: sadece
 * bilgilendirme — tutar, servis/kaynak, kalan bütçe, (varsa) işlem hash'i.
 */

const NETWORK = { network_id: 84532 }; // Base Sepolia — sayısal chainId ile karışmasın diye NetworkId enum değeri kullanılıyor

describe('X402PaymentCard', () => {
  it('kullanıcı dostu bir başlık gösterir — teknik/mekanik tool adı ASLA geçmez', () => {
    render(<X402PaymentCard resource="https://api.example.com/weather" amountUsd={0.01} remainingBudgetUsd={0.99} />);
    expect(screen.getByText('Automatic payment made')).toBeInTheDocument();
    expect(screen.queryByText(/pay_for_resource/)).not.toBeInTheDocument();
    expect(screen.queryByText(/autoPaid/)).not.toBeInTheDocument();
  });

  it('tutarı (USDC) gösterir', () => {
    render(<X402PaymentCard resource="https://api.example.com/weather" amountUsd={0.01} remainingBudgetUsd={0.99} />);
    expect(screen.getByText('0.01 USDC')).toBeInTheDocument();
  });

  it('servis/kaynak adını (resource) gösterir', () => {
    render(<X402PaymentCard resource="https://api.example.com/weather" amountUsd={0.01} remainingBudgetUsd={0.99} />);
    expect(screen.getByText('https://api.example.com/weather')).toBeInTheDocument();
  });

  it('kalan bütçeyi gösterir — "Kalan bakiye" (native/shielded) ile KARIŞTIRILMAZ, ayrı bir etikettir', () => {
    render(<X402PaymentCard resource="https://api.example.com/weather" amountUsd={0.01} remainingBudgetUsd={0.99} />);
    expect(screen.getByText('Remaining budget')).toBeInTheDocument();
    expect(screen.getByText('0.99 USDC')).toBeInTheDocument();
    expect(screen.queryByText('Remaining balance')).not.toBeInTheDocument();
  });

  it('txHash verilmemişse İşlem no satırı hiç render edilmez', () => {
    render(<X402PaymentCard resource="https://api.example.com/weather" amountUsd={0.01} remainingBudgetUsd={0.99} />);
    expect(screen.queryByText('Transaction')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('txHash verilmişse kısaltılmış gösterilir ve Etherscan\'e giden bir link olur', () => {
    render(
      <X402PaymentCard
        resource="https://api.example.com/weather"
        amountUsd={0.01}
        remainingBudgetUsd={0.99}
        txHash="0xSTUB1234567890abcdef1234567890abcdef1234567890abcdef1234567890"
        network={NETWORK}
      />
    );
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', expect.stringContaining('0xSTUB1234567890abcdef1234567890abcdef1234567890abcdef1234567890'));
    // Tam hash asla ham/uzun haliyle metin içinde görünmez — kısaltılmış olmalı.
    expect(screen.queryByText('0xSTUB1234567890abcdef1234567890abcdef1234567890abcdef1234567890')).not.toBeInTheDocument();
  });

  it('onay/red butonu yoktur — bu kart ConfirmationCard akışının bir parçası değildir', () => {
    render(<X402PaymentCard resource="https://api.example.com/weather" amountUsd={0.01} remainingBudgetUsd={0.99} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('tarih gösterir', () => {
    render(
      <X402PaymentCard
        resource="https://api.example.com/weather"
        amountUsd={0.01}
        remainingBudgetUsd={0.99}
        timestamp={new Date(2026, 7, 16, 14, 30).getTime()}
      />
    );
    expect(screen.getByText(/08\/16/)).toBeInTheDocument();
  });
});
