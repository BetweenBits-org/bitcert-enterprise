/**
 * Inputs the golden vectors do not reach, grouped by the part of mt103.ts they
 * exercise. gen.ts runs each through the TypeScript SDK and writes the answers
 * into the Java test Mt103ReferenceTest.
 */
export interface Case { group: string; name: string; note: string; input: string }

const H = '{1:F01DEMOVNVXAXXX0000000000}{2:I103DEMOSGSGXXXXN}';
const UETR = '{3:{121:b4d9e7a1-5c36-4f82-a1d0-6e9f3c2b8a57}}';
const BASE = ':20:R\n:23B:CRED\n:32A:261117USD5,\n:50K:A\n:59:/ACC1\nB\n:71A:SHA\n';
const mt = (body: string, header = H): string => `${header}{4:\n${body}-}`;
/** The base text with one field's line replaced (or a field added before 59 / after 71A). */
const swap = (from: string, to: string): string => {
  if (!BASE.includes(from)) throw new Error(`no ${from} in the base text`);
  return BASE.replace(from, to);
};
const before59 = (extra: string): string => swap(':59:/ACC1\n', `${extra}:59:/ACC1\n`);
const after71A = (extra: string): string => `${BASE}${extra}`;
const withParty = (debtor: string, creditor = ':59:/ACC1\nB\n'): string =>
  BASE.replace(':50K:A\n', debtor).replace(':59:/ACC1\nB\n', creditor);

const cases: Case[] = [];
const add = (group: string, name: string, note: string, input: string): void => { cases.push({ group, name, note, input }); };

// ── splitting a file into messages and blocks ────────────────────────────────
add('split', 'bom-before-blocks', 'a byte-order mark before the first block of a string', `\uFEFF${mt(BASE)}`);
add('split', 'whitespace-before-blocks', 'whitespace before {1:', ` \r\n\t${mt(BASE)}`);
add('split', 'cr-only', 'old Mac line ends: a lone CR is a line end', mt(BASE).replace(/\n/g, '\r'));
add('split', 'block-3-nested', 'block 3 with several sub-blocks; an upper-case UETR', mt(BASE, `${H}{3:{108:MUR-1}{121:B4D9E7A1-5C36-4F82-A1D0-6E9F3C2B8A57}{119:STP}}`));
add('split', 'block-3-empty-121', 'an empty {121:} refuses the message: it is not "no UETR"', mt(BASE, `${H}{3:{121:}}`));
add('split', 'block-3-121-padded', 'spaces around the UETR', mt(BASE, `${H}{3:{121: b4d9e7a1-5c36-4f82-a1d0-6e9f3c2b8a57 }}`));
add('split', 'block-3-without-121', 'a block 3 without field 121', mt(BASE, `${H}{3:{108:MUR-1}}`));
add('split', 'block-3-empty', 'an empty block 3', mt(BASE, `${H}{3:}`));
add('split', 'block-1-not-closed', 'block 1 never closes', `{1:F01DEMOVNVXAXXX0000000000{2:I103DEMOSGSGXXXXN}{4:\n${BASE}-}`);
add('split', 'block-3-not-closed', 'block 3 never closes', `${H}{3:{121:b4d9e7a1-5c36-4f82-a1d0-6e9f3c2b8a57}{4:\n${BASE}-}`);
add('split', 'block-2-after-3', 'block 2 after block 3', mt(BASE, `{1:F01DEMOVNVXAXXX0000000000}${UETR}{2:I103DEMOSGSGXXXXN}`));
add('split', 'block-1-twice', 'block 1 twice', mt(BASE, '{1:F01DEMOVNVXAXXX0000000000}{1:F01DEMOVNVXAXXX0000000000}'));
add('split', 'no-text-block', 'header blocks and a trailer, no block 4', `${H}{5:{CHK:123456789ABC}}`);
add('split', 'no-end-marker', 'block 4 never ends', `${H}{4:\n${BASE}`);
add('split', 'end-marker-not-at-line-start', '"-}" that does not start a line is not the end', `${H}{4:\n${BASE}X-}`);
add('split', 'stray-text', 'text after a message that is not another message', `${mt(BASE)}\nstray text that goes on and on and on`);
add('split', 'stray-trailer-text', 'what is quoted has its whitespace collapsed', `${mt(BASE)}$\n{5:x}\t\tmore  text\nhere and more`);
add('split', 'trailers-then-next', 'trailer blocks with sub-blocks, a $, then the next message',
  `${mt(BASE)}{5:{CHK:8A1B2C3D4E5F}{TNG:}}{S:{SAC:}{COP:P}}$\r\n${mt(BASE.replace(':20:R\n', ':20:R2\n'))}`);
add('split', 'trailer-nested-twice', 'a trailer with a sub-block inside a sub-block is not a trailer', `${mt(BASE)}{5:{MAC:{X}}}`);
add('split', 'trailer-not-closed', 'a trailer that never closes', `${mt(BASE)}{5:{CHK:123}`);
add('split', 'trailer-other-letter', 'only {5:} and {S:} are trailers', `${mt(BASE)}{6:{CHK:123}}`);
add('split', 'dollars-at-the-end', '$ and whitespace after the last message', `${mt(BASE)}$$ \n$`);
add('split', 'whitespace-between-blocks', 'whitespace between the header blocks', `{1:F01DEMOVNVXAXXX0000000000}\n {2:I103DEMOSGSGXXXXN}\r\n${UETR}\t{4:\n${BASE}-}`);
add('split', 'text-block-on-one-line', 'block 4 starting on the line of {4:', `${H}{4::20:R\n${BASE.slice(BASE.indexOf(':23B:'))}-}`);
add('split', 'error-in-second-of-three', 'which message is at fault, and its code and field are kept',
  mt(BASE) + mt(BASE.replace(':32A:261117USD5,', ':32A:26111USD5,')) + mt(BASE));
add('split', 'missing-field-in-third-of-three', 'a missing field in the last message',
  mt(BASE) + mt(BASE) + mt(BASE.replace(':71A:SHA\n', '')));
add('split', 'second-is-mt202-with-field', 'the prefix keeps an error without a field',
  mt(BASE) + '{1:F01AAAAVNVXAXXX0000000000}{2:I202BBBBSGSGXXXXN}{4:\n:20:X\n-}');
