import { Mnemonic, HDNodeWallet, wordlists } from "ethers";
const words = wordlists.en;
// A throwaway mnemonic, generated here, used only for this measurement.
const full = Mnemonic.fromEntropy(crypto.getRandomValues(new Uint8Array(16))).phrase;
const parts = full.split(" ");
const target = HDNodeWallet.fromPhrase(full).address;

// The scenario: wallet holds words 1-6, site holds 7-10. Attacker has 10 of 12,
// positions labelled. Only words 11 and 12 are missing.
const known = parts.slice(0, 10);
console.log("hedef adres:", target);
console.log("bilinen: 10/12 kelime (cüzdan 6 + site 4), pozisyonlar etiketli");
console.log("aranan : son 2 kelime\n");

const list = [];
for (let i = 0; i < 2048; i++) list.push(words.getWord(i));

let tried = 0, valid = 0, found = null;
const t0 = Date.now();
outer:
for (const w11 of list) {
  for (const w12 of list) {
    tried++;
    const cand = [...known, w11, w12].join(" ");
    if (!Mnemonic.isValidMnemonic(cand)) continue;   // checksum filters 15/16
    valid++;
    if (HDNodeWallet.fromPhrase(cand).address === target) { found = cand; break outer; }
  }
}
const secs = (Date.now() - t0) / 1000;
console.log("denenen kombinasyon :", tried.toLocaleString());
console.log("sağlaması geçen     :", valid.toLocaleString());
console.log("SÜRE                :", secs.toFixed(1), "saniye (tek çekirdek, dizüstü)");
console.log("bulundu             :", found ? "EVET — tohum kırıldı" : "hayır");
