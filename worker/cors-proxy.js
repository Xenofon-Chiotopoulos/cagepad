/**
 * Optional CORS proxy for CagePad (Cloudflare Workers, free tier).
 *
 * Lets the site load ANY logic-masters / SudokuPad puzzle instantly instead of waiting
 * for the hourly cache. Deploy:  npx wrangler deploy worker/cors-proxy.js --name cagepad-proxy
 * then put  https://cagepad-proxy.<you>.workers.dev/?url={url}  into CagePad → Settings → CORS proxy.
 *
 * Only the hosts below can be fetched, so this cannot be abused as an open proxy.
 */
const ALLOWED_HOSTS = [
	'logic-masters.de', 'www.logic-masters.de',
	'sudokupad.app', 'beta.sudokupad.app', 'sudokupad.svencodes.com',
	'f-puzzles.com', 'www.f-puzzles.com',
	'tinyurl.com', 'bit.ly',
];
// Set to your site's origin (e.g. 'https://you.github.io') to stop other sites using your worker.
const ALLOWED_ORIGIN = '*';

export default {
	async fetch(request) {
		const cors = {
			'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
			'Access-Control-Expose-Headers': 'x-final-url',
		};
		if (request.method === 'OPTIONS') return new Response(null, {headers: {...cors, 'Access-Control-Allow-Methods': 'GET'}});
		const params = new URL(request.url).searchParams;
		let target;
		try { target = new URL(params.get('url') || ''); } catch (e) { return new Response('missing or invalid ?url=', {status: 400, headers: cors}); }
		if (target.protocol !== 'https:' && target.protocol !== 'http:') return new Response('bad protocol', {status: 400, headers: cors});
		if (!ALLOWED_HOSTS.includes(target.hostname)) return new Response('host not allowed', {status: 403, headers: cors});

		const upstream = await fetch(target.toString(), {
			redirect: 'follow',
			headers: {'User-Agent': 'CagePad-proxy/1.0'},
			cf: {cacheTtl: 300},
		});
		const headers = {...cors, 'x-final-url': upstream.url, 'Content-Type': upstream.headers.get('Content-Type') || 'text/plain'};
		// ?resolve=1 → just report where a short link ends up
		if (params.get('resolve')) return new Response(upstream.url, {status: 200, headers});
		return new Response(upstream.body, {status: upstream.status, headers});
	},
};
