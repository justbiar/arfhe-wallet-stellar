# Privacy story

Three.js is isolated here to avoid changing the root dependencies while the payroll/SDK work is in progress. React and MUI resolve from the existing app; they are not duplicated.

From the repository root, run `npm ci --prefix panel/visuals --ignore-scripts` after cloning, then run the panel normally. Three.js is bundled locally; no runtime CDN requests are made.

The canvas is decorative. Payment values, controls and the public/private comparison remain accessible HTML, including when WebGL is unavailable. The timeline stops when offscreen or in a background tab and respects reduced-motion preferences. All transactions shown are fictional; no wallet or payment API is called.
