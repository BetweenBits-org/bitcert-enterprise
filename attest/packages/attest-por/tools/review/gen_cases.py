"""Random ledgers for the differential test. Deterministic from the seed given on the command line."""
import json, random, sys, string

rnd = random.Random(int(sys.argv[2]) if len(sys.argv) > 2 else 20261117)
N_CASES = int(sys.argv[1]) if len(sys.argv) > 1 else 340

FIRST = string.ascii_letters + string.digits
REST = FIRST + '._-'
FIXED_SYMBOLS = ['BTC', 'ETH', 'USDT', 'btc', 'Btc', 'bTC', '1INCH', '1000SATS', 'BTC.b', 'USD-C', 'wBTC', 'stETH', 'a', 'A', 'Z', 'z',
                 '0', '1', '9', '10', '007', '42', '1e3', 'A_B', 'A-B', 'A.B', 'AB', 'ABC', 'ab', 'USDT.e', 'BRC-20', 'T001', 'T010', 'T100',
                 '4294967295', '4294967296', '00', '01', 'x' * 32, 'Z' + '9' * 31, 'a.b-c_d', 'A1', 'B2', 'C3', 'D4', 'E5', '2', '3', '11', '100']


def rand_symbol():
    n = rnd.choice([1, 2, 3, 3, 4, 4, 5, 6, 8, 12, 32])
    return rnd.choice(FIRST) + ''.join(rnd.choice(REST) for _ in range(n - 1))


def symbols(k):
    out = []
    seen = set()
    pool = FIXED_SYMBOLS[:]
    rnd.shuffle(pool)
    while len(out) < k:
        s = pool.pop() if pool and rnd.random() < 0.45 else rand_symbol()
        if s in seen:
            continue
        seen.add(s)
        out.append(s)
    return out


REF_PARTS = ['김민수', '이서연', '😀', '𝒜𝒷𝒸', 'é', 'é', 'مستخدم', '用户', 'ユーザー', 'Ω', 'ß', 'ǅ', ' ', ' ', '　', '"', '\\', ',', ';', "'",
             ' ', '/', '<', '&', '%', '#', 'İ', 'ı', '﻿', '퟿', '', '￿', '\U0001F600', '\U0010FFFF']
SPECIAL_REFS = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', 'prototype', '0', '1', '-1', 'null', 'undefined', 'NaN',
                'a' * 256, '가' * 85, '😀' * 64, 'kim, 민수', '00000000-0000-4000-8000-000000000001', 'user@example.com', 'U-100001']


def rand_ref(i):
    kind = rnd.random()
    if kind < 0.35:
        return 'U-%06d' % (100000 + i)
    if kind < 0.5:
        return 'acct-%05d-%s' % (i, rnd.choice(REF_PARTS))
    if kind < 0.8:
        n = rnd.randint(1, 12)
        s = ''.join(rnd.choice(REF_PARTS + list(string.ascii_letters + string.digits)) for _ in range(n)) + str(i)
        s = s.strip()
        return 'x' + s  # never starts with whitespace; ends with a digit
    return '%s#%d' % (rnd.choice(REF_PARTS[:12]), i)


def rand_value():
    digits = rnd.choice([1, 1, 2, 3, 5, 8, 8, 9, 12, 18, 19, 20, 24, 30, 38, 40, 41])
    if digits == 41:
        return 10 ** 40
    lo = 10 ** (digits - 1)
    hi = 10 ** digits - 1
    return rnd.randint(max(1, lo), hi)


def pick_n():
    r = rnd.random()
    if r < 0.15:
        return rnd.randint(1, 8)
    if r < 0.40:
        k = rnd.randint(0, 8)
        return max(1, min(400, 2 ** k + rnd.choice([-1, 0, 0, 1, 1])))
    return rnd.randint(1, 400)


def make_case(cid, n=None, n_assets=None, mode=None):
    n = n or pick_n()
    n_assets = n_assets or rnd.choice([1, 1, 2, 3, 3, 5, 8, 20, 50, 100, 150, rnd.randint(1, 150), rnd.randint(1, 150), rnd.randint(1, 150)])
    assets = symbols(n_assets)
    mode = mode or rnd.choice(['sparse', 'sparse', 'sparse', 'zeros', 'zeros', 'dense-zero', 'all-empty', 'all-explicit-zero', 'full', 'mixed'])
    refs = []
    seen = set()
    specials = SPECIAL_REFS[:]
    rnd.shuffle(specials)
    for i in range(n):
        while True:
            ref = specials.pop() if specials and rnd.random() < 0.03 else rand_ref(i)
            if ref not in seen and len(ref.encode('utf-8')) <= 256:
                break
        seen.add(ref)
        refs.append(ref)
    rows = []
    for i, ref in enumerate(refs):
        bal = {}
        if mode == 'all-empty':
            pass
        elif mode == 'all-explicit-zero':
            for a in rnd.sample(assets, rnd.randint(0, len(assets))):
                bal[a] = '0'
        elif mode == 'full':
            for a in assets:
                bal[a] = str(rand_value())
        else:
            k = rnd.randint(0, min(8, len(assets)))
            if rnd.random() < 0.12:
                k = 0
            for a in rnd.sample(assets, k):
                bal[a] = str(rand_value())
            if mode == 'zeros' or (mode == 'mixed' and rnd.random() < 0.5):
                others = [a for a in assets if a not in bal]
                for a in rnd.sample(others, rnd.randint(0, min(len(others), 6))):
                    bal[a] = '0'
            elif mode == 'dense-zero':
                for a in assets:
                    bal.setdefault(a, '0')
            # the order in which a row names its assets is arbitrary
            items = list(bal.items())
            rnd.shuffle(items)
            bal = dict(items)
        rows.append({'user_ref': ref, 'balances': bal})
    return {
        'id': cid, 'mode': mode,
        'exchange_id': rnd.choice(['KR-EX-0a1b2c', 'EX', '한빛-거래소', 'KR-EX-' + ''.join(rnd.choice('0123456789abcdef') for _ in range(6))]),
        'seed_hex': bytes(rnd.getrandbits(8) for _ in range(32)).hex(),
        'assets': assets, 'rows': rows,
        'prove': sorted(set(rnd.randrange(n) for _ in range(4)) | {0, n - 1}),
    }


out = sys.stdout
cid = 0
# fixed shapes first
for n in [1, 2, 3, 4, 5, 7, 8, 9, 15, 16, 17, 31, 32, 33, 63, 64, 65, 127, 128, 129, 255, 256, 257, 400]:
    for mode in ['sparse', 'zeros']:
        out.write(json.dumps(make_case(cid, n=n, mode=mode), ensure_ascii=False) + '\n'); cid += 1
for mode in ['all-empty', 'all-explicit-zero', 'full', 'dense-zero']:
    for n in [1, 2, 3, 6, 100]:
        out.write(json.dumps(make_case(cid, n=n, mode=mode), ensure_ascii=False) + '\n'); cid += 1
while cid < N_CASES:
    out.write(json.dumps(make_case(cid), ensure_ascii=False) + '\n'); cid += 1
