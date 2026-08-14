import type { KnowledgeChunk } from "./types";

/**
 * Retrieval corpus for the agent's RAG context. Each chunk is a self-contained excerpt of
 * FHE_COMPLETE_GUIDE.md covering one durable, conceptual topic ("how/why does X work") —
 * the kind of thing a chat query maps onto directly. Deliberately excludes the guide's
 * version tables, chainId list, ABI selector table, file map, and deploy commands: those
 * are live/derived facts that go stale independently of this file and would produce
 * confidently-wrong answers if embedded as static prose. Must be kept in sync with
 * FHE_COMPLETE_GUIDE.md by hand — same convention buildSystemPrompt() already follows in
 * ../../../src/backend/AgentOrchestrator.ts.
 *
 * Editing this file requires regenerating embeddings — see scripts/embed-chunks.ts.
 */
export const KNOWLEDGE_CHUNKS: KnowledgeChunk[] = [
  {
    id: "mimari-ve-unshield",
    title: "Genel mimari ve unshield neden iki aşamalı",
    text:
      "CoFHE bir koprosesör mimarisidir. Şifreli veri zincirde tutulmaz; zincirde yalnızca " +
      "ctHash denen bir tutamaç (handle) bulunur. Gerçek şifreli metin ve FHE hesaplaması " +
      "zincir dışındaki CoFHE ağındadır. Üç temel işlem vardır: Shield (açık bakiyeden " +
      "şifreliye, tek işlem, miktar zaten açıkta olduğu için senkron), confidential transfer " +
      "(şifreliden şifreliye, tek işlem, miktar istemcide şifrelenir) ve unshield (şifreliden " +
      "açığa, iki işlem, şifre çözme zincir dışında olduğu için asenkron). " +
      "Unshield neden iki aşamalıdır: unshield çağrısı şifreli bakiyeyi yakar, " +
      "FHE.allowPublic ile yakılan tutamacı herkese açık çözülebilir hale getirir ve bir " +
      "claim (talep) kaydı açar; bu noktada tokenlar henüz serbest değildir. Zincir dışında " +
      "decryptForTx çağrısı decryptedValue ve Threshold Network imzası döndürür. Ardından " +
      "claimUnshielded çağrısı kontratta bu imzayı doğrular ve underlying tokenlar serbest " +
      "bırakılır. Kullanıcı ilk işlemi gönderip ikincisini göndermezse bakiyesi yanmış olur " +
      "ama tokenları kilitli kalır; bu yüzden hem Shield paneli hem Privacy sayfası bekleyen " +
      "talepleri listeler.",
  },
  {
    id: "kontrat-davranis-tuzaklari",
    title: "Akıllı kontratların iki davranışsal tuzağı",
    text:
      "Sıfır ile değiştirme (zero-replacement): Bakiyeden fazlasını göndermeye veya unshield " +
      "etmeye çalışmak revert etmez — şifreli sıfır işlenir. Bu, bakiye sızdırmamak için " +
      "kasıtlı bir tasarımdır; sonuç olarak işlem zincirde başarılı görünür ama hiçbir şey " +
      "taşınmamış olabilir. Bu yüzden Network.assertSufficientShieldedBalance her gizli " +
      "transfer ve unshield öncesinde bakiyeyi çözüp karşılaştırır; yetersiz bakiyeli " +
      "işlemler zincire hiç gönderilmeden reddedilir. Bu kontrol isteğe bağlı değildir — " +
      "kaldırılırsa kullanıcı fark etmeden sıfır gönderir. İkinci tuzak: operatör yetkisi " +
      "miktar bazlı değildir. setOperator çağrısı süre dolana kadar bakiyenin tamamına yetki " +
      "verir, belirli bir miktarla sınırlı değildir; bu yüzden kısa süreli ve yalnızca " +
      "güvenilen adreslere verilmelidir.",
  },
  {
    id: "permit-ve-servis-yasam-dongusu",
    title: "FheCofheService yaşam döngüsü, şifreleme, çözme ve permit",
    text:
      "FheCofheService bir singleton'dır. connect() çağrısı hiçbir imza istemez ve ağdan " +
      "anahtar çekmez; TFHE WASM ve FHE anahtarları ilk encryptInputs çağrısına kadar " +
      "ertelenir. İki farklı çözme modu vardır: decryptForView ekranda göstermek içindir, " +
      "permit zorunludur ve bigint döner; decryptForTx zincirde kanıtlamak içindir, genelde " +
      "permit gerekmez (withoutPermit) ve { decryptedValue, signature } döner. Bu ikisi " +
      "birbirinin yerine kullanılamaz — decryptForView çıktısının zincirde doğrulanabilir " +
      "imzası yoktur. Permit EIP-712 imzasıdır, varsayılan olarak 7 gün geçerlidir, " +
      "localStorage'da cofhesdk-permits anahtarı altında saklanır ve chainId + account " +
      "çiftiyle anahtarlanır. ensurePermit() yalnızca gerçekten gerektiğinde imza ister. " +
      "reset() bağlantıyı, istemciyi ve permit bayrağını düşürür ama permit'ler kasıtlı " +
      "olarak diskte bırakılır — her kilit açılışında yeniden imza istemek kullanıcı " +
      "deneyimini bozardı.",
  },
  {
    id: "gizli-varlik-kesfi-ve-tek-sarmalayici",
    title: "Gizli varlık keşfi neden zincirden okunur ve bir token = bir sarmalayıcı ilkesi",
    text:
      "getShieldedPortfolio cüzdanın tek gizli bakiye kaynağıdır; Ana Sayfa, Gönder ve " +
      "Kalkan ekranlarının üçü de onu kullanır. Keşif açık bakiyeden türetilemez, çünkü " +
      "kullanıcı bakiyesinin tamamını kalkanlarsa açık bakiyesi sıfır olur ve 'elindeki " +
      "tokenlardan' yola çıkan bir keşif tam da paranın orada olduğu anda o sarmalayıcıyı " +
      "gözden kaybeder. Sabit adres listesi de bayatlar: kontratlar yeniden dağıtıldığında " +
      "eski sarmalayıcılar listeden düşer. Bu yüzden keşif fabrika kaydından (" +
      "ArfheWrapperFactory) okunur. İkinci ilke: bir token için bir sarmalayıcı. Her " +
      "sarmalayıcı kendi teminat havuzunu tutar; aynı token için iki sarmalayıcı varsa " +
      "ikisi de aynı sembolle görünür ve kullanıcı ayırt edemez. Kanonik sarmalayıcı her " +
      "zaman factory.wrapperFor(underlying)'dir; shieldERC20, hedef sarmalayıcı kanonik " +
      "değilse işlemi reddeder. Aşılmış sarmalayıcılar keşifte kalır (isLegacy: true) — " +
      "bakiye görünür ve çıkarılabilir olmalı ama asla yeni kalkanlama hedefi olamaz.",
  },
  {
    id: "birim-sistemi-ondalik",
    title: "Şifreli katmanın ondalık hassasiyeti ve rate formülü",
    text:
      "Şifreli bakiye euint64 tipindedir; taşmayı önlemek için gizli katman en fazla 6 " +
      "ondalık basamak kullanır. rate = 10 ^ (underlyingDecimals - 6) formülüyle hesaplanır " +
      "— 18 ondalıklı ETH için rate 1e12'dir, 6 ondalıklı USDC için rate 1'dir. Shield " +
      "sırasında rate'in tam katı olmayan artık miktar kırpılır ve native wrapper'da iade " +
      "edilir; örneğin 1.5000005 ETH shield edilirse yalnızca 1.5 ETH kalkanlanır. Eski " +
      "WrappedETH_V4 mimarisindeki hata tam olarak buydu: 18 ondalıklı wei doğrudan " +
      "uint64'e sıkıştırılıyordu ve büyük miktarlarda taşma oluyordu; yeni wrapper'ın rate " +
      "normalizasyonu bu hata sınıfını tamamen ortadan kaldırır.",
  },
  {
    id: "sik-karsilasilan-hatalar",
    title: "Sık karşılaşılan hatalar ve sebepleri",
    text:
      "Ciphertext not found hatası, hesabın hiç shield yapmamış olması anlamına gelir; " +
      "normal bir durumdur ve arayüzde 0.0 gösterilir. Permit 403 veya 'Permit is expired' " +
      "hatası, permit'in 7 günlük süresinin dolduğu anlamına gelir; ensurePermit() yeniden " +
      "imza ister. InvalidSigner hatası, şifrelemenin farklı bir hesap veya ağ ile " +
      "yapıldığını gösterir. 'Insufficient shielded balance' hatası, bakiyeden fazla " +
      "göndermeye çalıştığınızda guard mekanizması tarafından engellendiğini gösterir. " +
      "'Amount is below the confidential precision limit' hatası, gönderilen miktarın bir " +
      "gizli birimden (rate() değerinden) küçük olduğu anlamına gelir. 'Decryption proof " +
      "failed verification' hatası, kanıtın zincir öncesi doğrulamayı geçemediğini gösterir " +
      "— claim işlemi tekrar denenebilir. Kalkanlanan bir ERC-20 cüzdanda görünmüyorsa " +
      "keşif mekanizması fabrika kaydını okumuyor olabilir. Aynı sembolden iki satır " +
      "görünüyorsa (örneğin iki aeUSDC), token için iki sarmalayıcı var demektir; kanonik " +
      "olan her zaman fabrikanınkidir.",
  },
];
