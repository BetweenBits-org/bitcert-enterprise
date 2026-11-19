/**
 * MT103: what the Java port's testers found by feeding the reader inputs
 * nobody had tried. Each test is one fix, and says what it proves; the rule
 * they all follow is the reader's own — refuse rather than guess.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSwiftMessage, parseSwiftMessages, swiftContentDigest, SwiftMessageError } from '../src/index.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sample = (name: string): string => readFileSync(path.join(HERE, '..', 'samples', name)).toString('latin1');

/** A whole MT103 with its header blocks around these fields. */
const mt = (fields: string, b3 = ''): string =>
  `{1:F01DEMOVNVXAXXX0000000000}{2:I103DEMOSGSGXXXXN}${b3}{4:\n${fields}-}`;
const BASE = ':20:R\n:23B:CRED\n:32A:261117USD5,\n:50K:A\n:59:/ACC1\nB\n:71A:SHA\n';
const UETR = 'b4d9e7a1-5c36-4f82-a1d0-6e9f3c2b8a57';

/** BASE with this field written so: in place of its own, or of 50K / 59, or added before 59. */
const withField = (tag: string, body: string): string => {
  if (tag.startsWith('50')) return BASE.replace(':50K:A\n', `:${tag}:${body}\n`);
  if (tag.startsWith('59')) return BASE.replace(':59:/ACC1\nB\n', `:${tag}:${body}\n`);
  const own = new RegExp(`:${tag}:[^\\n]*\\n`);
  return own.test(BASE) ? BASE.replace(own, `:${tag}:${body}\n`) : BASE.replace(':59:', `:${tag}:${body}\n:59:`);
};

/** The refusal a text meets; fails the test when the text is read. */
const refusal = (text: string): SwiftMessageError => {
  try {
    parseSwiftMessages(text);
  } catch (e) {
    if (e instanceof SwiftMessageError) return e;
    throw e;
  }
  return assert.fail(`read without a word: ${JSON.stringify(text)}`);
};

test('M1 field 70: a code word with nothing after it has no value, and the next code word is read on its own', () => {
  const read = (f70: string) => parseSwiftMessage(mt(BASE.replace(':71A:', `:70:${f70}\n:71A:`)));
  // An empty /ROC/ took "/INV/X" for its own: the invoice became the end-to-end reference.
  const roc = read('/ROC//INV/X');
  assert.deepEqual([roc.endToEndId, roc.invoiceReferences], [undefined, ['X']]);
  // An empty /ROC/ does not hide one that says something…
  assert.equal(read('/ROC//ROC/PO-7811').endToEndId, 'PO-7811');
  // …nor take the line after it.
  const lines = read('/ROC/\n/INV/X');
  assert.deepEqual([lines.endToEndId, lines.invoiceReferences], [undefined, ['X']]);
  // An empty /INV/ before it leaves /ROC/ its own value.
  assert.equal(read('/INV//ROC/PO-7811').endToEndId, 'PO-7811');
  // What was read before is read the same.
  const guide = read('/RFB/BET072\n/INV/abc/SDF-96//1234-234///ROC/98IU87');
  assert.deepEqual([guide.invoiceReferences, guide.endToEndId], [['abc/SDF-96', '1234-234'], '98IU87']);
});

test('M2: a second line under a field the standard writes on one line refuses the message, naming the field', () => {
  const cases: [string, string][] = [
    ['20', 'R\nR2'], ['23B', 'CRED\nSPAY'], ['26T', 'K90\nA01'], ['32A', '261117USD5,\n9999'], ['33B', 'USD5,\n6,'],
    ['36', '1,25\n7'], ['56C', '/123\nBANK'], ['57C', '/123\nBANK'], ['71A', 'SHA\nOUR'], ['71F', 'USD1,\n2,'], ['71G', 'USD1,\n2,'],
  ];
  for (const [tag, body] of cases) {
    const e = refusal(mt(withField(tag, body)));
    assert.deepEqual([e.code, e.field], ['malformed_message', tag], tag);
    assert.ok(e.message.startsWith(`field ${tag} takes one line, but "${body.split('\n')[1]}" follows it`), e.message);
  }
  // A blank line between does not hide the second; blank lines after the value are not one.
  assert.equal(refusal(mt(withField('32A', '261117USD5,\n\n9999'))).field, '32A');
  assert.equal(parseSwiftMessage(mt(withField('71A', 'SHA\n   \n'))).chargeBearer, 'SHAR');
  // The bank's own CRLF file, a charges code added under 71A.
  const crlf = refusal(sample('mt103.sample.txt').replace(':71A:OUR\r\n', ':71A:OUR\r\nSHA\r\n'));
  assert.deepEqual([crlf.code, crlf.field], ['malformed_message', '71A']);
  // Fields of several lines keep them.
  assert.deepEqual(parseSwiftMessage(sample('mt103.sample.txt')).debtor.addressLines, ['12 LE LOI BLVD DISTRICT 1', 'HO CHI MINH CITY']);
});