add('split', 'uetr-bad-in-second', 'a UETR that is not a UUID, in message 2 of 2',
  mt(BASE) + mt(BASE, `${H}{3:{121:not-a-uuid-at-all}}`));

// ── the text block alone ─────────────────────────────────────────────────────
add('bare', 'dash-alone', 'a line of "-" ends the text', `${BASE}-\n`);
add('bare', 'dash-trailers-dollar', 'trailers, $ and whitespace after the end', `${BASE}-}{5:{CHK:123456789ABC}}\n$\n  `);
add('bare', 'text-after-dash', 'text right after the end marker', `${BASE}-}xyz`);
add('bare', 'nested-trailer', 'a trailer with nested sub-blocks after the end', `${BASE}-}{5:{A:{B}}}`);
add('bare', 'wrapper-with-spaces', '{4: followed by spaces and a line end', `{4: \t\n${BASE}-}`);
add('bare', 'wrapper-without-line-end', '{4: with the first field on its line', `{4::20:R\n${BASE.slice(BASE.indexOf(':23B:'))}-}`);
add('bare', 'wrapper-blank-lines', '{4: then blank lines', `{4:\n\n \n${BASE}-}`);
add('bare', 'leading-unicode-spaces', 'no-break and ideographic spaces before :20:', `\u00a0\u3000${BASE}`);
add('bare', 'end-in-the-middle', 'an end marker before the last field', BASE.replace(':71A:SHA\n', '-}\n:71A:SHA\n'));
add('bare', 'two-texts', 'two text blocks back to back', BASE + BASE);
add('bare', 'dash-text', 'a "-" followed by text is a line of text, not the end: here a second line under 71A', `${BASE}-X\n`);
add('bare', 'crlf-and-trailer', 'CRLF line ends, the end marker and a trailer', `${BASE}-}{5:{CHK:1}}`.replace(/\n/g, '\r\n'));
add('bare', 'bom-string', 'a byte-order mark before :20: in a string', `\uFEFF${BASE}`);

// ── the field lines ──────────────────────────────────────────────────────────
add('fields', 'text-before-first-field', 'a line of text before :20:', mt(`HELLO WORLD\n${BASE}`));
add('fields', 'long-text-before-first-field', 'quoted up to 40 characters', mt(`THIS LINE IS FAR TOO LONG TO BE QUOTED IN FULL IN AN ERROR\n${BASE}`));
add('fields', 'blank-lines-before-first-field', 'blank lines before :20: are passed over', mt(`\n   \n${BASE}`));
add('fields', 'line-separator-in-tag-line', 'U+2028 in the line of a tag', mt(swap(':50K:A\n', ':50K:A\u2028B\n')));
add('fields', 'next-line-in-values', 'U+0085 is text, not a line end and not whitespace', mt(swap(':20:R\n', ':20:R\u0085\n').replace('\nB\n', '\nB\u0085C\n')));
add('fields', 'indented-nbsp', 'a tag after a no-break space', mt(swap(':71A:SHA', '\u00a0:71A:SHA')));
add('fields', 'indented-lowercase', 'an indented tag with a lower-case letter', mt(swap(':71A:SHA', '  :71a:SHA')));
add('fields', 'indented-ideographic-space', 'a tag after an ideographic space', mt(swap(':71A:SHA', '\u3000:71A:SHA')));
add('fields', 'next-line-before-tag', 'U+0085 is not whitespace: the line is text of field 59', mt(swap(':71A:SHA', '\u0085:71A:SHA')));
add('fields', 'one-digit-tag', 'a tag of one digit', mt(swap(':71A:SHA', ':7:SHA')));
add('fields', 'three-digit-tag', 'a tag of three digits', mt(swap(':71A:SHA', ':711:SHA')));
add('fields', 'colon-text', 'a line of text that starts with ":"', mt(swap('\nB\n', '\n:B LTD\n')));
add('fields', 'trailing-blank-lines', 'blank lines at the end of a field', mt(swap('\nB\n', '\nB\n\n   \n')));
add('fields', 'declared-unknown-tag', 'a field of another type, block 2 present', mt(before59(':21:REL\n')));
add('fields', 'block-1-only-unknown-tag', 'block 1 alone does not state the type', mt(`${BASE}:21:X\n`, '{1:F01DEMOVNVXAXXX0000000000}'));
add('fields', 'headerless-no-32A', 'no 32A and no header: not an MT103', ':20:REF1\n:23B:CRED\n:50K:A CO\n:59:B LTD\n:71A:BEN\n');
add('fields', 'headerless-cut-short', 'has 32A, lacks 71A, no header', ':20:REF1\n:23B:CRED\n:32A:260105USD100,5\n:50K:A CO\n:59:/ACC9\nB LTD\n:70:/INV/INV-2026-04');
add('fields', 'declared-missing-23B', 'block 2 present, no 23B', mt(BASE.replace(':23B:CRED\n', '')));
add('fields', 'declared-missing-50', 'block 2 present, no ordering customer', mt(BASE.replace(':50K:A\n', '')));
add('fields', 'block-1-only-missing-20', 'block 1 alone, no 20', mt(BASE.replace(':20:R\n', ''), '{1:F01DEMOVNVXAXXX0000000000}'));
add('fields', 'block-1-only-no-32A', 'block 1 alone, no 32A', mt(BASE.replace(':32A:261117USD5,\n', ''), '{1:F01DEMOVNVXAXXX0000000000}'));
add('fields', 'repeatable', '13C, 23E and 71F may repeat', mt(after71A(':23E:SDVA\n:23E:INTC\n:13C:/SNDTIME/1249+0100\n:13C:/RNCTIME/1302+0100\n:71F:USD1,\n:71F:EUR2,\n:71G:USD3,\n')));
add('fields', 'two-forms-50', '50K and 50A', mt(before59(':50A:DEMOVNVX\n')));
add('fields', 'two-forms-52', '52A and 52D', mt(before59(':52A:DEMOVNVX\n:52D:DEMO BANK\n')));
add('fields', 'twice-77B', '77B twice', mt(after71A(':77B:/ORDERRES/VN\n:77B:/BENEFRES/SG\n')));
add('fields', 'twice-56A', '56A twice', mt(before59(':56A:AAAAUS33\n:56A:BBBBUS33\n')));
add('fields', 'twice-71G', '71G twice (only 71F repeats)', mt(after71A(':71G:USD1,\n:71G:USD2,\n')));
add('fields', 'every-field', 'every MT103 field once, in the order given',
  mt(':20:R\n:13C:/SNDTIME/1249+0100\n:23B:CRED\n:23E:SDVA\n:26T:K90\n:32A:261117USD5,\n:33B:USD5,\n:36:1,\n'
    + ':50K:A\n:51A:DEMOVNVX\n:52A:DEMOVNVX\n:53A:DEMOUS33\n:54A:AAAAUS33\n:55A:BBBBUS33\n:56A:CCCCUS3N\n:57A:DEMOSGSG\n'
    + ':59:/ACC1\nB\n:70:/INV/I1\n:71A:SHA\n:71F:USD1,\n:71G:USD1,\n:72:/INS/DEMOVNVX\n:77B:/ORDERRES/VN\n:77T:/NARR/X\n'));

