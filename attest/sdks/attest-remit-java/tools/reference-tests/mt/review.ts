import { parseSwiftMessages, SwiftMessageError } from '../../../../../packages/attest-remit/src/index.ts';
import cases from './cases.ts';
const only = process.argv[2];
for (const c of cases) {
  if (only && c.group !== only) continue;
  try {
    const all = parseSwiftMessages(c.input);
    const view = all.map((p) => {
      const o: Record<string, unknown> = { ...p };
      for (const k of ['format', 'messageType', 'digest', 'messageId', 'otherDocuments']) delete o[k];
      if (o.index === 0) delete o.index;
      if (o.transactionCount === 1) delete o.transactionCount;
      if (o.valueDate === '2026-11-17') delete o.valueDate;
      if (JSON.stringify(o.amount) === '{"currency":"USD","value":"5"}') delete o.amount;
      if (JSON.stringify(o.settlementAmount) === '{"currency":"USD","value":"5"}') delete o.settlementAmount;
      if (o.distinctIds === true) delete o.distinctIds;
      if (o.bankOperationCode === 'CRED') delete o.bankOperationCode;
      if (o.chargeBearer === 'SHAR') delete o.chargeBearer;
      for (const k of ['charges', 'intermediaryAgents', 'remittanceInformation', 'invoiceReferences', 'regulatoryReporting']) if (Array.isArray(o[k]) && (o[k] as unknown[]).length === 0) delete o[k];
      return o;
    });
    console.log(`${c.group}/${c.name}: OK ${JSON.stringify(view)}`);
  } catch (e) {
    if (!(e instanceof SwiftMessageError)) throw e;
    console.log(`${c.group}/${c.name}: ERR ${e.code} [${e.field ?? ''}] ${JSON.stringify(e.message)}`);
  }
}
