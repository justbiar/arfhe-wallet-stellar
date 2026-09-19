# Relayer

Bir gizlilik havuzu transferini, notların sahibi yerine **başkasının** göndermesi için.

## Neden

Stellar'da işlemin kaynağı ücreti öder ve açıktır. SPP transferinde tutar ve alıcı gizli,
ama kullanıcı işlemi kendi gönderirse **gönderen görünür** — gizliliğin yarısı orada
kaybolur.

Havuzun `transact` fonksiyonu bir `sender` adresi alıyor, ona `require_auth()` çağırıyor ve
sonra **yalnızca token çekilirken** kullanıyor; bu da sadece depozitoda oluyor. Yani
transfer ve çekimde `sender` herhangi biri olabilir. Bu servis o "herhangi biri".

Ölçülmüş (bkz. `stellar.md` §5.9): relayer'ın gönderdiği transferde zincirde yalnızca
relayer'ın adresi görünüyor, notların sahibi hiçbir yerde geçmiyor.

## Neyi reddeder

| Durum | Sebep |
|---|---|
| `ext_amount > 0` (depozito) | Havuz token'ı **`sender`'dan** çeker — yani relayer'dan. Başkasının yatırımını bizim cebimizden ödemek olurdu. Üstelik depozito zaten açık; satın alınacak gizlilik yok. |
| Listede olmayan havuz | Bilinmeyen bir kontrat her şeyi yapabilir, relayer'ın bakiyesini harcamak dahil. |
| Bozuk / aşırı büyük argüman | Çöp ayrıştırmaya zorlanmamak için. |
| Eksik alanlı `extData` | Beklenen şekilde değilse ne olduğu bilinmiyor demektir. |
| Simülasyonu geçmeyen yük | Harcanmış nullifier, bayat kök, tutmayan kanıt. 422 döner, 500 değil. |
| Tavanı aşan ücret | `MAX_FEE_STROOPS`. Ölçülen transfer ~180.000 stroop; tavan bir mertebe üstünde. |

## Neyi çalamaz

`ext_data_hash` — kanıtın açık girdisi — havuzu, token'ı, alıcıyı, tutarı ve iki şifreli
çıktıyı bağlıyor. `sender` bu hash'in **içinde değil**. Bu yüzden relayer kendini `sender`
yazabilir ama alıcıyı ya da tutarı değiştiremez: değiştirirse kanıt tutmaz.

**Relayer sansürleyebilir ve geciktirebilir. Çalamaz, yönlendiremez.**

## Ne görür

Transferde tutarı ve alıcıyı **görmez** (hepsi taahhüt ya da şifreli). Çekimde `recipient`
zaten zincirde açık. Her hâlükârda IP ve zamanlama görür — servisin kaçınılmaz bedeli.

Bu yüzden **yük içeriği hiç loglanmıyor.** Görmediği şeyleri hatırlamayan bir servis,
görebileceği her şeyi yazan bir servisten farklıdır.

## Çalıştırma

```bash
RELAYER_SECRET=S...  RELAYER_POOLS=CCM5G4...  npm run relayer
```

| Değişken | Varsayılan |
|---|---|
| `RELAYER_SECRET` | — (zorunlu) |
| `RELAYER_POOLS` | — (zorunlu, virgülle ayrık) |
| `PORT` | 8787 |
| `RELAYER_RATE_LIMIT` | dakikada 10 / kaynak |

```
GET  /health  → {ok, publicKey, pools}
POST /relay   {pool, proof, extData}  →  {hash, kind, fee, status}
```

`proof` ve `extData`, `transact` çağrısının ilk iki argümanının base64 XDR ScVal hali.

## Kötüye kullanım

Ücreti relayer ödüyor. Doğal sınır: bize ücret ödetmek için havuzda **gerçek not** sahibi
olmak gerekiyor ve her not bir kez harcanıyor (nullifier). Sınırsız spam sınırsız mevduat
ister. Hız sınırı bunun üstüne kaba bir ikinci katman — IP başına, yani tek başına ciddi
bir savunma değil.

## Eksik: protokol içi ödeme

Doğrusu, ücretin gölgeli işlemin **içinden** relayer'a ödenmesi olurdu (Tornado böyle
yapıyordu). SPP'nin `ExtData`'sında `fee` alanı **yok**, yani bugün protokol içi ödeme yolu
bulunmuyor. Kullanıcının açık adresinden relayer'a ödeme yapması ise az önce sildiğimiz
bağı geri koyar — amaca özel olduğu için sıradan bir transferden daha tanımlayıcıdır.

O yüzden şimdilik ücreti **biz** ödüyoruz, ve `fee` alanı upstream'e sorulacak.

## `fixtures-transfer.json`

Gerçek `spp` CLI'ın testnet için ürettiği bir transfer yükü — uydurma değil, ve
**harcanmış** (tekrar gönderilirse nullifier hatası verir). Testlerde ayrıştırıcının
gerçek istemcinin çıktısıyla eşleştiğini kanıtlamak için duruyor.
