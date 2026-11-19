import com.stonehash.attest.remit.Instruction;
import com.stonehash.attest.remit.InstructionOptions;
import com.stonehash.attest.remit.Quote;
import com.stonehash.attest.remit.RemitClient;
import com.stonehash.attest.remit.Settlement;
import com.stonehash.attest.remit.Signer;
import com.stonehash.attest.remit.Signers;
import com.stonehash.attest.remit.TradeParties;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyFactory;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.spec.PKCS8EncodedKeySpec;
import java.util.Base64;

/**
 * The same payment with the signing key behind a {@link Signer} — the seam an
 * HSM or a KMS is plugged into — and the Travel Rule data encrypted on the
 * bank's side (mode B).
 *
 * <p>Here the "HSM" is a JCA {@link Signature} over the sandbox key, so the
 * example runs anywhere. In production the two marked lines become your
 * provider's: {@code Signature.getInstance("SHA256withECDSA", pkcs11Provider)}
 * and the key handle from the HSM's key store. Nothing else changes.
 */
public final class HsmSignerPayment {
    private HsmSignerPayment() {
    }

    public static void main(String[] args) throws Exception {
        // The key the HSM holds. Only its public half is given to the SDK.
        String pem = Files.readString(Path.of("stonehash-remit-signing-key.pem"));
        PrivateKey hsmKey = KeyFactory.getInstance("EC").generatePrivate(new PKCS8EncodedKeySpec(Base64.getMimeDecoder().decode(
                pem.replace("-----BEGIN PRIVATE KEY-----", "").replace("-----END PRIVATE KEY-----", ""))));
        String publicKey = Signers.fromPkcs8Pem(pem).publicKeySpkiBase64();   // in production: exported from the HSM once

        Signer hsm = Signers.external(publicKey, message -> {
            Signature signature = Signature.getInstance("SHA256withECDSA");   // production: (…, pkcs11Provider)
            signature.initSign(hsmKey);                                       // production: the HSM's key handle
            signature.update(message);                                        // the message itself — the HSM hashes it
            return signature.sign();                                          // DER is fine; the SDK checks it before use
        });

        RemitClient client = RemitClient.builder()
                .core(System.getenv("STONEHASH_CORE"))
                .apiKey(System.getenv("STONEHASH_API_KEY"))
                .institution(System.getenv("STONEHASH_INSTITUTION"), "Your bank")
                .signer(hsm)
                .build();
        client.assertRegistered();

        Quote quote = client.quote("2500.00");
        TradeParties parties = TradeParties.of(
                new TradeParties.Debtor().name("Saigon Import Co., Ltd.").country("VN")
                        .address("12 Le Loi, Ho Chi Minh City").registrationNumber("0312345678").account("VN-ACC-1"),
                new TradeParties.Creditor().name("Lion City Exports Pte. Ltd.").country("SG").account("SG-ACC-9").bank("Demo Payout Bank"));
        Instruction instruction = client.buildInstruction(quote, parties, new InstructionOptions()
                .invoiceRef("INV-2026-0458")
                .travelRule(InstructionOptions.TravelRule.B));   // party data leaves only as ciphertext
        client.submit(instruction);
        Settlement settled = client.track(instruction.paymentId());
        System.out.println(instruction.paymentId() + " " + settled.state() + " " + settled.evidenceLevel());
    }
}