// ── the parties ──────────────────────────────────────────────────────────────
add('parties', '50K-qualified-account', '/C/ is part of the account in 50K: the marks are the institution fields\' alone', mt(withParty(':50K:/C/12345\nA CO\n')));
add('parties', '50K-double-slash', 'a second slash is part of the account: //SC123 is the account /SC123', mt(withParty(':50K://SC123\nA CO\nSTREET\n')));
add('parties', '50K-account-only', 'an account and nothing else', mt(withParty(':50K:/ACC\n')));
add('parties', '50K-slash-only', 'a "/" with no account', mt(withParty(':50K:/\nA CO\n')));
add('parties', '50K-padded-account', 'spaces around and inside the account', mt(withParty(':50K:/  ACC 1  \nA CO\n')));
add('parties', '50K-account-not-first', 'an account on the second line is an address line', mt(withParty(':50K:A CO\n/ACC\n')));
add('parties', '59-unicode-spaces', 'no-break, ideographic and em spaces around lines are trimmed', mt(withParty(':50K:A\n', ':59:/ACC1\n\u00a0B LTD\u00a0\n\u3000ADDR\u2003\n')));
add('parties', '59-next-line-padding', 'U+0085 around a line is not trimmed', mt(withParty(':50K:A\n', ':59:/ACC1\n\u0085B LTD\u0085\n')));
add('parties', '59-mongolian-vowel-separator', 'U+180E is not whitespace', mt(withParty(':50K:A\n', ':59:/ACC1\n\u180eB\n')));
add('parties', '59-bom-padding', 'U+FEFF around a line is trimmed', mt(withParty(':50K:A\n', ':59:/ACC1\n\ufeffB\ufeff\n')));
add('parties', '50A-59A', 'option A: account and BIC', mt(withParty(':50A:/VN-1\nDEMOVNVX\n', ':59A:/SG-1\nDEMOSGSG\n')));
add('parties', '50A-without-account', 'option A: a BIC alone', mt(withParty(':50A:DEMOVNVX\n')));
add('parties', '50F-personal-document', 'a passport number as the party identifier, birth date and place', mt(withParty(':50F:CCPT/VN/C1234567\n1/NGUYEN VAN A\n2/1 STREET\n3/VN/HANOI\n4/19800101\n5/VN/HANOI\n')));
add('parties', '50F-continued', 'a second 3/ continues the address, 8/ continues the identifier', mt(withParty(':50F:TXID/VN/0790123456\n1/A CO\n3/VN/HO CHI MINH CITY\n3/700000\n8/78\n')));
add('parties', '50F-national-id', '7/ is a national identity number, 8/ continues it', mt(withParty(':50F:/ACC\n1/A\n7/VN/012345678901\n8/99\n')));
add('parties', '50F-empty-6-then-6', 'an empty 6/ is replaced by the next', mt(withParty(':50F:/ACC\n1/A\n6/\n6/VN/GDT/123\n8/45\n')));
add('parties', '50F-identifier-then-6', 'after the identifier of the first line a 6/ is not read, and 8/ continues nothing', mt(withParty(':50F:TXID/VN/111\n1/A\n6/VN/GDT/222\n8/333\n')));
add('parties', '50F-6-without-issuer', '6/ with fewer parts than usual', mt(withParty(':50F:/ACC\n1/A\n6/VN\n')));
add('parties', '50F-not-numbered', 'a line without a number', mt(withParty(':50F:/ACC\nNGUYEN VAN A\n2/STREET\n')));
add('parties', '50F-long-not-numbered', 'quoted up to 35 characters', mt(withParty(':50F:/ACC\n1/A\nTHIS LINE HAS NO NUMBER AND IS RATHER LONG\n')));
add('parties', '50F-nine', '9/ is not a line number', mt(withParty(':50F:/ACC\n1/A\n9/X\n')));
add('parties', '59F-bad-country', 'a country code in lower case refuses the message', mt(withParty(':50K:A\n', ':59F:/ACC\n1/B\n3/Sg/SINGAPORE\n')));
add('parties', '59F-country-only', '3/ with a country and no town', mt(withParty(':50K:A\n', ':59F:/ACC\n1/B\n3/SG\n')));
add('parties', '59F-empty-first-3', 'an empty first 3/ refuses the message: it names no country', mt(withParty(':50K:A\n', ':59F:/ACC\n1/B\n3/\n3/SG/X\n')));
add('parties', '50F-numbered-first-line', 'no account or identifier: the first line is numbered', mt(withParty(':50F:1/A CO\n2/STREET\n3/VN/HCMC\n')));
add('parties', '50F-names-joined', 'several 1/ lines are one name; an empty one adds nothing', mt(withParty(':50F:/ACC\n1/A\n1/B\n1/\n')));
add('parties', '50F-identifier-slashes', 'an identifier that is only slashes', mt(withParty(':50F:TXID/VN//\n1/A\n')));
add('parties', '50F-identifier-lower-case', 'a lower-case code is not an identifier', mt(withParty(':50F:txid/VN/123\n1/A\n')));
add('parties', '50F-account-padded', 'an account line with spaces', mt(withParty(':50F:  /  ACC  \n1/A\n')));
add('parties', '50F-blank-numbered-lines', 'blank lines between numbered lines', mt(withParty(':50F:/ACC\n\n1/A\n  \n2/B\n')));
add('parties', '77B-does-not-override', 'a country stated in 3/ stays; 77B fills the other party', mt(after71A(':77B:/ORDERRES/TH//X\n/BENEFRES/SG\n').replace(':50K:A\n', ':50F:/ACC\n1/A\n3/VN\n')));
add('parties', '77B-word-boundary', 'a residence code must end at a non-word character', mt(after71A(':77B:/ORDERRES/VNX /ORDERRES/VN1 /ORDERRES/TH-\n/BENEFRES/SG_ /BENEFRES/MY\n')));
add('parties', '77B-non-ascii-after', 'a non-ASCII letter after the code ends the word, as in the reference', mt(after71A(':77B:/ORDERRES/VN\u00c4\n/BENEFRES/SG\u00e9\n')));
add('parties', '77B-lines-joined', 'the lines of 77B are joined with spaces', mt(after71A(':77B:/ORDERRES/VN\n//MORE\n\n/BENEFRES/SG\n')));

