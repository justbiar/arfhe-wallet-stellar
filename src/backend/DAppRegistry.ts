/**
 * DAppRegistry.ts — Curated dApp Directory for ArfheWallet Explore page
 *
 * Scoped to the ArfheWallet ecosystem: community projects built by ArfDAO
 * (arfdao.dev) plus the Fhenix FHE network. No iframe injection — connections
 * go through WalletConnect v2.
 */

// ─── Types ──────────────────────────────────────────────────────────

export type DAppCategory = 'arfdao' | 'fhe';

export interface DApp {
    id: string;
    name: string;
    description: string;
    url: string;
    icon: string;
    category: DAppCategory;
    chains: number[];          // Supported chain IDs
    tags: string[];
    featured?: boolean;
    wcProjectId?: string;      // WalletConnect project ID for deep linking
    /** Informational link only (e.g. a project showcase page) — skip the WalletConnect prompt on click */
    infoOnly?: boolean;
}

export interface DAppCategoryInfo {
    id: DAppCategory;
    label: string;
    labelKey: string;          // i18n key
    icon: string;              // MUI icon name hint
    color: string;
}

// ─── Categories ─────────────────────────────────────────────────────

export const DAPP_CATEGORIES: DAppCategoryInfo[] = [
    { id: 'arfdao', label: 'ArfDAO',        labelKey: 'explore.catArfdao', icon: 'Groups', color: '#4338CA' },
    { id: 'fhe',    label: 'FHE Ecosystem', labelKey: 'explore.catFhe',    icon: 'Shield', color: '#10b981' },
];

// ─── Fallback Icon (no network dependency) ──────────────────────────

/** Deterministic letter-avatar SVG data URI — used when a dApp has no reliable hosted icon. */
export function letterAvatarIcon(letter: string, bg = '#4338CA'): string {
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'><rect width='64' height='64' fill='${bg}'/><text x='50%' y='54%' font-family='monospace' font-size='28' fill='#fff' text-anchor='middle' dominant-baseline='middle'>${letter.toUpperCase()}</text></svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// ─── Curated dApp Registry ─────────────────────────────────────────

const ARFDAO_BASE = 'https://www.arfdao.dev';

// ─── Icons ──────────────────────────────────────────────────────────
//
// Logos are bundled with the extension (public/images/dapps/) and referenced by an
// extension-local path, never fetched from the project's own site.
//
// Two reasons. A remote logo is a request to fhenix.io and arfdao.dev every time someone
// opens Explore, which tells those hosts that a wallet user is browsing — the same
// consideration DomainResolver's own docs raise about not publishing a user's decisions to
// third parties. And a hosted URL is somebody else's to change: the twenty project icons
// this list used to carry pointed at paths that still resolve, but every logo path the site
// advertises for the DAO itself now 404s.
//
// Explore's <img onError> still falls back to letterAvatarIcon, so a missing file degrades
// to a letter tile rather than a broken image.

export const DAPP_REGISTRY: DApp[] = [
    // ── FHE Ecosystem ──
    {
        id: 'fhenix',
        name: 'Fhenix',
        description: 'The FHE network powering confidential smart contracts on Ethereum',
        url: 'https://www.fhenix.io',
        icon: '/images/dapps/fhenix.png',
        category: 'fhe',
        // The chains CoFHE actually runs on — Fhenix's own L2 is not one of them.
        chains: [11155111, 421614, 84532],
        tags: ['fhe', 'confidential', 'evm'],
        featured: true,
        infoOnly: true,
    },

    // ── ArfDAO ──
    //
    // One entry for the DAO itself, not a row per project.
    //
    // This list used to carry all twenty community projects individually, each one an
    // `infoOnly` link to its own page on arfdao.dev. That is a directory of showcase pages,
    // not of things a wallet can connect to: none of them declared a chain, none accepted a
    // WalletConnect session, and every click led back to the same site. Twenty rows that all
    // do the same thing crowd out the one entry a user is actually looking for, and make the
    // Explore page read as filler.
    //
    // The projects are not lost — arfdao.dev lists them, kept current by the people who own
    // them, which a hardcoded copy in a shipped extension never can be.
    {
        id: 'arfdao',
        name: 'ArfDAO',
        description: 'The community behind ArfheWallet — projects, contributors and everything the DAO is building.',
        url: ARFDAO_BASE,
        icon: '/images/dapps/arfdao.png',
        category: 'arfdao',
        chains: [],
        tags: ['DAO', 'Community', 'Web3'],
        featured: true,
        infoOnly: true,
    },
];

// ─── Helper Functions ───────────────────────────────────────────────

export function getDAppsByCategory(category: DAppCategory): DApp[] {
    return DAPP_REGISTRY.filter(d => d.category === category);
}

export function getFeaturedDApps(): DApp[] {
    return DAPP_REGISTRY.filter(d => d.featured);
}

export function searchDApps(query: string): DApp[] {
    const q = query.toLowerCase().trim();
    if (!q) return DAPP_REGISTRY;
    return DAPP_REGISTRY.filter(d =>
        d.name.toLowerCase().includes(q) ||
        d.description.toLowerCase().includes(q) ||
        d.tags.some(t => t.includes(q)) ||
        d.category.includes(q)
    );
}

export function getDAppById(id: string): DApp | undefined {
    return DAPP_REGISTRY.find(d => d.id === id);
}

/** Filter dApps compatible with a given chain ID */
export function getDAppsForChain(chainId: number): DApp[] {
    return DAPP_REGISTRY.filter(d => d.chains.length === 0 || d.chains.includes(chainId));
}
