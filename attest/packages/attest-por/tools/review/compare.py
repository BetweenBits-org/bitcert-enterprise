"""Compares what ts-run.mjs wrote with the independent implementation in pytree.py. See ts-run.mjs for how to run."""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pytree
cases = {}
with open(sys.argv[1] + '/cases.jsonl') as f:
    for line in f:
        if line.strip():
            c = json.loads(line); cases[c['id']] = c
mismatch = []; compared = 0; proofs = 0; errors = {'ts': 0, 'py': 0}
with open(sys.argv[1] + '/ts-out.jsonl') as f:
    for line in f:
        t = json.loads(line); c = cases[t['id']]
        seed = bytes.fromhex(c['seed_hex'])
        for name, algo in (('v1', 1), ('v2', 2)):
            try:
                p = pytree.build(c['exchange_id'], seed, c['rows'], c['assets'], algo); perr = None
            except Exception as e:
                p = None; perr = repr(e)
            ts = t[name]
            if 'error' in ts or p is None:
                errors['ts'] += 'error' in ts; errors['py'] += p is None
                if ('error' in ts) != (p is None): mismatch.append((t['id'], name, 'one side refused', ts.get('error'), perr))
                continue
            compared += 1
            if ts['root'] != p['root']: mismatch.append((t['id'], name, 'root')); continue
            if ts['totals'] != p['totals']: mismatch.append((t['id'], name, 'totals'))
            if ts['levels'] != [[h.hex() for h, _ in lvl] for lvl in p['levels']]: mismatch.append((t['id'], name, 'level hashes'))
            if ts['order'] != [ref for _, ref in p['order']]: mismatch.append((t['id'], name, 'leaf order'))
            for proof in ts['proofs']:
                proofs += 1
                ok, problems = pytree.verify(proof, p['root'], p['totals'])
                if not ok: mismatch.append((t['id'], name, 'TS proof fails the independent verifier', problems))
                # and the independent prover's siblings are the ones TS wrote
                mine = pytree.prove(p, proof['leaf_index'])
                if mine['siblings'] != proof['siblings']: mismatch.append((t['id'], name, 'siblings differ'))
                if mine['written'] != proof['leaf']['balances']: mismatch.append((t['id'], name, 'leaf balances differ'))
result = {'trees_compared': compared, 'proofs_checked': proofs, 'refused': errors, 'mismatches': len(mismatch), 'first': mismatch[:6]}
print(json.dumps(result, ensure_ascii=False))
sys.exit(0 if not mismatch and compared > 0 else 1)
