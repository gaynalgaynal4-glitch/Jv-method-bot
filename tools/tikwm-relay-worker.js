// OPTIONAL — only needed if TikWM blocks your host's IP address (the bot logs "[tikwm] ... -> HTTP 403").
// A tiny Cloudflare Worker that forwards /api/* calls to tikwm.com from Cloudflare's network.
// Deploy it (Cloudflare dashboard -> Workers -> Create -> paste this), then set on your bot host:
//   TIKWM_API_BASE=https://<your-worker>.workers.dev
// NOTE: this relay file has not been run against the live TikWM service.
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return new Response('Not found', { status: 404 });
    const headers = new Headers({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Origin': 'https://www.tikwm.com',
      'Referer': 'https://www.tikwm.com/',
    });
    for (const h of ['content-type', 'x-requested-with']) { const v = request.headers.get(h); if (v) headers.set(h, v); }
    const upstream = await fetch('https://www.tikwm.com' + url.pathname + url.search, {
      method: request.method, headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
    });
    return new Response(upstream.body, { status: upstream.status, headers: { 'content-type': upstream.headers.get('content-type') || 'application/json' } });
  },
};
