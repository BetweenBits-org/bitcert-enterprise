// Prints label → a short form of each answer in the freshly generated answers file, to review.
import { readFileSync } from 'node:fs';
const src = readFileSync(process.argv[2]!, 'utf8');
const tables = ['XML', 'MESSAGES', 'TOKENS', 'ESCAPES', 'BYTES', 'REPEATED'];
const lit = /"((?:[^"\\]|\\.)*)"/g;
const unjava = (s: string): string => JSON.parse('"' + s.replace(/\\u([0-9A-F]{4})/g, (_, h) => '\\u' + h) + '"');
for (const t of tables) {
  const start = src.indexOf(`static final String[][] ${t} = {`);
  const end = src.indexOf('\n    };', start);
  const body = src.slice(start, end);
  const rows = body.split(/\n        \{/).slice(1);
  console.log(`== ${t} (${rows.length})`);
  for (const r of rows) {
    const parts = [...r.matchAll(lit)].map((m) => unjava(m[1]!));
    const label = parts[0]!;
    const ans = JSON.parse(parts[parts.length - 1]!);
    let short: string;
    if (ans.error) short = `✗ ${ans.error.code ?? ans.error.name} ${ans.error.field ?? ''} ${ans.error.message}`;
    else if (ans.payments) short = `✓ ${ans.payments.length} payment(s) ` + JSON.stringify(ans.payments.map((p: any) => ({ d: p.debtor?.name, cb: p.chargeBearer, test: p.test, inter: p.intermediaryAgents?.length ? p.intermediaryAgents : undefined, da: p.debtorAgent, ca: p.creditorAgent, mt: p.messageType }))).slice(0, 260);
    else if (ans.tokens) short = `tokens ${JSON.stringify(ans.tokens)}`;
    else if (ans.escaped !== undefined) short = `escaped ${JSON.stringify(ans.escaped)}`;
    else short = JSON.stringify(ans).slice(0, 200);
    if (process.argv[3] && !new RegExp(process.argv[3]).test(t + ' ' + label)) continue;
    console.log(`  ${JSON.stringify(label).slice(0, 90)} → ${short.slice(0, 330)}`);
  }
}
