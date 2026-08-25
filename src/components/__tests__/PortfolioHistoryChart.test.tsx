/// <reference types="vitest/globals" />
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import '../../i18n.js';
import PortfolioHistoryChart, { DailyChangeBadge } from '../PortfolioHistoryChart';

/**
 * Render tests for the three states the portfolio chart can be in.
 *
 * The component it replaced drew a confident line no matter what, because the data was
 * invented. This one has to survive having almost nothing to show, and each sparse state
 * has to *read* as sparse rather than as a broken chart:
 *
 *   nothing recorded → say the record has not started
 *   one measurement  → show that it is one, not a flat line
 *   several          → draw them
 *
 * The badge is here for the same reason: "no comparison yet" and "0.00%" look similar on
 * screen and mean opposite things.
 */

const HOUR = 3_600_000;

/** A series of measurements, oldest first, spaced an hour apart. */
function series(values: number[]) {
  const start = Date.UTC(2026, 7, 1, 12, 0, 0);
  return values.map((usd, i) => ({ t: start + i * HOUR, usd }));
}

describe('PortfolioHistoryChart', () => {
  const noop = () => {};

  it('hiç ölçüm yokken kaydın başlamadığını söyler', () => {
    render(<PortfolioHistoryChart points={[]} range="1W" onRangeChange={noop} />);

    // The empty state must explain itself; a blank box reads as a bug.
    expect(screen.getByText(/no history recorded yet/i)).toBeInTheDocument();
  });

  it('tek ölçümde çizgi çizmez, tek olduğunu söyler', () => {
    render(<PortfolioHistoryChart points={series([100])} range="1W" onRangeChange={noop} />);

    // Drawing through one point would imply a flat history nobody watched.
    expect(screen.getByText(/one measurement so far/i)).toBeInTheDocument();
  });

  it('birden fazla ölçümde grafiği ve sayısını gösterir', () => {
    render(<PortfolioHistoryChart points={series([100, 120, 90])} range="1W" onRangeChange={noop} />);

    // The count is the component's own statement of how much it actually knows.
    expect(screen.getByText(/3 measurements/i)).toBeInTheDocument();
    expect(screen.queryByText(/no history recorded yet/i)).not.toBeInTheDocument();
  });

  it('aralık düğmeleri her durumda seçilebilir', () => {
    const onRangeChange = vi.fn();
    render(<PortfolioHistoryChart points={series([100, 120])} range="1W" onRangeChange={onRangeChange} />);

    screen.getByRole('button', { name: '1D' }).click();
    expect(onRangeChange).toHaveBeenCalledWith('1D');
  });
});

describe('DailyChangeBadge', () => {
  it('temel yokken yüzde göstermez', () => {
    render(<DailyChangeBadge absolute={0} percent={0} hasBaseline={false} />);

    // The regression this guards: "0.00%" asserts the balance held steady over a day the
    // wallet never observed.
    expect(screen.getByText(/no 24h comparison yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/0\.00%/)).not.toBeInTheDocument();
  });

  it('artışı hem miktar hem yüzde olarak gösterir', () => {
    render(<DailyChangeBadge absolute={25.5} percent={12.75} hasBaseline />);

    // Neither figure answers the question alone.
    expect(screen.getByText(/\+\$25\.50/)).toBeInTheDocument();
    expect(screen.getByText(/12\.75%/)).toBeInTheDocument();
  });

  it('düşüşü eksi işaretiyle gösterir', () => {
    render(<DailyChangeBadge absolute={-40} percent={-8} hasBaseline />);

    expect(screen.getByText(/−\$40\.00/)).toBeInTheDocument();
    expect(screen.getByText(/8\.00%/)).toBeInTheDocument();
  });

  it('bakiye gizliyken rakam sızdırmaz', () => {
    render(<DailyChangeBadge absolute={1234.56} percent={50} hasBaseline hidden />);

    // Hiding the balance but leaking the day's move would give away the order of magnitude.
    expect(screen.queryByText(/1,?234/)).not.toBeInTheDocument();
    expect(screen.queryByText(/50\.00%/)).not.toBeInTheDocument();
  });
});
