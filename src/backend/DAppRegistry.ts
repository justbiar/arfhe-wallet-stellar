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
    /** If true, this dApp can be opened in a whitelisted iframe with postMessage proxy */
    whitelisted?: boolean;
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

export const DAPP_REGISTRY: DApp[] = [
    // ── FHE Ecosystem ──
    {
        id: 'fhenix',
        name: 'Fhenix',
        description: 'The FHE network powering confidential smart contracts on Ethereum',
        url: 'https://www.fhenix.io',
        icon: letterAvatarIcon('F', '#10b981'),
        category: 'fhe',
        // The chains CoFHE actually runs on — Fhenix's own L2 is not one of them.
        chains: [11155111, 421614, 84532],
        tags: ['fhe', 'confidential', 'evm'],
        featured: true,
        infoOnly: true,
    },

    // ── ArfDAO Community Projects ──
    {
        id: 'veriarfy',
        name: 'VeriArfy',
        description: 'A secure, blockchain-based national data repository where biological data (DNA, health records) is stored with 100% privacy, but can be actively used for research.',
        url: `${ARFDAO_BASE}/project.html?p=veriarfy`,
        icon: `${ARFDAO_BASE}/assets/img/veriarfy.jpg`,
        category: 'arfdao',
        chains: [],
        tags: ['DeSci', 'Privacy', 'Web3', 'Encryption'],
        featured: true,
        infoOnly: true,
    },
    {
        id: 'degenslide',
        name: 'DegenSlide',
        description: 'An app that makes it easy to copy the trades of whales in the crypto market with a Tinder-style interface.',
        url: `${ARFDAO_BASE}/project.html?p=degenslide`,
        icon: `${ARFDAO_BASE}/assets/img/degen.jpg`,
        category: 'arfdao',
        chains: [],
        tags: ['DeFi', 'Copy Trading', 'UX', 'Fintech'],
        infoOnly: true,
    },
    {
        id: 'bilboard-dapp',
        name: 'Bilboard dApp',
        description: 'A decentralized application providing dynamic ad broadcasting based on instant crowd traffic.',
        url: `${ARFDAO_BASE}/project.html?p=bilboard-dapp`,
        icon: `${ARFDAO_BASE}/assets/img/bilboard.jpg`,
        category: 'arfdao',
        chains: [],
        tags: ['dApp', 'AdTech', 'IoT', 'Smart City'],
        infoOnly: true,
    },
    {
        id: 'deleak',
        name: 'DeLeak',
        description: 'Autonomous white-hat security agent: detects leaked private keys on GitHub, checks the wallet, and automatically transfers any balance to a secure address via the Monad Testnet.',
        url: `${ARFDAO_BASE}/project.html?p=deleak`,
        icon: `${ARFDAO_BASE}/assets/img/deleak.jpg`,
        category: 'arfdao',
        chains: [],
        tags: ['Cybersecurity', 'Bot', 'MEV', 'Wallet Recovery'],
        featured: true,
        infoOnly: true,
    },
    {
        id: 'white-grave',
        name: 'White Grave',
        description: 'An atmospheric zombie-themed escape game blending suspense and survival elements.',
        url: `${ARFDAO_BASE}/project.html?p=white-grave`,
        icon: `${ARFDAO_BASE}/assets/img/white.jpg`,
        category: 'arfdao',
        chains: [],
        tags: ['Unity', 'Game Design', 'Horror', 'Survival'],
        infoOnly: true,
    },
    {
        id: 'mustech',
        name: 'Smart Farming Automation',
        description: 'An agricultural technology startup combining traditional farming with IoT and AI, enabling data-driven decisions.',
        url: `${ARFDAO_BASE}/project.html?p=mustech`,
        icon: `${ARFDAO_BASE}/assets/img/tarım.jpg`,
        category: 'arfdao',
        chains: [],
        tags: ['IoT', 'AgriTech', 'AI'],
        infoOnly: true,
    },
    {
        id: 'vibe',
        name: 'VibeCoding with Education',
        description: 'A universal, zero-config rule system that turns your AI Assistant into a contextual teacher while you vibe code.',
        url: `${ARFDAO_BASE}/project.html?p=vibe`,
        icon: `${ARFDAO_BASE}/assets/img/vibe.jpg`,
        category: 'arfdao',
        chains: [],
        tags: ['AI', 'Education', 'Tooling'],
        infoOnly: true,
    },
    {
        id: 'agiad',
        name: 'ConcreteWeb',
        description: 'An autonomous LoRa mesh communication system requiring no infrastructure that detects signs of life under rubble and relays locations to rescue teams after an earthquake.',
        url: `${ARFDAO_BASE}/project.html?p=agiad`,
        icon: `${ARFDAO_BASE}/assets/img/deprem.jpg`,
        category: 'arfdao',
        chains: [],
        tags: ['LoRa', 'Mesh Network', 'Disaster Relief'],
        infoOnly: true,
    },
    {
        id: 'promptstore',
        name: 'PromptStore',
        description: 'A virtual marketplace platform where professional AI prompts can be bought and sold.',
        url: `${ARFDAO_BASE}/project.html?p=promptstore`,
        icon: `${ARFDAO_BASE}/assets/img/prompt.jpg`,
        category: 'arfdao',
        chains: [],
        tags: ['AI', 'Marketplace', 'Prompt Engineering', 'SaaS'],
        infoOnly: true,
    },
    {
        id: 'suiholar',
        name: 'SuiHolar',
        description: 'A decentralized research and academic funding (DeSci) platform running on the Sui network.',
        url: `${ARFDAO_BASE}/project.html?p=suiholar`,
        icon: `${ARFDAO_BASE}/assets/img/suiholar.png`,
        category: 'arfdao',
        chains: [],
        tags: ['Sui', 'DeSci', 'Crowdfunding', 'DAO'],
        infoOnly: true,
    },
    {
        id: 'a2saga',
        name: 'A2 Saga',
        description: 'An action-packed 1v1 online competitive arena game inspired by Turkish mythology.',
        url: `${ARFDAO_BASE}/project.html?p=a2saga`,
        icon: `${ARFDAO_BASE}/assets/img/a2.jpg`,
        category: 'arfdao',
        chains: [],
        tags: ['Esports', 'Mythology', 'Action', 'PvP'],
        featured: true,
        infoOnly: true,
    },
    {
        id: 'agentsync',
        name: 'AgentSync',
        description: 'A tool that resolves conflicts in collaboration processes between humans and AI agents.',
        url: `${ARFDAO_BASE}/project.html?p=agentsync`,
        icon: `${ARFDAO_BASE}/assets/img/agent.jpg`,
        category: 'arfdao',
        chains: [],
        tags: ['SaaS', 'AI', 'Orchestration', 'Collaboration'],
        infoOnly: true,
    },
    {
        id: 'evolu-a',
        name: 'Evolu-A',
        description: 'A fully autonomous AI agent running on the Sepolia network, managing its own wallet.',
        url: `${ARFDAO_BASE}/project.html?p=evolu-a`,
        icon: `${ARFDAO_BASE}/assets/img/evolu.png`,
        category: 'arfdao',
        chains: [11155111],
        tags: ['Autonomous Agent', 'LLM', 'Web3', 'Sepolia'],
        infoOnly: true,
    },
    {
        id: 'blockucracy',
        name: 'Blockucracy',
        description: 'A next-generation "Governance by Code" system overseen by AI agents leveraging the Monad network\'s speed.',
        url: `${ARFDAO_BASE}/project.html?p=blockucracy`,
        icon: `${ARFDAO_BASE}/assets/img/blockucracy.png`,
        category: 'arfdao',
        chains: [],
        tags: ['Monad', 'DAO', 'Governance', 'DeFi'],
        infoOnly: true,
    },
    {
        id: 'kuantum-qrng',
        name: 'Kuantum QRNG SDK',
        description: 'An SDK providing hardware-based, unmanipulable True Quantum Randomness (QRNG) for blockchain projects.',
        url: `${ARFDAO_BASE}/project.html?p=kuantum-qrng`,
        icon: `${ARFDAO_BASE}/assets/img/kuantum.jpg`,
        category: 'arfdao',
        chains: [],
        tags: ['Quantum', 'RNG', 'SDK', 'Security'],
        infoOnly: true,
    },
    {
        id: 'wheatherwise',
        name: 'Wheatherwise',
        description: 'An application delivering hyper-local instant weather forecasts powered by machine learning.',
        url: `${ARFDAO_BASE}/project.html?p=wheatherwise`,
        icon: `${ARFDAO_BASE}/assets/img/weatherwise.png`,
        category: 'arfdao',
        chains: [],
        tags: ['AI', 'Machine Learning', 'SaaS', 'Meteorology'],
        infoOnly: true,
    },
    {
        id: 'whisperdao',
        name: 'WhisperDAO',
        description: 'A fully confidential DAO platform built on the Solana network using MagicBlock TEE and Gemini AI.',
        url: `${ARFDAO_BASE}/project.html?p=whisperdao`,
        icon: `${ARFDAO_BASE}/assets/img/whisperdao.png`,
        category: 'arfdao',
        chains: [],
        tags: ['Solana', 'Privacy', 'TEE', 'Gemini'],
        infoOnly: true,
    },
    {
        id: 'sunergy',
        name: 'Sunergy',
        description: 'A DePIN protocol rewarding solar energy producers on the Monad network based on their actual generation.',
        url: `${ARFDAO_BASE}/project.html?p=sunergy`,
        icon: `${ARFDAO_BASE}/assets/img/sunergy.png`,
        category: 'arfdao',
        chains: [],
        tags: ['Monad', 'DePIN', 'Green Energy', 'Tokenization'],
        infoOnly: true,
    },
    {
        id: 'obscura-finance',
        name: 'Obscura Finance',
        description: 'A DeFi platform offering privacy-centric, undercollateralized loans using Zero-Knowledge proofs.',
        url: `${ARFDAO_BASE}/project.html?p=obscura-finance`,
        icon: `${ARFDAO_BASE}/assets/img/obscura.png`,
        category: 'arfdao',
        chains: [],
        tags: ['DeFi', 'Zero-Knowledge', 'Lending', 'Capital Efficiency'],
        featured: true,
        infoOnly: true,
    },
    {
        id: 'monadoly-arena',
        name: 'Monadoly Arena',
        description: 'An on-chain arena on the Monad network where AI agents clash in strategy games for token rewards.',
        url: `${ARFDAO_BASE}/project.html?p=monadoly-arena`,
        icon: `${ARFDAO_BASE}/assets/img/monadoly.png`,
        category: 'arfdao',
        chains: [],
        tags: ['Monad', 'Autonomous Gaming', 'Strategy', 'AI'],
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