// ── the banks ────────────────────────────────────────────────────────────────
add('agents', '52D-name', 'option D: the first line after the account is the name', mt(before59(':52D:/12345\nDEMO BANK VN\nHANOI\n')));
add('agents', '52A-qualified-account', 'option A with /C/account: the BIC', mt(before59(':52A:/C/12345\nDEMOVNVX\n')));
add('agents', '57C-clearing-code', 'option C with //', mt(before59(':57C://SC123456\n')));
add('agents', '57C-account', 'option C with /account', mt(before59(':57C:/123456789\n')));
add('agents', '57C-indented-account', 'a space before the account of option C: the clearing code is still read', mt(before59(':57C: /123456789\n')));
add('agents', '57A-clearing-code', 'option A with a clearing code', mt(before59(':57A://FW123456789\nAAAAUS33\n')));
add('agents', '57D-empty-clearing-code', '"//" with nothing after it names no clearing code: the name alone', mt(before59(':57D://\nPAYOUT BANK\n')));
add('agents', '57D-only-slashes', 'nothing but "//": no clearing code, the receiver stands in', mt(before59(':57D://\n')));
add('agents', '52A-empty', 'an empty 52A refuses the message', mt(before59(':52A:\n')));
add('agents', '57B', 'option B is not read: the receiver stands in', mt(before59(':57B:/ACC\nLOCATION\n')));
add('agents', '56C', 'an intermediary by clearing code', mt(before59(':56C://CH123456\n')));
add('agents', '56D', 'an intermediary by name', mt(before59(':56D:INTERMEDIARY BANK\nNEW YORK\n')));
add('agents', '56A-empty', 'an empty intermediary refuses the message', mt(before59(':56A:\n')));
add('agents', '52D-account-only', 'option D with only an account', mt(before59(':52D:/12345\n')));

// ── field 70 ─────────────────────────────────────────────────────────────────
add('remittance', 'guide-example', 'two invoices under one code word, then /ROC/', mt(before59('').replace(':71A:SHA\n', ':70:/RFB/BET072\n/INV/abc/SDF-96//1234-234///ROC/98IU87\n:71A:SHA\n')));
const with70 = (text: string): string => mt(BASE.replace(':71A:SHA\n', `:70:${text}\n:71A:SHA\n`));
add('remittance', 'continued-line', 'a line that starts with "//" continues the one before', with70('/INV/INV-2026-\n//0475\n/ROC/PO-1'));
add('remittance', 'roc-before-inv', '/ROC/ followed straight by /INV/ has no value, and does not take the invoice for one', with70('/ROC//INV/X'));
add('remittance', 'roc-trailing-slash', 'a trailing slash is not part of the reference', with70('/ROC/REF-1/'));
add('remittance', 'roc-empty', '/ROC/ with nothing after it', with70('/ROC/'));
add('remittance', 'roc-space', '/ROC/ with a space before the next code word', with70('/ROC/ /INV/A'));
add('remittance', 'many-invoices', 'invoices on two lines', with70('/INV/A//B\n/INV/C/'));
add('remittance', 'free-text', 'no code word', with70('SPARE PARTS'));
add('remittance', 'other-code-words', 'every code word ends a reference', with70('/IPI/X/INV/Y/TSU/Z/INV/W/RFB/V'));
add('remittance', 'line-separator', 'U+2028 inside a reference; at its end it is trimmed', with70('X\n/INV/A\u2028B\n/ROC/C\u2028'));
add('remittance', 'blank-lines', 'blank lines are left out', with70('\n/INV/A\n\n'));
add('remittance', 'inv-twice-same', 'the same invoice twice is kept twice', with70('/INV/A\n/INV/A'));

// ── amounts, charges, codes ──────────────────────────────────────────────────
const f = (from: string, to: string): string => mt(swap(from, to));
add('values', '71A-bad', 'not OUR, SHA or BEN', f(':71A:SHA', ':71A:XYZ'));
add('values', '71A-empty', 'an empty 71A refuses the message: it is not "no charges code"', f(':71A:SHA', ':71A:'));
add('values', '71A-lower-case', 'sha in lower case', f(':71A:SHA', ':71A:sha'));
add('values', '71A-ben', 'BEN', f(':71A:SHA', ':71A: BEN '));
add('values', '32A-short-date', 'five digits of date', f(':32A:261117USD5,', ':32A:26111USD5,'));
add('values', '32A-bad-amount', 'two commas', f(':32A:261117USD5,', ':32A:261117USD1,2,3'));
add('values', '32A-year-85', 'a year from 80 is in the 1900s', f(':32A:261117USD5,', ':32A:850101USD5,'));
add('values', '32A-year-79', 'a year below 80 is in the 2000s', f(':32A:261117USD5,', ':32A:790101USD5,'));
add('values', '32A-padded', 'spaces around the value', f(':32A:261117USD5,', ':32A:  261117USD5,  '));
add('values', '32A-lower-case-currency', 'usd', f(':32A:261117USD5,', ':32A:261117usd5,'));
add('values', '32A-too-long', 'sixteen digits', f(':32A:261117USD5,', ':32A:261117USD1234567890123456,'));
add('values', '32A-no-comma', 'an amount without a decimal comma', f(':32A:261117USD5,', ':32A:261117USD5'));
add('values', '32A-leading-zeros', 'leading zeros and decimals', f(':32A:261117USD5,', ':32A:261117USD0005,10'));
add('values', '32A-impossible-date', 'month 99 is not a calendar date', f(':32A:261117USD5,', ':32A:269999USD5,'));
add('values', '32A-on-next-line', 'the value on the line after the tag is a second line under a one-line field', f(':32A:261117USD5,', ':32A:\n261117USD5,'));
add('values', '33B-bad', 'a currency without an amount', mt(before59(':33B:USD\n')));
add('values', '33B-empty', 'an empty 33B refuses the message: it is not "no instructed amount"', mt(before59(':33B:\n')));
add('values', '33B-other-currency', 'the instructed amount is the amount', mt(before59(':33B:EUR4,5\n')));
add('values', '33B-bad-amount', 'too many digits', mt(before59(':33B:USD1234567890123456,\n')));
add('values', '36-comma', 'an exchange rate', mt(before59(':36:1,2345\n')));
add('values', '36-trailing-comma', 'a rate written "1,"', mt(before59(':36:1,\n')));
add('values', '36-comma-and-dot', 'a full stop as well as the comma is not a rate', mt(before59(':36:0,9.\n')));
add('values', '36-two-commas', 'two commas are not a rate', mt(before59(':36:1,2,3\n')));
add('values', '26T', 'the transaction type code', mt(before59(':26T:K90\n')));
add('values', '26T-empty', 'an empty 26T refuses the message', mt(before59(':26T:\n')));
add('values', '23B-empty', 'an empty 23B refuses the message', f(':23B:CRED', ':23B:'));
add('values', '23B-padded-crts', 'CRTS with spaces is still CRTS', f(':23B:CRED', ':23B: CRTS '));
add('values', '71F-71G', 'charges in order: every 71F, then every 71G', mt(after71A(':71G:USD3,\n:71F:USD1,\n:71F: EUR2, \n')));
add('values', '20-padded', 'the reference is trimmed', f(':20:R', ':20:  R 1  '));

