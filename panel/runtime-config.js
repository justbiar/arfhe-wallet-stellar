/**
 * Where the backends are, read at run time instead of baked into the bundle.
 *
 * The demo's anchor and payment service sit behind Cloudflare quick tunnels, and those
 * rotate: a link submitted on Friday is dead by Saturday. Baking the hostname into the
 * build meant the published site died with the tunnel and the URL had to change with it.
 *
 * This file is plain script, loaded before the module bundle, so the values are there
 * synchronously and nothing has to become async to read them. When a tunnel rotates, this
 * one file changes and the site's address stays exactly where it was.
 */
window.__ARFHE_CONFIG__ = {
  anchor: "spend-axis-controller-lopez.trycloudflare.com",
  payroll: "https://surgery-response-derby-experts.trycloudflare.com",
};
