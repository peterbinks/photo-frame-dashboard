import { defineConfig } from 'vite';
import { createHash } from 'node:crypto';

// Build id for app auto-reload: a hash of the (content-hashed) output file names, written into
// index.html as <meta name="hq-build">. The Worker reports the deployed one at /api/version and
// screens running an older build reload themselves (js/version.js). Identical builds → same id.
function buildId() {
  return {
    name: 'hq-build-id',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const id = ctx.bundle ? createHash('sha256').update(Object.keys(ctx.bundle).sort().join('\n')).digest('hex').slice(0, 12) : 'dev';
        return [{ tag: 'meta', attrs: { name: 'hq-build', content: id }, injectTo: 'head' }];
      },
    },
  };
}

// The wall tablet runs Android WebView 106 — keep JS output within Chromium 106.
// CSS targets chrome61 on purpose: the tablet's WebView rejects 4/8-digit hex colours (#0000,
// #ffffffbf) even though Chrome 106 should support them, and a newer target lets the minifier
// rewrite transparent/rgba() into that form. Verified on-device with CSS.supports().
export default defineConfig({
  plugins: [buildId()],
  build: {
    target: 'chrome106',
    cssTarget: 'chrome61',
  },
  server: { host: true },
});
