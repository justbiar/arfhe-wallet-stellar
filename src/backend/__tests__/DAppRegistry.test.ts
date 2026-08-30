/// <reference types="vitest/globals" />
import {
  getDAppsByCategory,
  getFeaturedDApps,
  searchDApps,
  getDAppById,
  getDAppsForChain,
  DAPP_REGISTRY,
  DAPP_CATEGORIES,
} from '../DAppRegistry';
import type { DAppCategory } from '../DAppRegistry';

/**
 * DAppRegistry testleri
 *
 * Pure fonksiyonlar ve statik registry verileri test edilir.
 * Ağ bağımlılığı yoktur.
 */
describe('DAppRegistry', () => {

  // ─── DAPP_CATEGORIES ──────────────────────────────────────────
  describe('DAPP_CATEGORIES', () => {
    it('arfdao ve fhe kategorileri tanımlıdır', () => {
      expect(DAPP_CATEGORIES.length).toBe(2);
      expect(DAPP_CATEGORIES.map(c => c.id).sort()).toEqual(['arfdao', 'fhe']);
    });

    it('her kategorinin id, label, labelKey, icon, color alanı vardır', () => {
      for (const cat of DAPP_CATEGORIES) {
        expect(cat.id).toBeTruthy();
        expect(cat.label).toBeTruthy();
        expect(cat.labelKey).toBeTruthy();
        expect(cat.icon).toBeTruthy();
        expect(cat.color).toMatch(/^#[0-9a-fA-F]{6}$/);
      }
    });

    it('fhe kategorisi mevcuttur', () => {
      const fhe = DAPP_CATEGORIES.find(c => c.id === 'fhe');
      expect(fhe).toBeDefined();
      expect(fhe!.label).toBe('FHE Ecosystem');
    });
  });

  // ─── DAPP_REGISTRY ────────────────────────────────────────────
  describe('DAPP_REGISTRY', () => {
    it('yalnızca Fhenix ve ArfDAO kayıtlıdır', () => {
      // Kasıtlı olarak kısa bir liste: tek tek ArfDAO projeleri kaldırıldı, hepsi aynı
      // siteye giden showcase linkleriydi. Sayı büyürse bu test bilerek kırılsın.
      expect(DAPP_REGISTRY.map(d => d.id).sort()).toEqual(['arfdao', 'fhenix']);
    });

    it('her dApp\'ın gerekli alanları vardır', () => {
      for (const dapp of DAPP_REGISTRY) {
        expect(dapp.id).toBeTruthy();
        expect(dapp.name).toBeTruthy();
        expect(dapp.description).toBeTruthy();
        expect(dapp.url).toMatch(/^https:\/\//);
        expect(dapp.category).toBeTruthy();
        expect(Array.isArray(dapp.chains)).toBe(true);
        expect(Array.isArray(dapp.tags)).toBe(true);
      }
    });

    it('tüm dApp ID\'leri benzersizdir', () => {
      const ids = DAPP_REGISTRY.map(d => d.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });
  });

  // ─── getDAppsByCategory ────────────────────────────────────────
  describe('getDAppsByCategory', () => {
    it('arfdao kategorisindeki dApp\'ları getirir', () => {
      const arfdao = getDAppsByCategory('arfdao');
      expect(arfdao.length).toBeGreaterThan(0);
      arfdao.forEach(d => expect(d.category).toBe('arfdao'));
    });

    it('fhe kategorisindeki dApp\'ları getirir', () => {
      const fhe = getDAppsByCategory('fhe');
      expect(fhe.length).toBeGreaterThan(0);
      fhe.forEach(d => expect(d.category).toBe('fhe'));
    });

    it('var olmayan kategori boş dizi döner', () => {
      const result = getDAppsByCategory('nonexistent' as DAppCategory);
      expect(result).toHaveLength(0);
    });
  });

  // ─── getFeaturedDApps ──────────────────────────────────────────
  describe('getFeaturedDApps', () => {
    it('featured dApp\'lar döner', () => {
      const featured = getFeaturedDApps();
      expect(featured.length).toBeGreaterThan(0);
      featured.forEach(d => expect(d.featured).toBe(true));
    });

    it('Fhenix featured listesindedir', () => {
      const featured = getFeaturedDApps();
      const fhenix = featured.find(d => d.id === 'fhenix');
      expect(fhenix).toBeDefined();
    });
  });

  // ─── searchDApps ───────────────────────────────────────────────
  describe('searchDApps', () => {
    it('isimle arama yapar', () => {
      const results = searchDApps('Fhenix');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].name).toBe('Fhenix');
    });

    it('açıklama ile arama yapar', () => {
      const results = searchDApps('confidential');
      expect(results.length).toBeGreaterThan(0);
    });

    it('tag ile arama yapar', () => {
      const results = searchDApps('DAO');
      expect(results.length).toBeGreaterThan(0);
    });

    it('kategori ile arama yapar', () => {
      const results = searchDApps('arfdao');
      expect(results.length).toBeGreaterThan(0);
    });

    it('büyük/küçük harf duyarsız arama yapar', () => {
      const results = searchDApps('ARFDAO');
      expect(results.length).toBeGreaterThan(0);
    });

    it('boş sorgu tüm dApp\'ları döner', () => {
      const results = searchDApps('');
      expect(results.length).toBe(DAPP_REGISTRY.length);
    });

    it('eşleşme yoksa boş dizi döner', () => {
      const results = searchDApps('zzzznonexistent12345');
      expect(results).toHaveLength(0);
    });
  });

  // ─── getDAppById ───────────────────────────────────────────────
  describe('getDAppById', () => {
    it('fhenix ID ile dApp bulur', () => {
      const dapp = getDAppById('fhenix');
      expect(dapp).toBeDefined();
      expect(dapp!.name).toBe('Fhenix');
    });

    it('arfdao ID ile dApp bulur', () => {
      const dapp = getDAppById('arfdao');
      expect(dapp).toBeDefined();
      expect(dapp!.name).toBe('ArfDAO');
    });

    it('olmayan ID undefined döner', () => {
      const dapp = getDAppById('nonexistent-id');
      expect(dapp).toBeUndefined();
    });
  });

  // ─── getDAppsForChain ──────────────────────────────────────────
  describe('getDAppsForChain', () => {
    it('Sepolia (chainId=11155111) dApp\'larını getirir', () => {
      const results = getDAppsForChain(11155111);
      expect(results.length).toBeGreaterThan(0);
      expect(results.some(d => d.id === 'fhenix')).toBe(true);
    });

    it('chains boş olan dApp\'lar her zincirde görünür', () => {
      // Çoğu ArfDAO projesinin chains: [] olduğu için tüm zincirlerde gelmeli
      const results = getDAppsForChain(999999);
      const arfdao = results.find(d => d.id === 'arfdao');
      expect(arfdao).toBeDefined();
    });
  });
});
