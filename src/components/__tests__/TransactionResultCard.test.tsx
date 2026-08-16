/// <reference types="vitest/globals" />
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import '../../i18n.js';
import TransactionResultCard, { shortenHex } from '../TransactionResultCard';

/**
 * TransactionResultCard testleri
 *
 * Saf/gösterime dayalı bir "dekont" bileşeni — tüm veri (phase/toolName/amount/recipient/
 * txHash/errorMessage/newBalance) prop olarak geliyor, hiçbir model/agent bağımlılığı yok.
 * Üç durumun (pending/success/failed) doğru render edildiğini, adres/hash'lerin her zaman
 * kısaltılmış gösterildiğini, Explorer linkinin doğru URL'i ürettiğini, ve "Tekrar dene"
 * butonunun sağlanan onRetry callback'ini tetiklediğini doğrular.
 */

// network_id: 4 === NetworkId.Ethereum_Sepolia in this codebase's internal enum (see
// NetworkTypes.ts) — not the real chainId 11155111. Matches the mock used in ConfirmationCard.test.tsx.
const mockNetwork = { network_id: 4 };
const RECIPIENT = '0x1234567890123456789012345678901234567890';

describe('shortenHex', () => {
  it('0x1234...5678 formatında kısaltır', () => {
    expect(shortenHex('0x1234567890123456789012345678901234567890')).toBe('0x1234...7890');
  });

  it('kısa değerleri olduğu gibi bırakır', () => {
    expect(shortenHex('0xabc')).toBe('0xabc');
  });
});

describe('TransactionResultCard', () => {
  it('pending fazında dönen bir gösterge, başlık, tarih ve tablo satırlarını gösterir', () => {
    render(
      <TransactionResultCard
        phase="pending"
        toolName="propose_send"
        amount="0.1"
        symbol="ETH"
        recipient={RECIPIENT}
        txHash="0xabc123abc123abc123"
        network={mockNetwork}
        pendingLabel="Waiting for signature..."
        timestamp={1700000000000}
      />
    );

    expect(screen.getByText('Transfer confirming...')).toBeInTheDocument();
    expect(screen.getByText('Waiting for signature...')).toBeInTheDocument();
    expect(screen.getByText('0.1 ETH')).toBeInTheDocument();
    // Alıcı adresi her zaman kısaltılmış gösterilir, ham hali değil.
    expect(screen.getByText(shortenHex(RECIPIENT))).toBeInTheDocument();
    expect(screen.queryByText(RECIPIENT)).not.toBeInTheDocument();

    const link = screen.getByRole('link', { name: /view on explorer/i });
    expect(link).toHaveAttribute('href', 'https://sepolia.etherscan.io/tx/0xabc123abc123abc123');
    expect(link).toHaveTextContent(shortenHex('0xabc123abc123abc123'));
  });

  it('txHash henüz yoksa pending fazında Explorer linki göstermez', () => {
    render(<TransactionResultCard phase="pending" toolName="propose_send" network={mockNetwork} />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('success fazında başlık + Explorer linki + kalan bakiye satırını gösterir', () => {
    render(
      <TransactionResultCard
        phase="success"
        toolName="propose_send"
        amount="0.1"
        symbol="ETH"
        recipient={RECIPIENT}
        txHash="0xdef456def456def456"
        network={mockNetwork}
        newBalance={{ amount: '0.89', symbol: 'ETH' }}
      />
    );

    expect(screen.getByText('Transfer successful')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /view on explorer/i })).toHaveAttribute(
      'href',
      'https://sepolia.etherscan.io/tx/0xdef456def456def456'
    );
    expect(screen.getByText('0.89 ETH')).toBeInTheDocument();
  });

  it('success fazında newBalance yoksa bakiye satırı hiç render edilmez', () => {
    render(<TransactionResultCard phase="success" toolName="propose_send" txHash="0xdef456" network={mockNetwork} />);
    expect(screen.queryByText(/remaining balance/i)).not.toBeInTheDocument();
  });

  it('shield/unshield başlıkları toolName\'e göre değişir', () => {
    const { rerender } = render(<TransactionResultCard phase="success" toolName="propose_shield" />);
    expect(screen.getByText('Shield successful')).toBeInTheDocument();

    rerender(<TransactionResultCard phase="success" toolName="propose_unshield" />);
    expect(screen.getByText('Unshield successful')).toBeInTheDocument();
  });

  it('failed fazında başlık + kullanıcı dostu hata mesajı gösterir, ham teknik metin göstermez', () => {
    render(<TransactionResultCard phase="failed" toolName="propose_send" errorMessage="Ağ ücreti için bakiyeniz yetersiz kaldı" />);

    expect(screen.getByText('Transfer failed')).toBeInTheDocument();
    expect(screen.getByText('Ağ ücreti için bakiyeniz yetersiz kaldı')).toBeInTheDocument();
    expect(screen.queryByText(/COMPLETED|FAILED|PROPOSE_SEND/)).not.toBeInTheDocument();
  });

  it('failed fazında Explorer linki göstermez (network verilmese de)', () => {
    render(<TransactionResultCard phase="failed" toolName="propose_send" errorMessage="boom" />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('failed fazında onRetry sağlanmazsa "Tekrar dene" butonu devre dışıdır', () => {
    render(<TransactionResultCard phase="failed" toolName="propose_send" errorMessage="boom" />);
    expect(screen.getByRole('button', { name: /try again/i })).toBeDisabled();
  });

  it('failed fazında "Tekrar dene" butonuna tıklamak onRetry\'ı tetikler', () => {
    const onRetry = vi.fn();
    render(<TransactionResultCard phase="failed" toolName="propose_send" errorMessage="boom" onRetry={onRetry} />);

    const retryButton = screen.getByRole('button', { name: /try again/i });
    expect(retryButton).toBeEnabled();
    fireEvent.click(retryButton);

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('adrese tıklamak panoya kopyalar (ham adres yerine kısaltılmış gösterim değişmez kalır)', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<TransactionResultCard phase="pending" toolName="propose_send" recipient={RECIPIENT} />);

    fireEvent.click(screen.getByText(shortenHex(RECIPIENT)));
    expect(writeText).toHaveBeenCalledWith(RECIPIENT);
  });
});
