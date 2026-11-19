/**
 * The free tier: a digest in, with no account; the record and its bundle by
 * id alone; CORS for the pages that call it; and the two caps — per address
 * and for the whole service — which come last, because once the service-wide
 * cap is reached nothing more is accepted in this run.
 */
import { createHash } from 'node:crypto';

const digest = (label) => createHash('sha256').update(`parity run, free tier: ${label}`).digest('hex');
const from = (address, extra = {}) => ({ 'Content-Type': 'application/json', 'X-Forwarded-For': address, ...extra });
const NEW = ['$.id', '$.created_at', '$.retrievable_until', '$.bundle_url'];
const WAIT = { blur: [[/retry in \d+s/, 'retry in <n>s']], volatileHeaders: ['retry-after'] };

export default ({ seed }) => {
  const p = '/v1/public/anchors';
  const allowed = { Origin: 'https://playground.example' };
  const other = { Origin: 'https://elsewhere.example' };
  const cases = [
    { name: 'preflight', method: 'OPTIONS', target: p }, { name: 'preflight from an allowed page', method: 'OPTIONS', target: p, headers: allowed },
    { name: 'preflight from another page', method: 'OPTIONS', target: p, headers: other }, { name: 'preflight for a record', method: 'OPTIONS', target: `${p}/x`, headers: allowed },
    { name: 'preflight for a bundle', method: 'OPTIONS', target: `${p}/x/bundle`, headers: { Origin: 'https://other.example' } }, { name: 'preflight one level deeper', method: 'OPTIONS', target: `${p}/x/bundle/y`, headers: allowed },
    { name: 'preflight with a body', method: 'OPTIONS', target: p, headers: { ...allowed, 'Content-Type': 'application/json' }, body: '{' },
    { name: 'another method on the collection', method: 'PUT', target: p, headers: allowed }, { name: 'reading the collection', target: p, headers: allowed },

    { name: 'a seeded record, confirmed', target: `${p}/${seed.ids.public.confirmed}` }, { name: 'a seeded record, from an allowed page', target: `${p}/${seed.ids.public.confirmed}`, headers: allowed },
    { name: 'a seeded record, from another page', target: `${p}/${seed.ids.public.confirmed}`, headers: other }, { name: 'a seeded record, waiting', target: `${p}/${seed.ids.public.accepted}` },
    { name: 'a seeded record past its time', target: `${p}/${seed.ids.public.expired}` }, { name: 'a record nobody made', target: `${p}/00000000-0000-4000-8000-000000000000`, headers: allowed },
    { name: 'an organisation\'s record by id alone', target: `${p}/${seed.ids.confirmed[0]}` }, { name: 'a record id that is a malformed escape', target: `${p}/%E0`, headers: allowed },
    { name: 'the bundle of the confirmed record', target: `${p}/${seed.ids.public.confirmed}/bundle`, headers: allowed, volatile: ['$.generated_at'] },
    { name: 'the bundle of the waiting record', target: `${p}/${seed.ids.public.accepted}/bundle` }, { name: 'the bundle of a record nobody made', target: `${p}/nobody/bundle`, headers: other },
    { name: 'the bundle of an organisation\'s record by id alone', target: `${p}/${seed.ids.confirmed[0]}/bundle` },

    { name: 'a digest', method: 'POST', target: p, headers: from('203.0.113.1', allowed), body: { sha256: digest('first') }, volatile: NEW, capture: { free: '$.id' } },
    { name: 'the record just made', target: `${p}/{free}`, volatile: NEW }, { name: 'the bundle of the record just made', target: `${p}/{free}/bundle` },
    { name: 'the same digest again', method: 'POST', target: p, headers: from('203.0.113.1'), body: { sha256: digest('first') }, volatile: NEW },
    { name: 'the same digest in upper case', method: 'POST', target: p, headers: from('203.0.113.1'), body: { sha256: digest('first').toUpperCase() }, volatile: NEW },
    { name: 'a digest in upper case', method: 'POST', target: p, headers: from('203.0.113.1'), body: { sha256: digest('upper').toUpperCase() }, volatile: NEW },
    { name: 'a digest as leaf_bytes', method: 'POST', target: p, headers: from('203.0.113.1', other), body: { leaf_bytes: digest('as leaf_bytes') }, volatile: NEW },
    { name: 'a digest as digest', method: 'POST', target: p, headers: from('203.0.113.1'), body: { digest: digest('as digest') }, volatile: NEW },
    { name: 'sha256 that is null beside leaf_bytes', method: 'POST', target: p, headers: from('203.0.113.1'), body: { sha256: null, leaf_bytes: digest('null then leaf_bytes') }, volatile: NEW },
    { name: 'sha256 that is no digest beside a good leaf_bytes', method: 'POST', target: p, headers: from('203.0.113.1'), body: { sha256: 'nope', leaf_bytes: digest('bad then good') } },
    { name: 'a seeded digest', method: 'POST', target: p, headers: from('203.0.113.1'), body: { sha256: seed.digests.publicConfirmed } },
    { name: 'a digest an organisation holds', method: 'POST', target: p, headers: from('203.0.113.1'), body: { sha256: seed.digests.confirmed0 }, volatile: NEW },
    { name: 'fields nobody asked for', method: 'POST', target: p, headers: from('203.0.113.2'), body: { sha256: digest('extra'), content_type: 'text/plain', descriptor: { a: 1 }, expires_at: '2999-01-01T00:00:00.000Z' }, volatile: NEW },
    { name: 'no digest', method: 'POST', target: p, headers: from('203.0.113.2', allowed), body: {} }, { name: 'no body', method: 'POST', target: p, headers: { 'X-Forwarded-For': '203.0.113.2' } },
    { name: 'a digest too short', method: 'POST', target: p, headers: from('203.0.113.2'), body: { sha256: 'abc' } }, { name: 'a digest that is not hex', method: 'POST', target: p, headers: from('203.0.113.2'), body: { sha256: 'z'.repeat(64) } },
    { name: 'a digest that is a number', method: 'POST', target: p, headers: from('203.0.113.2'), body: { sha256: 5 } }, { name: 'a digest with a line end', method: 'POST', target: p, headers: from('203.0.113.2'), body: { sha256: `${digest('line end')}\n` } },
    { name: 'a body that is a list', method: 'POST', target: p, headers: from('203.0.113.2'), body: '[]' }, { name: 'a body that is null', method: 'POST', target: p, headers: from('203.0.113.2'), body: 'null' },
    { name: 'a body that is not JSON', method: 'POST', target: p, headers: from('203.0.113.2', other), body: '{"sha256"' },
  ];
  // One address until its allowance is used up; then address after address until the service's is.
  for (let i = 1; i <= 14; i++) cases.push({ name: `request ${i} from one address`, method: 'POST', target: p, headers: from('203.0.113.50', allowed), body: {}, ...WAIT });
  for (let i = 1; i <= 30; i++) cases.push({ name: `address ${i} of many`, method: 'POST', target: p, headers: from(`203.0.113.${100 + i}`), body: {}, ...WAIT });
  cases.push({ name: 'a good digest once the service is full', method: 'POST', target: p, headers: from('203.0.113.250', allowed), body: { sha256: digest('too late') }, ...WAIT },
    { name: 'reading still works once the service is full', target: `${p}/${seed.ids.public.confirmed}`, headers: allowed },
    { name: 'the bundle still works once the service is full', target: `${p}/${seed.ids.public.confirmed}/bundle`, volatile: ['$.generated_at'] });
  return cases;
};