test('M3: block 3 with field 121 twice is refused, not read as its first UETR', () => {
  for (const second of ['11111111-2222-4333-8444-555555555555', UETR]) {
    const e = refusal(mt(BASE, `{3:{121:${UETR}}{121:${second}}}`));
    assert.deepEqual([e.code, e.field], ['malformed_message', 'block 3 field 121']);
    assert.match(e.message, /more than once/);
  }
  // One UETR among other sub-blocks is read.
  assert.equal(parseSwiftMessage(mt(BASE, `{3:{108:MUR-1}{121:${UETR}}{119:STP}}`)).uetr, UETR);
});

test('M4: every field the reader takes a value from refuses the message when it is present but empty', () => {
  const read = ['20', '23B', '26T', '32A', '33B', '36', '50A', '50F', '50K', '52A', '52D', '56A', '56C', '56D',
    '57A', '57C', '57D', '59', '59A', '59F', '70', '71A', '71F', '71G', '77B'];
  for (const tag of read) {
    for (const body of ['', '   ']) {
      const e = refusal(mt(withField(tag, body)));
      assert.deepEqual([e.code, e.field], ['invalid_field', tag], `${tag} ${JSON.stringify(body)}`);
      assert.ok(e.message.startsWith(`field ${tag} is present but empty`), e.message);
    }
  }
  // An empty 71A was "no charges code", an empty 33B "no instructed amount": now neither is read.
  assert.equal(refusal(mt(BASE.replace(':71A:SHA', ':71A:'))).field, '71A');
  // Block 3: an empty field 121 is not "no UETR".
  const b3 = refusal(mt(BASE, '{3:{121:}}'));
  assert.deepEqual([b3.code, b3.field], ['invalid_field', 'block 3 field 121']);
  assert.match(b3.message, /present but empty/);
  assert.equal(parseSwiftMessage(mt(BASE, '{3:{108:MUR-1}}')).uetr, undefined, 'block 3 without field 121 states no UETR');
});

test('M5: the value date in 32A is a day of the calendar, and field 36 is a rate', () => {
  const dated = (d: string): string => mt(BASE.replace(':32A:261117', `:32A:${d}`));
  for (const d of ['269999', '261301', '260001', '261100', '261131', '260230', '260229', '230229']) {
    const e = refusal(dated(d));
    assert.deepEqual([e.code, e.field], ['invalid_field', '32A'], d);
    assert.ok(e.message.startsWith(`field 32A: the value date "${d}" is not a calendar date`), e.message);
  }
  for (const [d, iso] of [['240229', '2024-02-29'], ['000229', '2000-02-29'], ['261130', '2026-11-30'],
    ['261231', '2026-12-31'], ['790101', '2079-01-01'], ['800101', '1980-01-01'], ['991231', '1999-12-31']] as const) {
    assert.equal(parseSwiftMessage(dated(d)).valueDate, iso, d);
  }

  const rated = (r: string): string => mt(BASE.replace(':50K:', `:33B:EUR4,\n:36:${r}\n:50K:`));
  for (const r of ['1,2,3', '1.25', '125', ',5', '1, 5', '-1,5', '1,5E2', '1234567890,12']) {
    const e = refusal(rated(r));
    assert.deepEqual([e.code, e.field], ['invalid_field', '36'], r);
    assert.ok(e.message.startsWith(`field 36: "${r}" is not an exchange rate`), e.message);
  }
  for (const [r, rate] of [['0,9125', '0.9125'], ['1,', '1'], ['12345678901,', '12345678901'], ['1234567,1234', '1234567.1234']] as const) {
    assert.equal(parseSwiftMessage(rated(r)).exchangeRate, rate, r);
  }
});

test('M6: an institution field that is only "//" names no clearing code, and the BIC of the header stands', () => {
  const p = parseSwiftMessage(mt(BASE.replace(':59:', ':52D://\n:57D://\n:59:')));
  assert.deepEqual([p.debtorAgent, p.creditorAgent], [{ bic: 'DEMOVNVX' }, { bic: 'DEMOSGSG' }]);
  assert.deepEqual(parseSwiftMessage(mt(BASE.replace(':59:', ':57C://\n:59:'))).creditorAgent, { bic: 'DEMOSGSG' });
  // A name after it is the agent, without an empty member id beside it.
  assert.deepEqual(parseSwiftMessage(mt(BASE.replace(':59:', ':57D://\nPAYOUT BANK\n:59:'))).creditorAgent, { name: 'PAYOUT BANK' });
  // A clearing code that is there is still read.
  assert.deepEqual(parseSwiftMessage(mt(BASE.replace(':59:', ':57D://SC123456\nPAYOUT BANK\n:59:'))).creditorAgent,
    { memberId: 'SC123456', name: 'PAYOUT BANK' });
});

