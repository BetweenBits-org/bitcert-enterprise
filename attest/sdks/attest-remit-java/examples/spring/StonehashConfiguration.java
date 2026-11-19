package com.example.bank.settlement;

import com.stonehash.attest.remit.RemitClient;
import com.stonehash.attest.remit.Signer;
import com.stonehash.attest.remit.Signers;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * The StoneHash client inside a Spring service: one bean, made once, shared by
 * every request thread.
 *
 * <p>The five properties come from wherever your service keeps its settings
 * and secrets ({@code application.yml}, a vault, the environment):
 *
 * <pre>
 * stonehash.core                 the platform's address
 * stonehash.api-key              console: Integrate → API keys
 * stonehash.institution-id       console: Subscriptions, once Cross-border Settlement is active
 * stonehash.institution-name     your bank's registered name; it travels with every signature
 * stonehash.signing-public-key   the public half of the key registered in the console (PEM)
 * </pre>
 *
 * <p>The private half of that key is not a property. It stays in your HSM, and
 * the only thing this service needs from the HSM is {@link BankHsm}.
 */
@Configuration
public class StonehashConfiguration {

    /**
     * What your HSM integration already offers under some name: sign these
     * bytes with the bank's instruction-signing key. Implement it over your
     * PKCS#11 provider, your KMS client or your signing service.
     */
    public interface BankHsm {
        /**
         * ECDSA over P-256, hashing the given bytes with SHA-256 (JCA:
         * {@code SHA256withECDSA}). The bytes are the message itself, not a
         * digest of it. The answer may be DER or raw {@code r ‖ s}.
         */
        byte[] signSha256WithEcdsa(byte[] message) throws Exception;
    }

    /** The SDK checks every signature the HSM returns against this public key before using it. */
    @Bean
    public Signer stonehashSigner(@Value("${stonehash.signing-public-key}") String publicKeyPem, BankHsm hsm) {
        return Signers.external(publicKeyPem, hsm::signSha256WithEcdsa);
    }

    /**
     * {@code assertRegistered()} asks the platform whether this is the key it
     * holds for the institution, so a wrong slot or key label stops the service
     * here, at start-up, instead of refusing the first payment. It needs the
     * platform to be reachable; leave the call out if your service must start
     * without it, and call it from a health check instead.
     */
    @Bean
    public RemitClient remitClient(
            @Value("${stonehash.core}") String core,
            @Value("${stonehash.api-key}") String apiKey,
            @Value("${stonehash.institution-id}") String institutionId,
            @Value("${stonehash.institution-name}") String institutionName,
            Signer stonehashSigner) {
        RemitClient client = RemitClient.builder()
                .core(core)
                .apiKey(apiKey)
                .institution(institutionId, institutionName)
                .signer(stonehashSigner)
                .build();
        client.assertRegistered();
        return client;
    }
}