// ── header blocks ────────────────────────────────────────────────────────────
add('header', 'output', 'an output message: block 1 is the receiver', mt(BASE, '{1:F01RCVRSGSGAXXX0000000000}{2:O1031200261117SNDRVNVXAXXX00000000002611171201N}'));
add('header', 'output-training', 'a test and training BIC as the sender of an output message', mt(BASE, '{1:F01RCVRSGSGAXXX0000000000}{2:O1031200261117SNDRVNV0AXXX00000000002611171201N}'));
add('header', 'branch-codes', 'branch codes in the logical terminals', mt(BASE, '{1:F01DEMOVNVXA123000000000}{2:I103DEMOSGSGXHCMN}'));
add('header', 'lower-case-lt', 'a logical terminal in lower case is not a BIC', mt(BASE, '{1:F01demovnvxAXXX0000000000}{2:I103DEMOSGSGXXXXN}'));
add('header', 'short-block-1', 'a block 1 too short to hold a terminal', mt(BASE, '{1:F01DEMO}{2:I103DEMOSGSGXXXXN}'));
add('header', 'empty-block-1', 'an empty block 1', mt(BASE, '{1:}{2:I103DEMOSGSGXXXXN}'));
add('header', 'block-2-no-type', 'block 2 without I or O', mt(BASE, '{1:F01DEMOVNVXAXXX0000000000}{2:X103DEMOSGSGXXXXN}'));
add('header', 'block-2-empty', 'an empty block 2', mt(BASE, '{1:F01DEMOVNVXAXXX0000000000}{2:}'));
add('header', 'block-2-letter-in-type', 'a letter in the type', mt(BASE, '{1:F01DEMOVNVXAXXX0000000000}{2:I10ADEMOSGSGXXXXN}'));
add('header', 'training-receiver', 'a test and training BIC as the receiver', mt(BASE, '{1:F01DEMOVNVXAXXX0000000000}{2:I103DEMOSGS0XXXXN}'));
add('header', 'training-and-crts', 'CRTS is named before a training BIC', mt(swap(':23B:CRED', ':23B:CRTS'), '{1:F01DEMOVNV0AXXX0000000000}{2:I103DEMOSGSGXXXXN}'));
add('header', 'block-2-short', 'block 2 with nothing after the type', mt(BASE, '{1:F01DEMOVNVXAXXX0000000000}{2:I103}'));
add('header', 'output-202', 'an output MT202', mt(BASE, '{1:F01RCVRSGSGAXXX0000000000}{2:O2021200261117SNDRVNVXAXXX00000000002611171201N}'));
add('header', 'agents-stated', '52A and 57A win over the header', mt(before59(':52A:OTHRVNVX\n:57A:OTHRSGSG\n'), '{1:F01DEMOVNVXAXXX0000000000}{2:I103DEMOSGSGXXXXN}'));
add('header', 'no-header-no-agents', 'the text block alone names no bank', BASE);
add('header', 'uetr-in-wrong-block', 'a {121:} outside block 3 is not the UETR', `${mt(BASE, `${H}{3:{108:X}}`)}{5:{121:b4d9e7a1-5c36-4f82-a1d0-6e9f3c2b8a57}}`);

add('bare', 'dash-then-text', 'after a line of "-" nothing but trailers may follow', `${BASE}-\n:20:SECOND\n`);
add('parties', '50F-birth-date', '4/ alone marks a person', mt(withParty(':50F:/ACC\n1/A\n4/19800101\n')));
add('parties', '50F-birth-place', '5/ alone marks a person', mt(withParty(':50F:/ACC\n1/A\n5/VN/HANOI\n')));
add('parties', '50F-7-after-6', 'a 7/ after a 6/ marks a person and keeps the 6/ identifier', mt(withParty(':50F:/ACC\n1/A\n6/VN/GDT/1\n7/VN/2\n8/3\n')));
add('parties', '59F-person-lines', 'lines 4/ to 8/ are 50F\'s: in 59F they refuse the message', mt(withParty(':50K:A\n', ':59F:/ACC\n1/B\n4/19800101\n6/SG/X/9\n')));
add('values', '32A-continued', 'a second line under 32A refuses the message', f(':32A:261117USD5,', ':32A:261117USD5,\n9999'));
add('agents', '52D-only-slashes', '"//" alone names no clearing code: the sender stands in', mt(before59(':52D://\n')));
add('header', 'block-3-two-uetrs', 'two {121:} in block 3 refuse the message: a payment has one UETR', mt(BASE, `${H}{3:{121:b4d9e7a1-5c36-4f82-a1d0-6e9f3c2b8a57}{121:0b5f6c1e-2a47-4c3d-9e8f-7a6b5c4d3e2f}}`));
add('remittance', 'inv-empty-before-roc', 'an empty /INV/ followed straight by /ROC/', with70('/INV//ROC/X'));
add('values', '71A-extra-line', 'a second line under 71A refuses the message', f(':71A:SHA', ':71A:SHA\nOUR'));
add('values', '20-extra-line', 'a second line under 20 refuses the message', f(':20:R', ':20:R\nMORE'));
add('split', 'second-without-end', 'a split error is not prefixed with the message number', mt(BASE) + `${H}{4:\n${BASE}`);
add('split', 'first-without-end', 'the end marker of the next message ends the first', `${H}{4:\n${BASE}${mt(BASE)}`);