test('M7: option C with a space before its slash keeps its clearing code', () => {
  assert.deepEqual(parseSwiftMessage(mt(BASE.replace(':59:', ':57C: /123456789\n:59:'))).creditorAgent, { memberId: '123456789' });
  assert.deepEqual(parseSwiftMessage(mt(BASE.replace(':59:', ':56C: /987654321\n:59:'))).intermediaryAgents, [{ memberId: '987654321' }]);
});

test('M9 option F: an empty name or address line adds nothing', () => {
  const p = parseSwiftMessage(mt(withField('50F', '/ACC0\n1/A\n1/B\n1/\n2/\n2/1 STREET\n3/VN/HANOI')));
  assert.equal(p.debtor.name, 'A B');
  assert.deepEqual(p.debtor.addressLines, ['1 STREET', 'HANOI']);
  const c = parseSwiftMessage(mt(withField('59F', '/ACC1\n1/\n1/PACIFIC SUPPLY\n2/\n3/SG')));
  assert.deepEqual([c.creditor.name, c.creditor.addressLines], ['PACIFIC SUPPLY', []]);
});

test('M10 59F: lines 4/ to 8/ and the coded party identifier belong to 50F, and refuse the message in 59F', () => {
  for (const line of ['4/19800101', '5/SG/SINGAPORE', '6/SG/ACRA/201912345K', '7/SG/S1234567A', '8/12']) {
    const e = refusal(mt(withField('59F', `/ACC1\n1/B\n3/SG/SINGAPORE\n${line}`)));
    assert.deepEqual([e.code, e.field], ['malformed_message', '59F'], line);
    assert.ok(e.message.startsWith(`field 59F: "${line}" is line ${line[0]}/, which 59F does not have`), e.message);
  }
  const coded = refusal(mt(withField('59F', 'CCPT/SG/S1234567A\n1/B\n3/SG')));
  assert.deepEqual([coded.code, coded.field], ['invalid_field', '59F']);
  assert.ok(coded.message.includes('"CCPT/SG/S1234567A" is not a numbered line (expected 1/ … 3/)'), coded.message);
  // 50F keeps all of them.
  const p = parseSwiftMessage(mt(withField('50F', 'CCPT/VN/C1234567\n1/A\n3/VN\n4/19800101\n5/VN/HANOI\n7/VN/012345678901\n8/9')));
  assert.deepEqual([p.debtor.person, p.debtor.identification, p.debtor.identificationScheme], [true, 'C1234567', 'CCPT']);
});

test('M13: in 50a and 59a the account is everything after the first slash; the /C/ and /D/ marks are the institution fields\' alone', () => {
  const k = parseSwiftMessage(mt(BASE.replace(':59:/ACC1', ':59:/S/SG-ACC-000009').replace(':50K:A', ':50K:/C/VN-1\nA')));
  assert.deepEqual([k.creditor.account, k.debtor.account, k.debtor.name], ['S/SG-ACC-000009', 'C/VN-1', 'A']);
  const a = parseSwiftMessage(mt(withField('50A', '/C/VN-2\nDEMOVNVX').replace(':59:/ACC1\nB\n', ':59A:/D/SG-2\nDEMOSGSG\n')));
  assert.deepEqual([a.debtor.account, a.debtor.bic, a.creditor.account, a.creditor.bic], ['C/VN-2', 'DEMOVNVX', 'D/SG-2', 'DEMOSGSG']);
  assert.equal(parseSwiftMessage(mt(withField('59F', '/S/SG-3\n1/B\n3/SG'))).creditor.account, 'S/SG-3');
  // A second slash is part of the account too: //CH123456 is not the beneficiary's name.
  const chips = parseSwiftMessage(mt(BASE.replace(':59:/ACC1', ':59://CH123456')));
  assert.deepEqual([chips.creditor.account, chips.creditor.name], ['/CH123456', 'B']);
  // In an institution field a C or D mark comes off, and no other letter.
  const agent = (first: string) => parseSwiftMessage(mt(BASE.replace(':59:', `:57C:${first}\n:59:`))).creditorAgent;
  assert.deepEqual([agent('/C/026009593'), agent('/D/026009593'), agent('/S/026009593')],
    [{ memberId: '026009593' }, { memberId: '026009593' }, { memberId: 'S/026009593' }]);
});

