// A fake web for tests: maps URLs to canned responses and hostnames to IPs.

export function fakeWeb(routes, dns = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET' });
    if (init.signal?.aborted) throw init.signal.reason || new Error('aborted');
    const route = routes[url];
    if (!route) return new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } });
    if (typeof route === 'function') return route(url, init);
    const { status = 200, headers = {}, body = '' } = route;
    const method = init.method || 'GET';
    return new Response(method === 'HEAD' || [301, 302, 303, 307, 308].includes(status) ? null : body, { status, headers });
  };
  const resolveHost = async (host) => {
    if (host in dns) return dns[host];
    return ['93.184.215.14'];
  };
  return { fetchImpl, resolveHost, calls };
}

export const html = (s) => ({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: s });