// ── which of two faults is named ─────────────────────────────────────────────
add('order', '32A-and-71A', 'both 32A and 71A are wrong', mt(swap(':32A:261117USD5,', ':32A:X').replace(':71A:SHA', ':71A:XYZ')));
add('order', '32A-and-33B', 'both 32A and 33B are wrong', mt(before59(':33B:X\n').replace(':32A:261117USD5,', ':32A:X')));
add('order', '50F-and-59F', 'both structured parties are wrong', mt(withParty(':50F:/ACC\nX\n', ':59F:/ACC\nY\n')));
add('order', '59F-and-71A', 'the beneficiary before the charges', mt(withParty(':50K:A\n', ':59F:/ACC\nY\n').replace(':71A:SHA', ':71A:XYZ')));
add('order', '71A-and-uetr', 'the charges before the UETR', mt(swap(':71A:SHA', ':71A:XYZ'), `${H}{3:{121:not-a-uuid}}`));
add('order', 'twice-then-unknown', 'a field twice, then one of another type', mt(before59(':32A:261117USD6,\n:21:X\n')));
add('order', 'unknown-then-twice', 'a field of another type, then one twice', mt(before59(':21:X\n:32A:261117USD6,\n')));
add('order', 'type-then-fields', 'block 2 is read before the fields', mt(`${BASE}:21:X\n`, '{1:F01DEMOVNVXAXXX0000000000}{2:I202DEMOSGSGXXXXN}'));
add('order', 'missing-then-32A', 'a missing field before a malformed 32A', mt(swap(':32A:261117USD5,', ':32A:X').replace(':71A:SHA\n', '')));
add('order', 'twice-then-missing', 'a field twice before a missing one', mt(BASE.replace(':59:/ACC1\nB\n', ':20:R2\n')));
add('order', 'missing-order', 'several missing: the first of the list', mt(':50K:A\n:59:B\n'));
add('order', 'text-before-field-then-bad-tag', 'the field lines are read top down', mt(`X\n:7:Y\n${BASE}`));
add('order', 'bad-tag-then-indented', 'a bad tag before an indented one', mt(`${BASE} :70:X\n:7:Y\n`));

// ── is it an MT at all ───────────────────────────────────────────────────────
add('dispatch', 'starts-with-21', 'a text block must start with :20:', `:21:X\n${BASE}`);
add('dispatch', 'starts-with-block-2', 'a message must start with block 1', mt(BASE, '{2:I103DEMOSGSGXXXXN}'));
add('dispatch', 'wrapper-blank-lines-before-20', '{4: then blank lines then :20:', `{4:\n\n${BASE}-}`);
add('dispatch', 'next-line-before-20', 'U+0085 is not whitespace', `\u0085${BASE}`);
add('dispatch', 'zero-width-space-before-20', 'U+200B is not whitespace', `\u200b${BASE}`);
add('dispatch', 'nbsp-before-block-1', 'U+00A0 is whitespace', `\u00a0${mt(BASE)}`);
add('dispatch', 'bom-and-spaces-before-wrapper', 'a byte-order mark and spaces before {4:', `\uFEFF  {4:\n${BASE}-}`);

// ── the hardening (M1–M16 and the follow-up): inputs the golden vectors do not reach ──
const UUID = 'b4d9e7a1-5c36-4f82-a1d0-6e9f3c2b8a57';

// M1 field 70: a code word with nothing after it has no value, and the next code word is read on its own.
add('remittance', 'roc-empty-then-roc-next-line', 'an empty /ROC/ does not hide one on the next line', with70('/ROC/\n/ROC/PO-1'));
add('remittance', 'roc-slash-then-roc', 'a /ROC/ holding only a slash has no value: the next one is the reference', with70('/ROC///ROC/X'));
add('remittance', 'roc-spaces-then-roc', 'a /ROC/ holding only spaces has no value', with70('/ROC/   /ROC/X'));
add('remittance', 'roc-ideographic-space-then-invoice', 'an ideographic space is trimmed away: no value', with70('/ROC/\u3000/INV/A'));
add('remittance', 'roc-next-line-char-then-invoice', 'U+0085 is not trimmed: it is the value', with70('/ROC/\u0085/INV/A'));
add('remittance', 'roc-two-values', 'of two that say something, the first is the reference', with70('/ROC/A/ROC/B'));
add('remittance', 'roc-many-empty', 'forty empty code words, then one with a value', with70(`${'/ROC/'.repeat(40)}LAST`));
add('remittance', 'roc-double-slash-first', 'what comes before the first "//" is the reference: here nothing, so the next /ROC/ is read', with70('/ROC///A/ROC/B'));

// M2 a field the standard writes on one line has no second.
add('values', '23B-second-line-long', 'the line that follows is quoted up to 35 characters', f(':23B:CRED', ':23B:CRED\nTHIS SECOND LINE IS LONGER THAN THIRTY-FIVE CHARACTERS'));
add('values', '32A-second-line-padded', 'no-break spaces around the second line are trimmed from the quote', f(':32A:261117USD5,', ':32A:261117USD5,\n\u00a09999\u00a0'));
add('values', '32A-unicode-blank-lines-after', 'lines of no-break, ideographic and tab spaces after the value are blank', f(':32A:261117USD5,', ':32A:261117USD5,\n\u00a0\u3000\n\t'));
add('values', '32A-ideographic-space-line-then-second-line', 'a line of an ideographic space is blank: the second line is the one after it', f(':32A:261117USD5,', ':32A:261117USD5,\n\u3000\n9999'));
add('values', '71A-next-line-char-after', 'a line holding U+0085 is not blank: it is a second line', f(':71A:SHA', ':71A:SHA\n\u0085'));
add('values', '71F-continued', 'a second line under 71F refuses the message', mt(after71A(':71F:USD1,\nMORE\n')));
add('fields', '13C-and-23E-two-lines', '13C and 23E are not read, and are not checked for a second line', mt(after71A(':13C:/SNDTIME/1249+0100\nX\n:23E:SDVA\nY\n')));
add('agents', '57C-empty-after-tag-then-code', 'the code on the line after the tag is a second line under 57C', mt(before59(':57C:\n//SC123456\n')));

