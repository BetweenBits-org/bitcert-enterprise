import { parseSwiftMessages, SwiftMessageError } from '../../../../../packages/attest-remit/src/index.ts';
import type { SwiftPayment } from '../../../../../packages/attest-remit/src/index.ts';
import { looksLikeMt } from '../../../../../packages/attest-remit/src/swift/mt103.ts';
const MESSAGE = '{1:F01DEMOVNVXAXXX0000000000}{2:I103DEMOSGSGXXXXN}{4:\n:20:R\n:23B:CRED\n:32A:261117USD5,\n:50K:A\n:59:/ACC1\nB\n:71A:SHA\n-}';
const BARE = ':20:REF1\n:23B:CRED\n:32A:260105USD100,5\n:50K:A CO\n:59:/ACC9\nB LTD\n:71A:BEN\n';
const show = (label: string, input: string) => {
  const t0 = performance.now();
  try {
    const all = parseSwiftMessages(input);
    const p = all[all.length - 1]!;
    console.log(label, 'OK', all.length, all[0]!.instructionId, p.index, p.transactionCount, p.instructionId, p.distinctIds, JSON.stringify(p.remittanceInformation).length, JSON.stringify(p.invoiceReferences).slice(0, 60), Math.round(performance.now() - t0) + 'ms');
  } catch (e) {
    if (!(e instanceof SwiftMessageError)) throw e;
    console.log(label, 'ERR', e.code, e.field, JSON.stringify(e.message.slice(0, 300)));
  }
};
show('spaces', MESSAGE + ' '.repeat(4_000_000));
show('crlf-padding', MESSAGE + '\r\n'.repeat(2_000_000));
show('long-trailer', MESSAGE + '{5:' + 'x'.repeat(4_000_000) + '}');
show('many-trailers', MESSAGE + '{5:{CHK:1}}'.repeat(300_000));
show('bare-padding', BARE + '-}' + ' '.repeat(4_000_000) + '{5:{CHK:1}}');
show('bare-padding-dollars', BARE + '-}' + ' $'.repeat(2_000_000));
show('bare-long-trailer', BARE + '-}{S:' + '{A:1}'.repeat(500_000) + '}');
show('long-trailer-then-text', MESSAGE + '{5:' + 'x'.repeat(1_000_000) + '}' + 'tail');
show('bare-long-trailer-then-text', BARE + '-}{5:' + 'x'.repeat(1_000_000) + '}tail');
const many = Array.from({ length: 3000 }, (_, i) => MESSAGE.replace(':20:R\n', `:20:R${i}\n`)).join('$\r\n');
show('many', many);
const same = Array.from({ length: 3000 }, () => MESSAGE).join('');
show('many-same', same);
// Under the 4 MiB bound in UTF-8 bytes (5 bytes a pair): 3,000,000 bytes, 1,800,000 UTF-16 units.
const mixed = 'a😀'.repeat(600_000);
show('mixed-70-over-the-bound', MESSAGE.replace(':71A:SHA', `:70:/INV/${'a😀'.repeat(1_000_000)}\n:71A:SHA`));
show('mixed-70', MESSAGE.replace(':71A:SHA', `:70:/INV/${mixed}\n:71A:SHA`));
show('long-name', MESSAGE.replace('\nB\n', `\n${'N'.repeat(3_000_000)}\n`));
show('many-lines', MESSAGE.replace('\nB\n', `\nB\n${'ADDRESS LINE\n'.repeat(250_000)}`));
show('many-fields', MESSAGE.replace(':71A:SHA', `:71A:SHA${'\n:23E:SDVA'.repeat(300_000)}`));
show('error-in-last', Array.from({ length: 2999 }, () => MESSAGE).join('') + MESSAGE.replace(':71A:SHA', ':71A:XYZ'));
// The hardening: the new checks on large inputs.
const roc = (p: SwiftPayment | undefined) => p?.endToEndId;
const showE2e = (label: string, input: string) => {
  const t0 = performance.now();
  try {
    const all = parseSwiftMessages(input);
    console.log(label, 'OK', all.length, JSON.stringify(roc(all[0])), JSON.stringify(all[0]!.invoiceReferences).slice(0, 60), Math.round(performance.now() - t0) + 'ms');
  } catch (e) {
    if (!(e instanceof SwiftMessageError)) throw e;
    console.log(label, 'ERR', e.code, e.field, JSON.stringify(e.message.slice(0, 300)), Math.round(performance.now() - t0) + 'ms');
  }
};
showE2e('many-empty-roc', MESSAGE.replace(':71A:SHA', `:70:${'/ROC/'.repeat(400_000)}X\n:71A:SHA`));
showE2e('many-empty-roc-lines', MESSAGE.replace(':71A:SHA', `:70:${'/ROC/\n'.repeat(300_000)}/ROC/X\n:71A:SHA`));
showE2e('roc-long-slashes', MESSAGE.replace(':71A:SHA', `:70:/ROC/${'/'.repeat(2_000_000)}\n:71A:SHA`));
showE2e('many-121', MESSAGE.replace('{4:', `{3:${'{121:x}'.repeat(500_000)}}{4:`));
showE2e('blank-lines-then-second-line', MESSAGE.replace(':32A:261117USD5,', `:32A:261117USD5,${'\n'.repeat(1_000_000)}9999`));
showE2e('blank-lines-in-empty-field', MESSAGE.replace(':71A:SHA', `:70:${'\n'.repeat(1_000_000)}:71A:SHA`));
showE2e('59F-many-empty-name-lines', MESSAGE.replace(':59:/ACC1\nB\n', `:59F:/ACC1\n${'1/\n'.repeat(500_000)}1/B\n3/SG\n`));
for (const t of ['{1:', ' \n{1:', '﻿{1:', '﻿﻿ :20:', ':20:', '{4:\n:20:', '{4: \t\r\n :20:', '{4::20:', ' {4:\n\n:20:', '{2:', ':21:', '{4:\n:21:', '\u0085:20:', '​{1:', '　 {1:', 'x{1:', '{5:']) {
  console.log('looksLikeMt', JSON.stringify(t), looksLikeMt(t));
}
