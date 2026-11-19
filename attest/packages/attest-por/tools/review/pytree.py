"""Independent re-implementation of the PoR sum tree (v1 and v2), from the written rules only.
Nothing is imported from the TypeScript SDK. hashlib/hmac are the only crypto used."""
import hashlib, hmac

LEAF = b"STONEHASH-POR-LEAF-V1\n"
NODE = b"STONEHASH-POR-NODE-V1\n"
EMPTY = b"STONEHASH-POR-EMPTY-V1"
USER = "STONEHASH-POR-USER-V1\n"


def sha(b: bytes) -> bytes:
    return hashlib.sha256(b).digest()


def jstr(s: str) -> str:
    out = ['"']
    for ch in s:
        c = ord(ch)
        if ch == '"':
            out.append('\\"')
        elif ch == '\\':
            out.append('\\\\')
        elif c == 0x08:
            out.append('\\b')
        elif c == 0x09:
            out.append('\\t')
        elif c == 0x0A:
            out.append('\\n')
        elif c == 0x0C:
            out.append('\\f')
        elif c == 0x0D:
            out.append('\\r')
        elif c < 0x20:
            out.append('\\u%04x' % c)
        else:
            out.append(ch)
    out.append('"')
    return ''.join(out)


def u16(s: str) -> bytes:
    # big-endian UTF-16 bytes order exactly as UTF-16 code units do
    return s.encode('utf-16-be')


def jcs_flat_text(d: dict) -> str:
    """d: str -> int (written as decimal strings)."""
    keys = sorted(d.keys(), key=u16)
    return '{' + ','.join(jstr(k) + ':' + jstr(str(d[k])) for k in keys) + '}'


def jcs_flat(d: dict) -> bytes:
    return jcs_flat_text(d).encode('utf-8')


def user_ref_hash(exchange_id: str, user_ref: str) -> bytes:
    return sha((USER + exchange_id + "\n" + user_ref).encode('utf-8'))


def salt_of(seed: bytes, user_ref: str) -> bytes:
    return hmac.new(seed, user_ref.encode('utf-8'), hashlib.sha256).digest()


def written_leaf(balances: dict, assets: list, algo: int) -> dict:
    """balances: str -> int."""
    if algo == 1:
        return {a: balances.get(a, 0) for a in assets}
    return {k: v for k, v in balances.items() if v != 0}


def add(a: dict, b: dict, algo: int) -> dict:
    out = {}
    for k in set(a) | set(b):
        out[k] = a.get(k, 0) + b.get(k, 0)
    if algo == 2:
        assert all(v != 0 for v in out.values())
    return out


def build(exchange_id: str, seed: bytes, rows: list, assets: list, algo: int):
    """rows: [{'user_ref': str, 'balances': {asset: decimal string}}]
    Returns dict(root, totals, levels) where levels[d] = [(hash_hex, sums_dict)] as STORED (padded)."""
    if not rows:
        raise ValueError('empty ledger')
    leaves = []
    seen = set()
    for r in rows:
        ref = r['user_ref']
        urh = user_ref_hash(exchange_id, ref)
        if urh in seen:
            raise ValueError('duplicate user_ref_hash')
        seen.add(urh)
        bal = {k: int(v) for k, v in r['balances'].items()}
        for k, v in bal.items():
            assert v >= 0
            assert k in assets, 'unlisted asset'
        w = written_leaf(bal, assets, algo)
        h = sha(LEAF + salt_of(seed, ref) + urh + jcs_flat(w))
        leaves.append((urh.hex(), ref, h, w))
    leaves.sort(key=lambda t: t[0])
    empty = (sha(EMPTY), ({a: 0 for a in assets} if algo == 1 else {}))
    level = [(h, w) for (_, _, h, w) in leaves]
    levels = []
    while len(level) > 1:
        if len(level) % 2 == 1:
            level = level + [empty]
        levels.append(level)
        nxt = []
        for i in range(0, len(level), 2):
            (lh, ls), (rh, rs) = level[i], level[i + 1]
            nxt.append((sha(NODE + lh + rh + jcs_flat(ls) + jcs_flat(rs)), add(ls, rs, algo)))
        level = nxt
    levels.append(level)
    root_h, root_s = level[0]
    totals = {a: root_s.get(a, 0) for a in assets}
    for k in root_s:
        assert k in assets
    return {
        'root': root_h.hex(),
        'totals': {a: str(v) for a, v in totals.items()},
        'levels': levels,
        'order': [(u, ref) for (u, ref, _, _) in leaves],
        'leaves': leaves,
    }


def prove(tree, index: int):
    sibs = []
    at = index
    for d in range(len(tree['levels']) - 1):
        lvl = tree['levels'][d]
        s = at ^ 1
        h, sums = lvl[s]
        sibs.append({'hash': h.hex(), 'sums': {k: str(v) for k, v in sums.items()}, 'dir': 'left' if s < at else 'right'})
        at //= 2
    urh, ref, h, w = tree['leaves'][index]
    return {'leaf_index': index, 'siblings': sibs, 'written': {k: str(v) for k, v in w.items()}, 'user_ref_hash': urh}


def verify(proof: dict, root: str, totals: dict):
    """Independent verification per SPEC section 5. Returns (ok, problems)."""
    import re
    INT = re.compile(r'^(0|[1-9][0-9]*)$')
    HEX = re.compile(r'^[0-9a-f]{64}$')
    problems = []
    leaf = proof['leaf']
    for k, v in leaf['balances'].items():
        if not isinstance(v, str) or not INT.match(v):
            return False, ['bad leaf balance']
    if not HEX.match(leaf['salt']) or not HEX.match(leaf['user_ref_hash']):
        return False, ['bad leaf hex']
    bal = {k: int(v) for k, v in leaf['balances'].items()}
    h = sha(LEAF + bytes.fromhex(leaf['salt']) + bytes.fromhex(leaf['user_ref_hash']) + jcs_flat(bal))
    sums = dict(bal)
    idx = proof['leaf_index']
    for level, sib in enumerate(proof['siblings']):
        if not HEX.match(sib['hash']):
            problems.append('sibling hash'); continue
        if any((not isinstance(v, str)) or (not INT.match(v)) for v in sib['sums'].values()):
            problems.append('sibling sums'); continue
        ss = {k: int(v) for k, v in sib['sums'].items()}
        bit = (idx >> level) & 1
        if (sib['dir'] == 'left') != (bit == 1):
            problems.append('dir contradicts index')
        sh = bytes.fromhex(sib['hash'])
        if sib['dir'] == 'left':
            h = sha(NODE + sh + h + jcs_flat(ss) + jcs_flat(sums))
        else:
            h = sha(NODE + h + sh + jcs_flat(sums) + jcs_flat(ss))
        merged = {}
        for k in set(ss) | set(sums):
            merged[k] = ss.get(k, 0) + sums.get(k, 0)
        sums = merged
    if h.hex() != root:
        problems.append('root mismatch')
    for k in set(sums) | set(totals):
        if str(sums.get(k, 0)) != totals.get(k, '0'):
            problems.append('total mismatch ' + k)
    return (len(problems) == 0), problems
