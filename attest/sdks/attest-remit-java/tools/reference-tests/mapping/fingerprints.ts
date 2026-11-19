// Fingerprints of the reference's complete answer for each hand-written mapping case:
// sha256(JSON.stringify({ fields, issues, unmapped, input? }) + "\n" + (SwiftMappingError message or "")).
import { createHash } from 'node:crypto';
import { mapSwiftPayment, SwiftMappingError } from '../../../../../packages/attest-remit/src/index.ts';
import { mappingCases, payment } from './expect.ts';
for (const [name, b, patch, options] of mappingCases) {
  const m = mapSwiftPayment(payment(b, patch), JSON.parse(options));
  const json = JSON.stringify({ fields: m.fields, issues: m.issues, unmapped: m.unmapped, ...(m.input ? { input: m.input } : {}) });
  const error = m.issues.length ? new SwiftMappingError(m).message : '';
  console.log(`{${JSON.stringify(name)}, ${JSON.stringify(b)}, ${JSON.stringify(patch)}, ${JSON.stringify(options)}, "${createHash('sha256').update(json + '\n' + error).digest('hex')}"},`);
}
