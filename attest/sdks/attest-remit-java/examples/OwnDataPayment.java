import com.stonehash.attest.remit.EvidenceReport;
import com.stonehash.attest.remit.EvidenceVerifier;
import com.stonehash.attest.remit.Instruction;
import com.stonehash.attest.remit.InstructionOptions;
import com.stonehash.attest.remit.Quote;
import com.stonehash.attest.remit.RemitClient;
import com.stonehash.attest.remit.Settlement;
import com.stonehash.attest.remit.Signers;
import com.stonehash.attest.remit.TradeParties;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * One trade payment from the bank's own data: quote, sign, submit, follow it
 * to the anchored evidence, and re-check that evidence here.
 *
 * <p>Reads {@code STONEHASH_CORE}, {@code STONEHASH_API_KEY} and
 * {@code STONEHASH_INSTITUTION} from the environment and the signing key from
 * {@code stonehash-remit-signing-key.pem} in the working directory.
 */
public final class OwnDataPayment {
    private OwnDataPayment() {
    }

    public static void main(String[] args) throws Exception {
        RemitClient client = RemitClient.builder()
                .core(System.getenv("STONEHASH_CORE"))
                .apiKey(System.getenv("STONEHASH_API_KEY"))
                .institution(System.getenv("STONEHASH_INSTITUTION"), "Your bank")
                .signer(Signers.fromPkcs8Pem(Files.readString(Path.of("stonehash-remit-signing-key.pem"))))
                .build();
        client.assertRegistered();                              // is this the registered key?

        Quote quote = client.quote("10000.00");                 // the trade amount, in USD
        TradeParties parties = TradeParties.of(
                new TradeParties.Debtor().name("Saigon Import Co., Ltd.").country("VN")
                        .address("12 Le Loi, Ho Chi Minh City").registrationNumber("0312345678").account("VN-ACC-1"),
                new TradeParties.Creditor().name("Lion City Exports Pte. Ltd.").country("SG").account("SG-ACC-9").bank("Demo Payout Bank"));
        Instruction instruction = client.buildInstruction(quote, parties, new InstructionOptions()
                .invoiceRef("INV-2026-0457")
                .instructionRef("OUT-2026-000123")              // your own reference for this instruction
                .review(new InstructionOptions.Review()
                        .kybPolicyVersion("2026.3").regulatorReportRef("RPT-0457").approvedByRole("Trade Operations")));
        client.submit(instruction);                             // everything in it is already signed
        System.out.println("submitted " + instruction.paymentId());

        Settlement settled = client.track(instruction.paymentId(), (state, view) -> System.out.println("state " + state));
        if ("EVIDENCE_ANCHORED".equals(settled.state())) {
            EvidenceReport report = EvidenceVerifier.verify(client.evidence(instruction.paymentId()));
            report.checks().forEach(System.out::println);
            System.out.println("none failed: " + report.noneFailed());
        }
    }
}
