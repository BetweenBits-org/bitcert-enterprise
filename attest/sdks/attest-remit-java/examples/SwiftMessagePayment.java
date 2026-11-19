import com.stonehash.attest.remit.PartySupplement;
import com.stonehash.attest.remit.RemitClient;
import com.stonehash.attest.remit.Settlement;
import com.stonehash.attest.remit.Signers;
import com.stonehash.attest.remit.SwiftOptions;
import com.stonehash.attest.remit.SwiftSubmission;
import com.stonehash.attest.remit.swift.Swift;
import com.stonehash.attest.remit.swift.SwiftMapping;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;

/**
 * One payment from the message the bank's payment system already writes: an
 * MT103, a pacs.008 or a pain.001 goes in as it is, and the outcome comes back
 * as an ISO 20022 status and a pacs.002.
 *
 * <p>Give the message file as the argument, or run it from the root of the
 * extracted download to use the sample MT103. Reads {@code STONEHASH_CORE},
 * {@code STONEHASH_API_KEY} and {@code STONEHASH_INSTITUTION} from the
 * environment and the signing key from {@code stonehash-remit-signing-key.pem}.
 *
 * <p>Run it twice with the same file: the second run sends nothing and reports
 * the payment the first one made.
 */
public final class SwiftMessagePayment {
    private SwiftMessagePayment() {
    }

    public static void main(String[] args) throws Exception {
        RemitClient client = RemitClient.builder()
                .core(System.getenv("STONEHASH_CORE"))
                .apiKey(System.getenv("STONEHASH_API_KEY"))
                .institution(System.getenv("STONEHASH_INSTITUTION"), "Your bank")
                .signer(Signers.fromPkcs8Pem(Files.readString(Path.of("stonehash-remit-signing-key.pem"))))
                .build();
        client.assertRegistered();                              // is this the registered key?

        byte[] message = Files.readAllBytes(Path.of(args.length > 0 ? args[0] : "packages/attest-remit/samples/mt103.sample.txt"));

        // What the message does not carry comes from the bank's own records — here one row
        // of a customer master, keyed by the debtor's account as the message writes it.
        Map<String, PartySupplement> customerMaster = new HashMap<>();
        customerMaster.put("VN-ACC-000777", new PartySupplement().debtorRegistrationNumber("0312345678"));
        SwiftOptions options = new SwiftOptions().supplement((payment) -> customerMaster.get(payment.debtor().account()));

        // What would be sent. Nothing is signed and nothing leaves the machine.
        SwiftMapping mapping = client.inspectSwift(message, options);
        System.out.println(mapping.payment().messageType() + ", SHA-256 " + mapping.payment().digest());
        System.out.println(mapping.input() == null ? "the message lacks something the corridor requires" : "complete: " + mapping.input().tradeAmount()
                + " " + mapping.input().tradeCurrency());

        // The whole path: read, convert, quote, sign, submit.
        SwiftSubmission sent = client.submitSwift(message, options);
        System.out.println(sent.paymentId() + " " + sent.state() + (sent.already() ? " — submitted before; nothing new was sent" : ""));

        Settlement settled = client.track(sent.paymentId(),
                (state, view) -> System.out.println("state " + state + " → " + Swift.statusOf(view.json()).code()));
        System.out.println(Swift.buildPacs002(settled.json()));  // the report your payment hub already processes
    }
}
