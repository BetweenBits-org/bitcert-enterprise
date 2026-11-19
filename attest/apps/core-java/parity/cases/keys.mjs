/**
 * Sandbox sign-up: a key back at once, a new organisation every time, and a
 * cap per address. Every request names the address it comes from
 * (x-forwarded-for; both servers trust it here), so that one group of cases
 * does not use up another's allowance.
 */
const from = (address) => ({ 'Content-Type': 'application/json', 'X-Forwarded-For': address });
const MINTED = ['$.org.id', '$.org.slug', '$.api_key'];
const WAIT = { blur: [[/retry in \d+s/, 'retry in <n>s']], volatileHeaders: ['retry-after'] };

export default () => {
  const k = '/v1/sandbox/keys';
  const cases = [
    { name: 'a key for a new organisation', method: 'POST', target: k, headers: from('198.51.100.1'), body: {}, volatile: MINTED, capture: { minted: '$.api_key' } },
    { name: 'the new key lists nothing yet', target: '/v1/attestations', headers: { Authorization: 'Bearer {minted}' } },
    { name: 'the new key anchors a digest', method: 'POST', target: '/v1/attestations', headers: { Authorization: 'Bearer {minted}', 'Content-Type': 'application/json' }, body: { leaf_bytes: 'ab'.repeat(32) }, volatile: ['$.id', '$.created_at'] },
    { name: 'a key with no body', method: 'POST', target: k, headers: { 'X-Forwarded-For': '198.51.100.1' }, volatile: MINTED },
    { name: 'a key with a slug, a name and a label', method: 'POST', target: k, headers: from('198.51.100.1'), body: { slug: 'Parity-New-Org', name: 'A New Organisation', label: 'first key' }, volatile: ['$.org.id', '$.api_key'] },
    { name: 'the same slug again', method: 'POST', target: k, headers: from('198.51.100.1'), body: { slug: 'parity-new-org' } },
    { name: 'a slug that was seeded', method: 'POST', target: k, headers: from('198.51.100.1'), body: { slug: 'PARITY-BANK' } },
    { name: 'a slug that is empty', method: 'POST', target: k, headers: from('198.51.100.1'), body: { slug: '' }, volatile: ['$.org.id', '$.api_key'] },
    { name: 'the empty slug again', method: 'POST', target: k, headers: from('198.51.100.1'), body: { slug: '' } },
    { name: 'a slug that is not text', method: 'POST', target: k, headers: from('198.51.100.2'), body: { slug: 5, name: 7, label: null }, volatile: MINTED },
    { name: 'a slug with odd characters', method: 'POST', target: k, headers: from('198.51.100.2'), body: { slug: ' Spaced / Ünïcode 😀 ' }, volatile: ['$.org.id', '$.api_key'] },
    { name: 'a slug longer than the column', method: 'POST', target: k, headers: from('198.51.100.2'), body: { slug: 's'.repeat(200) } },
    { name: 'a sign-up body that is null', method: 'POST', target: k, headers: from('198.51.100.2'), body: 'null' },
    { name: 'a sign-up body that is a list', method: 'POST', target: k, headers: from('198.51.100.2'), body: '[]', volatile: MINTED },
    { name: 'a sign-up body that is not JSON', method: 'POST', target: k, headers: from('198.51.100.2'), body: '{' },
    { name: 'sign-up with another method', target: k, headers: from('198.51.100.2') },
  ];
  // One address, until its allowance is used up: every request counts, whatever it is answered.
  for (let i = 1; i <= 10; i++) {
    cases.push({ name: `request ${i} from one address`, method: 'POST', target: k, headers: from('198.51.100.9'), body: { slug: 'parity-bank' }, ...WAIT });
  }
  cases.push({ name: 'the first of several addresses in the header decides', method: 'POST', target: k, headers: from('198.51.100.9, 10.0.0.1'), body: { slug: 'parity-bank' }, ...WAIT },
    { name: 'another address is not held back', method: 'POST', target: k, headers: from('  198.51.100.10 , 198.51.100.9'), body: { slug: 'parity-bank' }, ...WAIT });
  return cases;
};
