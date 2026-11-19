import com.stonehash.attest.por.AmountUnit;
import com.stonehash.attest.por.AssetSpec;
import com.stonehash.attest.por.Ledger;
import com.stonehash.attest.por.LedgerBuilder;
import com.stonehash.attest.por.PorTree;
import java.util.ArrayList;
import java.util.List;

/**
 * Measures a build from in-memory rows through tree construction: the rows
 * are made first (they stand for a fetched result set and are not part of the
 * timing), then fed to a {@link LedgerBuilder} one call per balance, and the
 * tree is built from the result.
 *
 * <p>Usage: {@code MeasureBuild <accounts> <assets>} — run it through
 * {@code measure.sh}, which caps the heap and reports the process's peak
 * memory.
 */
public final class MeasureBuild {
    private MeasureBuild() {
    }

    public static void main(String[] args) {
        int accounts = Integer.parseInt(args[0]);
        int assetCount = Integer.parseInt(args[1]);
        // Decimal places of real assets, cycled: BTC, ETH, USDT.
        int[] decimals = { 8, 18, 6 };
        List<AssetSpec> assets = new ArrayList<>();
        for (int a = 0; a < assetCount; a++) {
            assets.add(new AssetSpec("A" + (a + 1), decimals[a % decimals.length]));
        }

        // The rows, as a database would print them: about three balances in four are held, most small, a few large.
        long state = 0x5eedL;
        String[] ids = new String[accounts];
        String[][] amounts = new String[accounts][assetCount];
        long balances = 0;
        for (int i = 0; i < accounts; i++) {
            ids[i] = String.format("user-%09d", i + 1);
            boolean held = false;
            for (int a = 0; a < assetCount; a++) {
                state = next(state);
                if ((state >>> 33) % 4 == 0) {
                    continue;
                }
                state = next(state);
                long whole = (state >>> 40) % 1000 == 0 ? (state >>> 20) % 1_000_000_000L : (state >>> 20) % 100;
                state = next(state);
                String fraction = String.valueOf(1_000_000 + (state >>> 30) % 1_000_000).substring(1);
                amounts[i][a] = whole + "." + fraction;
                balances++;
                held = true;
            }
            if (!held) {
                // Every account is in the ledger, so the count asked for is the count measured.
                amounts[i][0] = "0.000001";
                balances++;
            }
        }

        long started = System.nanoTime();
        LedgerBuilder builder = new LedgerBuilder(assets, AmountUnit.DECIMAL);
        for (int i = 0; i < accounts; i++) {
            for (int a = 0; a < assetCount; a++) {
                if (amounts[i][a] != null) {
                    builder.add(ids[i], assets.get(a).symbol(), amounts[i][a]);
                }
            }
        }
        Ledger ledger = builder.finish();
        long ledgerDone = System.nanoTime();
        if (!ledger.ok()) {
            throw new IllegalStateException("the generated ledger was refused: " + ledger.report().problems());
        }
        PorTree tree = PorTree.build("MEASURE-EX-01", new byte[32], ledger);
        long treeDone = System.nanoTime();

        System.gc();
        long retained = Runtime.getRuntime().totalMemory() - Runtime.getRuntime().freeMemory();
        System.out.printf("accounts %d  assets %d  balances %d  accounts in ledger %d%n", accounts, assetCount, balances, ledger.rows().size());
        System.out.printf("ledger %d ms  tree %d ms  total %d ms%n", (ledgerDone - started) / 1_000_000,
                (treeDone - ledgerDone) / 1_000_000, (treeDone - started) / 1_000_000);
        System.out.printf("heap in use after the build: %d MB (the rows that were fed in, the ledger and the tree)%n", retained >> 20);
        System.out.printf("root %s  leaves %d%n", tree.root(), tree.leafCount());
    }

    /** xorshift64: the same rows on every run. */
    private static long next(long x) {
        x ^= x << 13;
        x ^= x >>> 7;
        x ^= x << 17;
        return x;
    }
}
