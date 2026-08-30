import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import wasmPlugin from '@rollup/plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { loadEnv } from 'vite';
import { auditEnv, auditBundle, formatFailure } from './scripts/secret-guard.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * The extension version, read from the manifest at build time.
 *
 * The About line used to ask `chrome.runtime.getManifest()` for this, which meant it
 * reported whatever manifest Chrome currently had loaded — a stale one after a rebuild
 * that had not been reloaded — and read "dev" in the browser dev server. Baking it in
 * makes the number belong to the build, so it cannot disagree with what shipped.
 */
const APP_VERSION = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, 'extension/manifest.json'), 'utf8')
).version;

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  plugins: [
    /**
     * Refuse to build a bundle that carries a real secret.
     *
     * Everything Vite inlines is plain text in a folder the user downloads, so the `VITE_`
     * prefix is the only thing standing between `.env` and the public — and it is a naming
     * convention, not a wall. This checks both sides of it: the environment before the
     * build, and the artifact after, since a key pasted straight into a source file never
     * passes through `.env` at all.
     */
    {
      name: 'arfhe-secret-guard',
      apply: 'build',
      configResolved(config) {
        const env = loadEnv(config.mode, process.cwd(), '');
        const problems = auditEnv(env);
        if (problems.length > 0) {
          throw new Error(formatFailure(problems, 'before building'));
        }
      },
      closeBundle() {
        const env = loadEnv(process.env.NODE_ENV === 'production' ? 'production' : 'development', process.cwd(), '');
        const problems = auditBundle(path.resolve(__dirname, 'dist'), env);
        if (problems.length > 0) {
          throw new Error(formatFailure(problems, 'on the built bundle'));
        }
      },
    },
    react(),
    // Serve tfhe WASM file with correct MIME type from node_modules
    {
      name: 'serve-tfhe-wasm',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url && req.url.endsWith('tfhe_bg.wasm')) {
            const wasmPath = path.resolve(__dirname, 'node_modules/tfhe/tfhe_bg.wasm');
            if (fs.existsSync(wasmPath)) {
              res.setHeader('Content-Type', 'application/wasm');
              res.setHeader('Cache-Control', 'public, max-age=3600');
              const wasmFile = fs.readFileSync(wasmPath);
              res.end(wasmFile);
              return;
            }
          }
          next();
        });
      }
    },
    wasmPlugin({
      targetEnv: 'browser',
      maxFileSize: 10000000 // 10MB for large WASM files
    }),
    topLevelAwait(),
    nodePolyfills({
      protocolImports: true,
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
    }),
    viteStaticCopy({
      targets: [
        {
          src: 'extension/manifest.json',
          dest: '.'
        },
        {
          src: 'service-worker.js',
          dest: '.'
        },
        {
          src: 'extension/content-script.js',
          dest: '.'
        },
        {
          src: 'extension/inpage.js',
          dest: '.'
        },
        {
          src: 'images/icon32.png',
          dest: '.'
        },
        {
          src: 'images/icon48.png',
          dest: '.'
        },
        {
          src: 'images/icon128.png',
          dest: '.'
        },
      ],
    }),
  ],
  assetsInclude: ['**/*.wasm'],
  resolve: {
    alias: {
      // cofhejs web binding support
    }
  },
  base: './',
  server: {
    historyApiFallback: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin-allow-popups'
    },
    proxy: {
      '/api/1inch': {
        target: 'https://api.1inch.io/v5.0/1',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/1inch/, ''),
      },
      '/api/0x-mainnet': {
        target: 'https://api.0x.org/swap/v1',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/0x-mainnet/, ''),
      },
      '/api/0x-sepolia': {
        target: 'https://sepolia.api.0x.org/swap/v1',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/0x-sepolia/, ''),
      },
      '/api/coingecko': {
        target: 'https://api.coingecko.com/api/v3',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/coingecko/, ''),
      },
    },
    fs: {
      allow: ['..']
    }
  },
  optimizeDeps: {
    include: ['tweetnacl'],
    exclude: ['tfhe'],
    esbuildOptions: {
      target: 'esnext'
    }
  },
  build: {
    target: 'esnext',
    outDir: 'dist',
    emptyOutDir: true,
    minify: 'esbuild',
    // Remove all console output and debugger in production builds
    esbuild: {
      drop: ['debugger'],
      pure: [
        'console.log',
        'console.warn',
        'console.error',
        'console.info',
        'console.debug',
        'console.trace',
      ],
    },
    rollupOptions: {
      input: 'index.html',
      output: {
        dir: 'dist',
        entryFileNames: '[name].js',
        manualChunks(id) {
          // ── React + MUI + Emotion (core UI — merged to avoid circular deps) ──
          if (id.includes('/react-dom/') || id.includes('/react/') ||
              id.includes('/react-router/') || id.includes('/react-toastify/') ||
              id.includes('/react-i18next/') || id.includes('/i18next/') ||
              id.includes('/scheduler/') ||
              id.includes('/@mui/material/') || id.includes('/@mui/system/') ||
              id.includes('/@mui/utils/') || id.includes('/@mui/styled-engine/') ||
              id.includes('/@mui/private-theming/') || id.includes('/@mui/icons-material/') ||
              id.includes('/@emotion/')) {
            return 'react-framework';
          }
          // ── Charting (recharts + d3 + MUI charts — lazy) ──
          if (id.includes('/recharts/') || id.includes('/d3-') ||
              id.includes('/@mui/x-charts/') || id.includes('/victory-vendor/')) {
            return 'charting';
          }
          // ── ethers (blockchain core) ──
          if (id.includes('/ethers/') || id.includes('/@noble/') || id.includes('/@adraffy/')) {
            return 'ethers';
          }
          // ── WalletConnect (lazy — only when connecting dApps) ──
          if (id.includes('/@walletconnect/') || id.includes('/@stablelib/') ||
              id.includes('/uint8arrays/') || id.includes('/multiformats/')) {
            return 'walletconnect';
          }
          // ── Cytoscape (graph explorer only) ──
          if (id.includes('/cytoscape')) {
            return 'cytoscape';
          }
          // ── Alchemy SDK + Crypto polyfills + Node polyfills (merged to avoid circular deps) ──
          if (id.includes('/alchemy-sdk/') ||
              id.includes('/elliptic/') || id.includes('/bn.js/') ||
              id.includes('/hash.js/') || id.includes('/hmac-drbg/') ||
              id.includes('/minimalistic-assert/') || id.includes('/minimalistic-crypto-utils/') ||
              id.includes('/brorand/') || id.includes('/browserify-') ||
              id.includes('/create-hash/') || id.includes('/create-hmac/') ||
              id.includes('/cipher-base/') || id.includes('/md5.js/') ||
              id.includes('/sha.js/') || id.includes('/ripemd160/') ||
              id.includes('/des.js/') || id.includes('/diffie-hellman/') ||
              id.includes('/public-encrypt/') || id.includes('/randomfill/') ||
              id.includes('/randombytes/') || id.includes('/pbkdf2/') ||
              id.includes('/parse-asn1/') || id.includes('/asn1.js/') ||
              id.includes('/evp_bytestokey/') || id.includes('/vm-browserify/') ||
              id.includes('/crypto-browserify/') ||
              id.includes('/node_modules/buffer/') || id.includes('/node_modules/stream-') ||
              id.includes('/node_modules/readable-stream/') || id.includes('/node_modules/events/') ||
              id.includes('/node_modules/process/') || id.includes('/node_modules/util/') ||
              id.includes('/node_modules/inherits/') || id.includes('/node_modules/safe-buffer/') ||
              id.includes('/node_modules/string_decoder/') || id.includes('/node-polyfills')) {
            return 'polyfills';
          }
          // Kept as its own named chunk. Leaving it unassigned does let the dynamic
          // import in Auth.tsx build a real async chunk — but it also scatters
          // @web3auth's CommonJS modules across the other vendor chunks, and one of
          // them lands somewhere its `require` is never interop-wrapped, so the wallet
          // fails to boot with "require is not defined". A 627 KB chunk on the critical
          // path is a cost; a wallet that shows a black screen is not a trade.
          if (id.includes('/@web3auth/')) {
            return 'web3auth';
          }
          // ── FHE / cofhejs (encryption layer) ──
          if (id.includes('/cofhejs/') || id.includes('/tfhe/')) {
            return 'fhe';
          }
          // ── Unstoppable Domains (lazy — domain resolution only) ──
          if (id.includes('/@unstoppabledomains/') || id.includes('/uns-resolver/')) {
            return 'unstoppable';
          }
        },
      },
      external: (id) => {
        // Don't bundle WASM files
        if (id.endsWith('.wasm')) return false;
        return false;
      }
    }
  },
  worker: {
    format: 'es',
    plugins: () => [
      wasmPlugin({ targetEnv: 'browser', maxFileSize: 10000000 }),
      topLevelAwait()
    ]
  }
});
