/// <reference types="vitest/globals" />
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import '../../i18n.js';
import TransactionResultCard from '../TransactionResultCard';

/**
 * TransactionResultCard testleri
 *
 * Saf/gösterime dayalı bileşen — tüm veri (phase/txHash/errorMessage/newBalance) prop
 * olarak geliyor, hiçbir model/agent bağımlılığı yok. Üç durumun (pending/success/failed)
 * doğru render edildiğini, Explorer linkinin doğru URL'i ürettiğini ve gerçek olmayan hiçbir
 * bilginin (model metni) burada üretilmediğini doğrular.
 */

// network_id: 4 === NetworkId.Ethereum_Sepolia in this codebase's internal enum (see
// NetworkTypes.ts) — not the real chainId 11155111. Matches the mock used in ConfirmationCard.test.tsx.
const mockNetwork = { network_id: 4 };

describe('TransactionResultCard', () => {
  it('pending fazında spinner + bekleme metni + (varsa) Explorer linki gösterir', () => {
    render(<TransactionResultCard phase="pending" txHash="0xabc123" network={mockNetwork} />);

    expect(screen.getByText(/waiting for confirmation/i)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /view on explorer/i });
    expect(link).toHaveAttribute('href', 'https://sepolia.etherscan.io/tx/0xabc123');
  });

  it('txHash henüz yoksa pending fazında Explorer linki göstermez', () => {
    render(<TransactionResultCard phase="pending" network={mockNetwork} />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('success fazında "Confirmed" + Explorer linki + (varsa) yeni bakiye gösterir', () => {
    render(
      <TransactionResultCard
        phase="success"
        txHash="0xdef456"
        network={mockNetwork}
        newBalance={{ amount: '0.89', symbol: 'ETH' }}
      />
    );

    expect(screen.getByText('Confirmed')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /view on explorer/i })).toHaveAttribute(
      'href',
      'https://sepolia.etherscan.io/tx/0xdef456'
    );
    expect(screen.getByText('New balance: 0.89 ETH')).toBeInTheDocument();
  });

  it('success fazında newBalance yoksa bakiye satırı hiç render edilmez', () => {
    render(<TransactionResultCard phase="success" txHash="0xdef456" network={mockNetwork} />);
    expect(screen.queryByText(/new balance/i)).not.toBeInTheDocument();
  });

  it('failed fazında hata başlığı + mesajı + tekrar deneme önerisi gösterir', () => {
    render(<TransactionResultCard phase="failed" errorMessage="insufficient funds" />);

    expect(screen.getByText('Transaction failed')).toBeInTheDocument();
    expect(screen.getByText('insufficient funds')).toBeInTheDocument();
    expect(screen.getByText(/you can try again/i)).toBeInTheDocument();
  });

  it('failed fazında Explorer linki göstermez (network verilmese de)', () => {
    render(<TransactionResultCard phase="failed" errorMessage="boom" />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
