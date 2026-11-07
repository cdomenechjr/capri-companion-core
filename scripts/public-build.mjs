// Public builds always generate neutral assets; never fall back to private art.
process.env.CAPRI_PUBLIC_BUILD = '1';
const {buildCapri} = await import('./build.mjs');
await buildCapri();
