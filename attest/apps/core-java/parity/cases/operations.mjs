/**
 * What an orchestrator and a client ask first, and the edges of the router:
 * which request is a 404, how a path is read, what a method nobody registered
 * gets.
 */
const methods = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
export default [
  { target: '/healthz' },
  // Is the node there? Both servers ask the same node; its height moves, so the sentence is compared by kind.
  { target: '/readyz', volatile: ['$.chain.detail'] }, { method: 'POST', target: '/readyz' }, { target: '/readyz/' },
  { target: '/v1/meta' },
  { target: '/v1/meta?x=1' },
  { target: '/healthz?x=1&y=%zz' },
  // The router skips empty segments, so these are the same routes …
  { target: '/healthz/' }, { target: '/v1//meta/' }, { target: '/v1/./meta' }, { target: '/v1/x/../meta' }, { target: '/healthz//' },
  // … and these are not: a literal segment is compared as it was sent.
  { target: '/HEALTHZ' }, { target: '/v1/%6deta' }, { target: '/healthz%20' }, { target: '/healthz/x' }, { target: '/v1' }, { target: '/v1/' }, { target: '/v1/meta/extra' },
  // Two slashes at the start name a host, as in any relative URL — so this is `/`.
  { target: '//healthz' }, { target: '//healthz/v1/meta' },
  ...methods.filter((m) => m !== 'GET').map((method) => ({ method, target: '/healthz' })),
  ...methods.map((method) => ({ method, target: '/nope' })),
  { method: 'POST', target: '/nope', headers: { 'Content-Type': 'application/json' }, body: { a: 1 } },
  { method: 'POST', target: '/v1/meta', headers: { 'Content-Type': 'text/plain' }, body: 'not json' },
  { method: 'PROPFIND', target: '/healthz' },
  { target: '/nope?a=1' }, { target: '/a/b/c/d/e' }, { target: '/%E0' }, { target: '/%zz' }, { target: '/a%2Fb' }, { target: '/caf%C3%A9' },
  { target: '/a^b' }, { target: '/a|b' }, { target: '/a{b}' }, { target: '/a[b]' }, { target: '/a`b' }, { target: '/a"b' }, { target: '/a<b>' }, { target: '/a\\b' }, { target: "/a'b" },
  { target: '/..' }, { target: '/a/..' }, { target: '/a/../..' }, { target: '/./healthz' }, { target: '/x/../healthz' }, { target: '/%2e%2e/healthz' }, { target: '/x/%2E%2E/healthz' },
  // A target that is not a URL at all.
  { target: '//[/x' }, { target: '//h:99999/x' }, { target: '//a^b/x' },
  { target: '/healthz', headers: { Authorization: 'Bearer sk_test_nothing' } },
  { target: '/healthz', headers: { Accept: 'text/html' } },
  { target: '/v1/meta', headers: { Accept: 'application/xml', 'Accept-Encoding': 'gzip' } },
];
