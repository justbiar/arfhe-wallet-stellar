/// <reference types="vitest/globals" />

// PROJECT_ID modül seviyesinde bir const — import anında okunuyor. Bu yüzden env stub'ı
// beforeEach'te değil, import grafiği değerlendirilmeden ÖNCE kurulmalı; vi.hoisted tam
// olarak bunun için var. beforeEach'te yapılan stub hiç yetişmiyordu ve her test
// "WalletConnect yapılandırılmamış" ile düşüyordu.
vi.hoisted(() => {
  vi.stubEnv('VITE_WALLETCONNECT_PROJECT_ID', 'test-project-id');
});

import { WalletConnectService } from '../WalletConnectService';
import type AccountManager from '../AccountManager';

/**
 * @vitest-environment node
 *
 * WalletConnectService — init/pair yaşam döngüsü.
 *
 * Ağa çıkmaz: SignClient tamamen mock'lanır. Buradaki asıl konu, init() hâlâ devam ederken
 * gelen bir pair() çağrısının onu BEKLEMESİ — kullanıcı paneli açar açmaz QR okuttuğunda
 * yaşanan gerçek sıra bu.
 */

const initCalls: { resolve: (v: unknown) => void }[] = [];
const mockPair = vi.fn().mockResolvedValue(undefined);

vi.mock('@walletconnect/sign-client', () => ({
  SignClient: {
    init: vi.fn(
      () =>
        new Promise((resolve) => {
          initCalls.push({ resolve });
        })
    ),
  },
}));

vi.mock('../PhishingDetector', () => ({
  PhishingDetector: { checkDomain: vi.fn().mockResolvedValue({ isPhishing: false, riskLevel: 'SAFE' }) },
}));

type RelayHandler = (payload?: unknown) => void;

type MockClient = {
  on: ReturnType<typeof vi.fn>;
  pair: ReturnType<typeof vi.fn>;
  session: { length: number; values: unknown[] };
  pairing: { getAll: () => unknown[] };
  core: { relayer: { connected: boolean; on: (evt: string, cb: RelayHandler) => void } };
  /** Test hook: fire one of the relayer events the service subscribes to. */
  emitRelay: (evt: string, payload?: unknown) => void;
};

function makeClient(connected = true): MockClient {
  const handlers = new Map<string, RelayHandler>();
  return {
    on: vi.fn(),
    pair: mockPair,
    session: { length: 0, values: [] },
    pairing: { getAll: () => [] },
    core: {
      relayer: {
        connected,
        on: (evt: string, cb: RelayHandler) => { handlers.set(evt, cb); },
      },
    },
    emitRelay: (evt: string, payload?: unknown) => handlers.get(evt)?.(payload),
  };
}

describe('WalletConnectService — init/pair', () => {
  let service: WalletConnectService;

  beforeEach(() => {
    initCalls.length = 0;
    mockPair.mockClear();
    service = new WalletConnectService({} as unknown as AccountManager);
  });


  it('init() devam ederken gelen pair() bekler, "Client not initialized" atmaz', async () => {
    // WalletConnectManager'ın mount'ta yaptığı şey: await yok.
    const inFlight = service.init();

    // Kullanıcı SDK daha hazır değilken URI yapıştırıyor.
    const pairing = service.pair('wc:abc123@2?relay-protocol=irn&symKey=deadbeef');

    // Şimdi SDK hazır olsun.
    expect(initCalls).toHaveLength(1);
    initCalls[0].resolve(makeClient());

    await inFlight;
    await expect(pairing).resolves.toBeUndefined();
    expect(mockPair).toHaveBeenCalledWith({ uri: 'wc:abc123@2?relay-protocol=irn&symKey=deadbeef' });
  });

  it('eşzamanlı init() çağrıları tek bir SignClient.init üretir', async () => {
    const a = service.init();
    const b = service.init();
    const c = service.init();

    expect(initCalls).toHaveLength(1); // üç çağrı, tek kurulum
    initCalls[0].resolve(makeClient());
    await Promise.all([a, b, c]);
  });

  it('pair() asılı kalırsa timeout ile relay teşhisi döner', async () => {
    vi.useFakeTimers();
    try {
      const inFlight = service.init();
      // Relay bağlanmamış: SDK'nın pair()'i ne çözülüyor ne reddediliyor.
      const client = makeClient(false);
      client.pair = vi.fn(() => new Promise(() => {}));
      initCalls[0].resolve(client);
      await inFlight;

      const pairing = service.pair('wc:abc@2?relay-protocol=irn&symKey=dead');
      const assertion = expect(pairing).rejects.toThrow(/relay\.walletconnect\.org/i);
      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('relay hatası varsa timeout mesajı relay\'in kendi metnini taşır', async () => {
    vi.useFakeTimers();
    try {
      const inFlight = service.init();
      const client = makeClient(false);
      client.pair = vi.fn(() => new Promise(() => {}));
      initCalls[0].resolve(client);
      await inFlight;

      // SDK'nın pino'ya level:50 olarak yazdığı, konsolda okunamayan hata.
      client.emitRelay('relayer_error', new Error('WebSocket connection failed'));

      const pairing = service.pair('wc:abc@2?relay-protocol=irn&symKey=dead');
      const assertion = expect(pairing).rejects.toThrow('WebSocket connection failed');
      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('başarılı bağlantı eski relay hatasını temizler', async () => {
    const inFlight = service.init();
    const client = makeClient(false);
    initCalls[0].resolve(client);
    await inFlight;

    client.emitRelay('relayer_error', new Error('gecici kopma'));
    client.emitRelay('relayer_connect');

    // Eski hata yeni bir başarısızlığın sebebi gibi raporlanmamalı.
    const diagnosis = (service as unknown as { relayDiagnosis(): string }).relayDiagnosis();
    expect(diagnosis).not.toContain('gecici kopma');
  });

  it('origin reddi ağ hatası gibi değil, yapılandırma hatası gibi raporlanır', async () => {
    const inFlight = service.init();
    const client = makeClient(false);
    initCalls[0].resolve(client);
    await inFlight;

    client.emitRelay(
      'relayer_error',
      new Error('WebSocket connection closed abnormally with code: 3000 (Unauthorized: origin not allowed)')
    );

    const diagnosis = (service as unknown as { relayDiagnosis(): string }).relayDiagnosis();
    // Kullanıcıyı wifi'sini kontrol etmeye yönlendirmemeli.
    expect(diagnosis).toMatch(/Project ID/i);
    expect(diagnosis).toMatch(/chrome-extension:/);
    expect(diagnosis).not.toMatch(/ağ bağlantınızı/i);
  });

  it('başarısız init sonrası tekrar denenebilir — oturum boyunca kilitlenmez', async () => {
    const first = service.init();
    initCalls[0].resolve(Promise.reject(new Error('relay unreachable')));
    await expect(first).rejects.toThrow('relay unreachable');

    // İkinci deneme yeni bir kurulum başlatabilmeli.
    const second = service.init();
    expect(initCalls).toHaveLength(2);
    initCalls[1].resolve(makeClient());
    await expect(second).resolves.toBeUndefined();
  });
});