// M3 block 3: field 121 once at most.
add('header', 'block-3-121-twice-first-empty', 'two {121:} are refused as two, before the empty one is looked at', mt(BASE, `${H}{3:{121:}{121:${UUID}}}`));
add('header', 'block-3-121-twice-not-uuids', 'two {121:} are refused as two, before either is read as a UUID', mt(BASE, `${H}{3:{121:xyz}{121:xyz}}`));
add('header', 'block-3-121-inside-a-sub-block', 'a {121:} inside another sub-block counts too', mt(BASE, `${H}{3:{108:{121:${UUID}}}{121:${UUID}}}`));

// M4 a field that is read carries a value.
add('values', '20-unicode-spaces-only', 'a value of ideographic and no-break spaces is empty', f(':20:R', ':20:\u3000\u00a0'));
add('values', '71A-next-line-char-only', 'U+0085 is not white space: the field is not empty, and it is no charges code', f(':71A:SHA', ':71A:\u0085'));
add('split', 'block-3-121-spaces-only', 'a {121:} of spaces is empty', mt(BASE, `${H}{3:{121:  \u3000}}`));
add('bare', 'empty-71A-without-headers', 'an empty field refuses a text block alone too', BASE.replace(':71A:SHA', ':71A:'));
add('fields', '72-and-77T-empty', 'an empty field the reader takes nothing from is passed over', mt(after71A(':72:\n:77T:\n')));

// M5 the value date is a day of the calendar; field 36 is a rate.
add('values', '32A-29-february-1996', 'a leap year of the 1900s', f(':32A:261117USD5,', ':32A:960229USD5,'));
add('values', '32A-29-february-2079', 'not a leap year', f(':32A:261117USD5,', ':32A:790229USD5,'));
add('values', '32A-bad-date-and-bad-amount', 'the date is checked before the amount', f(':32A:261117USD5,', ':32A:261131USD1234567890123456,'));
add('values', '36-next-line-char', 'U+0085 after the rate: a $ that took it for a line end would read it', mt(before59(':36:1,5\u0085\n')));
add('values', '36-full-width-digits', 'digits of another script are not digits of a rate', mt(before59(':36:\uff11,\uff15\n')));
add('values', '36-padded', 'spaces around the rate are trimmed', mt(before59(':36: 1,25 \n')));
add('values', '36-long', 'quoted up to 35 characters', mt(before59(`:36:${'1'.repeat(40)},\n`)));

// M6 "//" alone names no clearing code.
add('agents', '56A-double-slash-only', '"//" alone names no intermediary', mt(before59(':56A://\n')));
add('agents', '57A-double-slash-then-bic', '"//" then a BIC: the BIC alone', mt(before59(':57A://\nAAAAUS33\n')));
add('agents', '52D-double-slash-and-spaces', '"//" and spaces name no clearing code: the sender stands in', mt(before59(':52D://   \n')));

// M7 the first line of an institution field is read once, trimmed.
add('agents', '57C-no-break-space-before-slash', 'a no-break space before the slash of option C is trimmed', mt(before59(':57C:\u00a0/123456789\n')));
add('agents', '57C-space-before-double-slash', 'a space before the "//" of option C', mt(before59(':57C: //SC123456\n')));
add('agents', '57D-space-before-account', 'option D: a space before the account, the name after it', mt(before59(':57D: /12345\nPAYOUT BANK\n')));
add('agents', '57C-next-line-char-before-slash', 'U+0085 is not trimmed: no account, no clearing code, the receiver stands in', mt(before59(':57C:\u0085/123456789\n')));

// M9 option F: an empty name or address line adds nothing.
add('parties', '50F-blank-name-line-unicode', 'a 1/ of ideographic spaces adds nothing to the name', mt(withParty(':50F:/ACC\n1/\u3000\n1/A\n')));
add('parties', '50F-only-empty-lines', 'empty 1/ and 2/ lines: no name, no address', mt(withParty(':50F:/ACC\n1/\n2/\n3/VN\n')));

// M10 59F has the lines 1/, 2/ and 3/, and an account on its first line.
add('parties', '59F-nine', 'a line numbered 9/ in 59F: the numbers it lists run to 3/', mt(withParty(':50K:A\n', ':59F:/ACC\n1/B\n9/X\n')));
add('parties', '59F-line-4-then-bad-country', 'line by line: a 4/ before a bad first 3/ is named first', mt(withParty(':50K:A\n', ':59F:/ACC\n1/B\n4/19800101\n3/sg\n')));
add('parties', '59F-long-line-6', 'quoted up to 35 characters', mt(withParty(':50K:A\n', ':59F:/ACC\n1/B\n6/SG/ACRA/2019123456789012345678901234567890\n')));
add('parties', '59F-numbered-first-line', 'no account: the first line of 59F is a numbered line', mt(withParty(':50K:A\n', ':59F:1/B\n3/SG\n')));

// M13 in 50a and 59a the account is everything after the first slash.
add('parties', '50A-double-slash', 'option A: "//" starts an account too', mt(withParty(':50A://CH123\nDEMOVNVX\n')));
add('parties', '59A-slash-only', 'option A: a "/" alone is no account', mt(withParty(':50K:A\n', ':59A:/\nDEMOSGSG\n')));
add('parties', '50K-slash-and-spaces', 'a "/" and spaces are no account', mt(withParty(':50K:/   \nA CO\n')));
add('agents', '57A-debit-mark', 'option A with /D/account: the BIC', mt(before59(':57A:/D/12345\nAAAAUS33\n')));
add('agents', '57C-lower-case-mark', 'only a capital C or D mark comes off', mt(before59(':57C:/c/123\n')));
add('agents', '57C-mark-only', 'a mark with no account names no clearing code: the receiver stands in', mt(before59(':57C:/C/\n')));