test('M14 option F: the first 3/ line starts with the country code, or the message is refused', () => {
  for (const [tag, lines] of [
    ['59F', '1/B\n3/SINGAPORE\n3/SG/048616'], ['50F', '1/A\n3/VNM/HO CHI MINH'], ['59F', '1/B\n3/sg/SINGAPORE'],
    ['59F', '1/B\n3/'], ['59F', '1/B\n3/S/SINGAPORE'], ['59F', '1/B\n3/SG SINGAPORE'],
  ] as const) {
    const e = refusal(mt(withField(tag, `/ACC1\n${lines}`)));
    const first3 = lines.split('\n').find((l) => l.startsWith('3/'))!;
    assert.deepEqual([e.code, e.field], ['invalid_field', tag], lines);
    assert.ok(e.message.startsWith(`field ${tag}: line "${first3}" does not start with a country code`), e.message);
  }
  const at = (lines: string) => parseSwiftMessage(mt(withField('59F', `/ACC1\n1/B\n${lines}`))).creditor;
  assert.deepEqual([at('3/SG').country, at('3/SG').addressLines], ['SG', []]);
  assert.deepEqual([at('3/SG/').country, at('3/SG/').addressLines], ['SG', []]);
  // A later 3/ still continues the address, and is not read as another country.
  assert.deepEqual([at('3/SG/SINGAPORE\n3/048616').country, at('3/SG/SINGAPORE\n3/048616').addressLines], ['SG', ['SINGAPORE', '048616']]);
});

test('M16 23B: CRED, CRTS, SPAY, SPRI or SSTD exactly — a test marked in lower case does not go out as a payment', () => {
  for (const code of ['crts', 'Crts', 'CRTS1', 'CRT', 'TEST']) {
    const e = refusal(mt(BASE.replace(':23B:CRED', `:23B:${code}`)));
    assert.deepEqual([e.code, e.field], ['invalid_field', '23B'], code);
    assert.ok(e.message.startsWith(`field 23B: "${code}" is not a bank operation code`), e.message);
  }
  for (const code of ['CRED', 'CRTS', 'SPAY', 'SPRI', 'SSTD']) {
    const p = parseSwiftMessage(mt(BASE.replace(':23B:CRED', `:23B:${code}`)));
    assert.deepEqual([p.bankOperationCode, p.test?.what], [code, code === 'CRTS' ? 'CRTS' : undefined]);
  }
});

test('a refusal in the second message of a file says which message it is, and comes before anything is read from the field', () => {
  const first = mt(BASE, `{3:{121:${UETR}}}`);
  const seconds: [string, string, string][] = [
    [mt(BASE.replace(':71A:SHA', ':71A:')), 'invalid_field', '71A'],
    [mt(BASE.replace(':32A:261117USD5,\n', ':32A:269999USD5,\n9999\n')), 'malformed_message', '32A'],
    [mt(BASE, `{3:{121:${UETR}}{121:${UETR}}}`), 'malformed_message', 'block 3 field 121'],
    [mt(BASE.replace(':32A:261117', ':32A:261131')), 'invalid_field', '32A'],
    [mt(BASE.replace(':23B:CRED', ':23B:crts')), 'invalid_field', '23B'],
    [mt(withField('59F', '/ACC1\n1/B\n3/SINGAPORE\n4/19800101')), 'invalid_field', '59F'],
    [mt(withField('59F', '/ACC1\n1/B\n3/SG\n4/19800101')), 'malformed_message', '59F'],
  ];
  for (const [second, code, field] of seconds) {
    const e = refusal(`${first}\n${second}`);
    assert.deepEqual([e.code, e.field], [code, field], second);
    assert.match(e.message, /^message 2 of 2: /);
  }
  // The second line under 32A is refused before its date is looked at: the field is not taken apart first.
  assert.match(refusal(`${first}\n${seconds[1]![0]}`).message, /^message 2 of 2: field 32A takes one line/);
});

test('follow-up mt: a space before the account slash does not turn the account into the name', () => {
  const mt = sample('mt103.sample.txt');
  const read = parseSwiftMessage(mt.replace(':59:/SG-ACC-000009', ':59: /SG-ACC-000009').replace(':50K:/VN-ACC-000777', ':50K:  /VN-ACC-000777'));
  assert.deepEqual([read.creditor.account, read.creditor.name, read.debtor.account, read.debtor.name],
    ['SG-ACC-000009', 'PACIFIC SUPPLY PTE LTD', 'VN-ACC-000777', 'VINA TRADING CO LTD']);
  // …and the message is the same payment as the one written without the space.
  assert.equal(swiftContentDigest(read), swiftContentDigest(parseSwiftMessage(mt)));
});
