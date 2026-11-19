package com.stonehash.attest.por;

import java.math.BigInteger;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;

/** The tree, its proofs and their verification. The vectors themselves are run by {@link Conformance}. */
final class TreeTest {
    private TreeTest() {
    }

    /** A ledger of {@code n} accounts with uneven balances, some of them zero and some beyond 64 bits. */
    private static Ledger ledger(int n, long shuffleSeed) {
        List<Integer> order = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            order.add(i);
        }
        Collections.shuffle(order, new Random(shuffleSeed));
        LedgerBuilder ledger = new LedgerBuilder(Sample.assets(), AmountUnit.BASE);
        for (int i : order) {
            ledger.add("acct-" + i, "BTC", String.valueOf(i * 7919L));
            if (i % 3 != 0) {
                ledger.add("acct-" + i, "ETH", BigInteger.TEN.pow(i % 25).multiply(BigInteger.valueOf(i + 1)).toString());
            }
            if (i % 4 == 1) {
                ledger.add("acct-" + i, "USDT", "0");
            }
        }
        return ledger.finish();
    }

    static void testEveryLeafOfEveryShapeProvesAgainstRootAndTotals() {
        for (int n = 1; n <= 40; n++) {
            Ledger ledger = ledger(n, n);
            PorTree tree = PorTree.build(Sample.EXCHANGE, Sample.seed(), ledger);
            Check.equal(n, tree.leafCount(), "leaf count");
            Check.equal(ledger.report().totals(), tree.totals(), "the totals are the plain sum of the ledger; padding adds nothing");
            String previous = "";
            for (int i = 0; i < n; i++) {
                InclusionProof proof = tree.prove(i);
                ProofVerification v = proof.verify(tree.root(), tree.totals());
                Check.isTrue(v.ok(), n + " accounts, leaf " + i + ": " + v.problems());
                Check.equal(tree.root(), v.computedRoot(), "computed root");
                Check.equal(tree.levels() - 1, proof.siblings().size(), "one sibling per level below the root");
                Check.isTrue(proof.leaf().userRefHash().compareTo(previous) > 0, "leaves ascend by hashed reference");
                previous = proof.leaf().userRefHash();
                Check.equal(i, tree.indexOf(tree.userRef(i)), "lookup by reference");
                Check.isTrue(InclusionProof.parse(proof.toJson()).verify(tree.root(), tree.totals()).ok(), "survives its JSON form");
                Check.equal(proof.toMap(), InclusionProof.fromMap(proof.toMap()).toMap(), "and its form as a parsed value");
            }
        }
    }

    static void testTheRootIsAFunctionOfTheLedgerAloneNotOfRowOrder() {
        PorTree a = PorTree.build(Sample.EXCHANGE, Sample.seed(), ledger(50, 1));
        PorTree b = PorTree.build(Sample.EXCHANGE, Sample.seed(), ledger(50, 2));
        Check.equal(a.root(), b.root(), "same ledger, another order");
        Check.equal(a.totals(), b.totals(), "totals");
        byte[] otherSeed = Sample.seed();
        otherSeed[0] ^= 1;
        Check.isTrue(!a.root().equals(PorTree.build(Sample.EXCHANGE, otherSeed, ledger(50, 1)).root()), "another seed, another root");
        Check.isTrue(!a.root().equals(PorTree.build("KR-EX-other", Sample.seed(), ledger(50, 1)).root()), "another exchange, another root");
    }

    static void testWhatCannotBeATreeIsRefused() {
        // An empty ledger is itself a ledger with a problem (no_accounts), and so is one with a single refused row.
        Check.refuses("ledger_has_problems", () -> PorTree.build(Sample.EXCHANGE, Sample.seed(), new LedgerBuilder(Sample.assets(), AmountUnit.BASE).finish()));
        LedgerBuilder bad = new LedgerBuilder(Sample.assets(), AmountUnit.BASE);
        bad.add("u1", "BTC", "1");
        bad.add("u2", "BTC", "-1");
        PorException e = Check.refuses("ledger_has_problems", () -> PorTree.build(Sample.EXCHANGE, Sample.seed(), bad.finish()));
        Check.isTrue(e.getMessage().contains("1 problem;"), e.getMessage());
        Check.refuses("invalid_seed", () -> PorTree.build(Sample.EXCHANGE, new byte[16], ledger(2, 0)));
        Check.refuses("invalid_exchange", () -> PorTree.build("", Sample.seed(), ledger(2, 0)));
        Check.refuses("invalid_exchange", () -> PorTree.build("KR\nEX", Sample.seed(), ledger(2, 0)));

        String hash = "ab".repeat(32);
        Map<String, BigInteger> one = Collections.singletonMap("BTC", BigInteger.ONE);
        List<String> assets = Arrays.asList("BTC", "ETH");
        Check.refuses("empty_ledger", () -> PorTree.builder(Sample.EXCHANGE, assets).build());
        Check.refuses("duplicate_leaf", () -> PorTree.builder(Sample.EXCHANGE, assets)
                .addLeaf("u1", hash, "cd".repeat(32), one).addLeaf("u2", hash, "ef".repeat(32), one).build());
        // A negative leaf is the classic way to fake solvency.
        Check.refuses("invalid_leaf", () -> PorTree.builder(Sample.EXCHANGE, assets)
                .addLeaf("u1", hash, hash, Collections.singletonMap("BTC", BigInteger.ONE.negate())));
        Check.refuses("invalid_leaf", () -> PorTree.builder(Sample.EXCHANGE, assets)
                .addLeaf("u1", hash, hash, Collections.singletonMap("DOGE", BigInteger.ONE)));
        Check.refuses("invalid_leaf", () -> PorTree.builder(Sample.EXCHANGE, assets).addLeaf("u1", hash.toUpperCase(), hash, one));
        Check.refuses("invalid_leaf", () -> PorTree.builder(Sample.EXCHANGE, assets).addLeaf("u1", hash, "short", one));
        Check.refuses("invalid_asset", () -> PorTree.builder(Sample.EXCHANGE, Collections.emptyList()));
        Check.refuses("out_of_range", () -> Sample.tree().prove(12));
        Check.refuses("out_of_range", () -> Sample.tree().prove(-1));
        Check.refuses("unknown_account", () -> Sample.tree().proveAccount("nobody"));
    }

    static void testAnOpeningNeverCarriesTheAccountReferenceAndACustomersProofDoes() {
        PorTree tree = Sample.tree();
        Check.equal(Sample.ROOT, tree.root(), "the sample root");
        InclusionProof opening = tree.prove(3);
        Check.equal(null, opening.leaf().userRef(), "an opening is pseudonymous");
        Check.isTrue(!opening.toJson().contains("user_ref\""), "and its JSON has no such member");
        InclusionProof own = tree.proveAccount("U-100008");
        Check.equal(3, own.leafIndex(), "U-100008 is leaf 3");
        Check.equal("U-100008", own.leaf().userRef(), "the customer's proof names the customer");
        Check.equal(opening.toMap(), own.withoutUserRef().toMap(), "stripped, it is the opening");
        Check.equal(-1, tree.indexOf("U-999999"), "an unknown account");
        Check.equal(-1, tree.indexOf("half\ud83d"), "text with no encoding names no account");
    }

    static void testATreeReadBackFindsAccountsByTheirStoredReference() {
        // Hashes that are not the standard derivation: the stored reference is the authority.
        PorTree.Builder builder = PorTree.builder(Sample.EXCHANGE, Arrays.asList("BTC", "ETH"));
        for (int i = 0; i < 9; i++) {
            builder.addLeaf("ref-" + i, String.format("%064x", 1000 - i), String.format("%064x", i),
                    Collections.singletonMap("ETH", BigInteger.valueOf(i)));
        }
        PorTree tree = builder.build();
        Check.equal(9, tree.leafCount(), "leaves");
        Check.equal("ref-8", tree.userRef(0), "sorted by the stored hash");
        Check.equal(8, tree.indexOf("ref-0"), "found by reference");
        Check.equal("{BTC=0, ETH=36}", tree.totals().toString(), "totals, every asset present");
        Check.isTrue(tree.proveAccount("ref-4").verify(tree.root(), tree.totals()).ok(), "its proofs verify");
    }

    static void testATamperedProofFailsAndSaysWhere() throws Exception {
        PorTree tree = Sample.tree();
        Map<String, BigInteger> totals = tree.totals();
        String json = tree.prove(5).toJson();
        Check.isTrue(InclusionProof.parse(json).verify(tree.root(), totals).ok(), "untouched, it verifies");

        Check.isTrue(!InclusionProof.parse(json.replace("\"leaf_index\": 5", "\"leaf_index\": 4")).verify(tree.root(), totals).ok(),
                "a proof cannot be replayed at another position");
        Check.isTrue(InclusionProof.parse(json.replace("\"leaf_index\": 5", "\"leaf_index\": 4")).verify(tree.root(), totals)
                .problems().toString().contains("contradicts leaf_index"), "and the problem names the index");
        Map<String, BigInteger> understated = new LinkedHashMap<>(totals);
        understated.put("BTC", totals.get("BTC").subtract(BigInteger.ONE));
        Check.isTrue(tree.prove(5).verify(tree.root(), understated).problems().toString().contains("computed total BTC"),
                "a root that matches with other totals is a statement that lied about one of them");
        Map<String, BigInteger> extra = new LinkedHashMap<>(totals);
        extra.put("DOGE", BigInteger.ONE);
        Check.isTrue(!tree.prove(5).verify(tree.root(), extra).ok(), "a declared total the tree knows nothing of");
        extra.put("DOGE", BigInteger.ZERO);
        Check.isTrue(tree.prove(5).verify(tree.root(), extra).ok(), "an asset missing on one side counts as zero");
        Check.isTrue(!tree.prove(5).verify("00".repeat(32), totals).ok(), "another root");
    }

    static void testAProofOfAnotherShapeIsRefusedBeforeAnyHashing() {
        String json = Sample.tree().prove(5).toJson();
        for (String[] change : new String[][] {
                { "\"dir\": \"right\"", "\"dir\": \"banana\"" },
                { "\"dir\": \"left\"", "\"dir\": \"LEFT\"" },
                { "\"leaf_index\": 5", "\"leaf_index\": -1" },
                { "\"leaf_index\": 5", "\"leaf_index\": 5.0" },
                { "\"leaf_index\": 5", "\"leaf_index\": \"5\"" },
                { "\"leaf_index\": 5", "\"leaf_index\": 2147483647" },
                { "\"BTC\": \"50000000\"", "\"BTC\": 50000000" },
                { "\"BTC\": \"50000000\"", "\"BTC\": \"050000000\"" },
                { "\"BTC\": \"50000000\"", "\"BTC\": \"+50000000\"" },
                { "\"BTC\": \"50000000\"", "\"BTC\": \"-1\"" },
                { "\"BTC\": \"50000000\"", "\"BTC\": \"\"" },
                { "\"salt\": \"", "\"salt\": \"Z" },
                { "\"siblings\": [", "\"siblings_\": [" },
        }) {
            Check.isTrue(json.contains(change[0]), "the proof holds " + change[0]);
            Check.refuses("invalid_proof", () -> InclusionProof.parse(json.replace(change[0], change[1])));
        }
        Check.refuses("invalid_proof", () -> InclusionProof.parse("[]"));
        Check.refuses("invalid_proof", () -> InclusionProof.parse("{\"leaf_index\":0,\"leaf\":{\"user_ref_hash\":\"" + "a".repeat(64)
                + "\",\"salt\":\"" + "b".repeat(64) + "\",\"balances\":{}},\"siblings\":["
                + String.join(",", Collections.nCopies(32, "{\"hash\":\"" + "c".repeat(64) + "\",\"sums\":{},\"dir\":\"right\"}")) + "]}"));
    }

    static void testLeafDerivationsRefuseWhatTheyCannotHash() {
        Check.refuses("invalid_text", () -> Leaves.userRefHash(Sample.EXCHANGE, "half\ud83d"));
        Check.refuses("invalid_text", () -> Leaves.salt(Sample.seed(), "half\ud83d"));
        Check.refuses("invalid_seed", () -> Leaves.salt(new byte[31], "u1"));
        Check.refuses("invalid_leaf", () -> Leaves.leafHash("x", "ab".repeat(32), Collections.emptyMap()));
        Check.refuses("invalid_balance", () -> Leaves.leafHash("ab".repeat(32), "ab".repeat(32),
                Collections.singletonMap("BTC", BigInteger.ONE.negate())));
        Check.equal(32, Leaves.newSeed().length, "a fresh seed");
        Check.isTrue(!Arrays.equals(Leaves.newSeed(), Leaves.newSeed()), "is fresh each time");
    }
}