// M14 the first 3/ line starts with the country code.
add('parties', '59F-country-next-line-char', 'U+0085 after the country: a $ that took it for a line end would read it', mt(withParty(':50K:A\n', ':59F:/ACC\n1/B\n3/SG\u0085\n')));
add('parties', '59F-space-after-the-number', 'a space between 3/ and the country is trimmed', mt(withParty(':50K:A\n', ':59F:/ACC\n1/B\n3/ SG/SINGAPORE\n')));
add('parties', '50F-long-country-line', 'quoted up to 35 characters', mt(withParty(':50F:/ACC\n1/A\n3/VIET NAM/HO CHI MINH CITY/DISTRICT 1\n')));
add('parties', '59F-later-3-not-checked', 'a later 3/ continues the address and is not checked', mt(withParty(':50K:A\n', ':59F:/ACC\n1/B\n3/SG/X\n3/sg\n')));
add('parties', '50F-country-before-name', 'the country line may come before the name', mt(withParty(':50F:/ACC\n3/VN/HANOI\n1/A\n')));

// M16 23B exactly as the standard writes it.
add('values', '23B-long', 'quoted up to 35 characters', f(':23B:CRED', `:23B:${'X'.repeat(40)}`));
add('values', '23B-no-break-spaces-crts', 'no-break spaces around CRTS are trimmed: a test', f(':23B:CRED', ':23B:\u00a0CRTS\u00a0'));
add('values', '23B-next-line-char', 'U+0085 after the code is part of it', f(':23B:CRED', ':23B:CRTS\u0085'));
add('header', 'training-bic-and-bad-23B', 'a test and training BIC does not excuse a 23B written wrongly', mt(swap(':23B:CRED', ':23B:crts'), '{1:F01DEMOVNV0AXXX0000000000}{2:I103DEMOSGSGXXXXN}'));

// Which check comes first, and "message N of M".
add('order', 'empty-20-then-unknown-tag', 'every tag is checked before any value', mt(BASE.replace(':20:R', ':20:').replace(':71A:SHA\n', ':71A:SHA\n:21:X\n')));
add('order', 'missing-71A-and-empty-20', 'a missing field before an empty one', mt(BASE.replace(':20:R', ':20:').replace(':71A:SHA\n', '')));
add('order', 'empty-20-and-32A-second-line', 'field by field, in the order of the message', mt(BASE.replace(':20:R', ':20:').replace(':32A:261117USD5,', ':32A:261117USD5,\n9')));
add('order', '32A-second-line-and-empty-71A', 'the field that comes first is named', mt(BASE.replace(':32A:261117USD5,', ':32A:261117USD5,\n9').replace(':71A:SHA', ':71A:')));
add('order', '32A-date-and-33B', 'the value date before the instructed amount', mt(before59(':33B:X\n').replace(':32A:261117', ':32A:261131')));
add('order', '33B-and-50F-country', 'the instructed amount before the ordering customer', mt(withParty(':33B:X\n:50F:/ACC\n1/A\n3/vn\n')));
add('order', '50F-country-and-59F-line-4', 'the ordering customer before the beneficiary', mt(withParty(':50F:/ACC\n1/A\n3/vn\n', ':59F:/ACC\n1/B\n4/19800101\n')));
add('order', '71A-and-121-twice', 'the charges code before block 3', mt(swap(':71A:SHA', ':71A:XYZ'), `${H}{3:{121:${UUID}}{121:${UUID}}}`));
add('order', '121-empty-and-23B', 'block 3 before the bank operation code', mt(swap(':23B:CRED', ':23B:crts'), `${H}{3:{121:}}`));
add('order', 'uetr-and-23B', 'a UETR that is not a UUID before the bank operation code', mt(swap(':23B:CRED', ':23B:crts'), `${H}{3:{121:not-a-uuid}}`));
add('order', '23B-and-36', 'the bank operation code before the rate', mt(before59(':36:1.5\n').replace(':23B:CRED', ':23B:crts')));
add('order', '71A-and-36', 'the charges code before the rate', mt(before59(':36:1.5\n').replace(':71A:SHA', ':71A:XYZ')));
add('split', 'second-121-empty', 'an empty UETR in message 2 of 2', mt(BASE) + mt(BASE, `${H}{3:{121:}}`));
add('split', 'first-of-two-20-empty', 'an empty field in message 1 of 2', mt(BASE.replace(':20:R', ':20:')) + mt(BASE));
add('split', 'third-of-three-36-bad', 'a rate that is not one, in message 3 of 3', mt(BASE) + mt(BASE) + mt(before59(':36:1.5\n')));
add('split', 'second-of-two-59F-line-5', 'a line 59F does not have, in message 2 of 2', mt(BASE) + mt(withParty(':50K:A\n', ':59F:/ACC\n1/B\n5/SG/SINGAPORE\n')));

// Quotes are cut in UTF-16 units, and $ is the end of the text.
add('values', '23B-long-astral-cut', 'quoted up to 35 UTF-16 units: an emoji across the cut is cut in two, as in the reference', f(':23B:CRED', `:23B:${'X'.repeat(34)}\u{1F600}`));
add('values', '32A-second-line-astral-cut', 'the quoted second line is cut in UTF-16 units too', f(':32A:261117USD5,', `:32A:261117USD5,\n${'9'.repeat(34)}\u{1F600}`));
add('remittance', 'roc-ends-in-next-line-char', 'U+0085 at the end of the text is part of the reference: a $ that took it for a line end would leave it out', with70('/ROC/A\u0085'));

// The follow-up: the first line of 50a and 59a is read trimmed.
add('parties', '59-ideographic-space-before-slash', 'an ideographic space before the account slash is trimmed', mt(withParty(':50K:A\n', ':59:\u3000/ACC1\nB\n')));
add('parties', '50K-tab-before-slash', 'a tab before the account slash', mt(withParty(':50K:\t/VN-1\nA\n')));
add('parties', '59A-space-before-slash', 'option A: a space before the account slash', mt(withParty(':50K:A\n', ':59A: /SG-1\nDEMOSGSG\n')));
add('parties', '50K-next-line-char-before-slash', 'U+0085 is not trimmed: the line is the name, not an account', mt(withParty(':50K:\u0085/VN-1\nA\n')));

export default cases;
