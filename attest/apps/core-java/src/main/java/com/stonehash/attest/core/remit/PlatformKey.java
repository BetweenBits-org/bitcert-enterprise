package com.stonehash.attest.core.remit;

import com.stonehash.attest.core.config.ConfigError;
import com.stonehash.attest.core.config.CoreConfig;
import com.stonehash.attest.core.format.Canonical;
import com.stonehash.attest.core.format.Hex;
import com.stonehash.attest.remit.Conventions;
import com.stonehash.attest.remit.KeySigner;
import com.stonehash.attest.remit.RemitException;
import com.stonehash.attest.remit.Signers;
import java.io.IOException;
import java.nio.channels.SeekableByteChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.GeneralSecurityException;
import java.security.KeyPairGenerator;
import java.security.spec.ECGenParameterSpec;
import java.util.Base64;
import java.util.Map;
import java.util.Set;
import org.springframework.stereotype.Component;

/**
 * The platform's own signing key — a file ({@code REMIT_PLATFORM_KEY_PATH}:
 * PKCS#8, P-256) outside the database.
 *
 * <p>Everything the platform asserts itself is signed with it: the events it
 * appends to a settlement, the webhooks it sends, what it tells a partner,
 * a daily manifest's verdict. The key's id is published with every signature
 * and is derived from the key: {@code STONEHASH-SIGN-} and the first eight
 * hex digits of the SHA-256 of the public key's base64 text (the text, not
 * the bytes it stands for). The same file therefore gives the same id here
 * as in the service this one replaces — what that one signed stays checkable
 * against the key published today.
 *
 * <p>The file is read when it is first needed and never made here. Making
 * one is a step of the server's start, and only on a test store
 * ({@link #prepareAtStart}): a key that appeared by itself on the live store
 * would be a new identity nobody registered.
 */
@Component
public class PlatformKey {
    /** Who the platform signs as, and the id of its institution in the registry. */
    public static final String ISSUER = "STONEHASH";

    /** A key file, read. */
    public static final class Loaded {
        public final KeySigner signer;
        /** The public half: base64 of its SPKI (DER). */
        public final String spki;
        public final String keyId;

        Loaded(KeySigner signer) {
            this.signer = signer;
            this.spki = signer.publicKeySpkiBase64();
            this.keyId = keyIdOf(spki);
        }
    }

    private final Path file;
    private volatile Loaded loaded;

    public PlatformKey(CoreConfig cfg) {
        this.file = Path.of(cfg.remit.platformKeyPath);
    }

    /** The id of a key, from its public half as base64 text. */
    public static String keyIdOf(String spkiBase64) {
        return "STONEHASH-SIGN-" + Hex.encode(Hex.sha256(spkiBase64.getBytes(StandardCharsets.US_ASCII))).substring(0, 8);
    }

    /**
     * Read a key file.
     *
     * @throws NoSuchFileException when there is none
     * @throws RemitException {@code invalid_key} when what is there is not an unencrypted PKCS#8 P-256 key
     */
    public static Loaded read(Path file) throws IOException {
        return new Loaded(Signers.fromPkcs8Pem(Files.readString(file, StandardCharsets.UTF_8)));
    }

    /**
     * The step of the server's start: the key file is there and can be
     * read — or, on a test store only, is made now, as the previous service
     * made one the first time it started.
     *
     * <p>On the live store (a start approved for the switch, or the
     * {@code live} environment) a missing file stops the start. A path that
     * is wrong by one character would otherwise give the platform a new key
     * and a new key id without anybody having decided that.
     */
    public static Loaded prepareAtStart(CoreConfig cfg) {
        Path file = Path.of(cfg.remit.platformKeyPath);
        try {
            if (!Files.exists(file)) {
                if (cfg.cutoverApproved || cfg.env.equals("live")) {
                    throw new ConfigError("refusing to start: there is no platform signing key at REMIT_PLATFORM_KEY_PATH. "
                            + "On the live store a key is never made at start — a new key is a new key id, and nothing the platform "
                            + "signed before could be checked against it. Put the key file in place, or correct the path.");
                }
                create(file);
            }
            return read(file);
        } catch (RemitException e) {
            throw new ConfigError("the file at REMIT_PLATFORM_KEY_PATH is not a platform signing key: an unencrypted PKCS#8 P-256 key in PEM is expected");
        } catch (IOException e) {
            throw new ConfigError("the platform signing key at REMIT_PLATFORM_KEY_PATH cannot be read or made: " + e.getClass().getSimpleName());
        }
    }

    /**
     * Make a key file: a fresh P-256 key as PKCS#8 PEM, readable by its
     * owner only. A file that appeared in the meantime (another instance
     * starting beside this one) is left as it is.
     */
    static void create(Path file) throws IOException {
        if (file.getParent() != null) {
            Files.createDirectories(file.getParent());
        }
        byte[] pkcs8;
        try {
            KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
            generator.initialize(new ECGenParameterSpec("secp256r1"));
            pkcs8 = generator.generateKeyPair().getPrivate().getEncoded();
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("this Java runtime cannot make a P-256 key", e);
        }
        String pem = "-----BEGIN PRIVATE KEY-----\n"
                + Base64.getMimeEncoder(64, new byte[] { '\n' }).encodeToString(pkcs8)
                + "\n-----END PRIVATE KEY-----\n";
        try (SeekableByteChannel out = Files.newByteChannel(file, Set.of(StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE),
                PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")))) {
            out.write(java.nio.ByteBuffer.wrap(pem.getBytes(StandardCharsets.US_ASCII)));
        } catch (FileAlreadyExistsException e) {
            // Made by someone else between the look and the write: theirs is the key.
        }
    }

    private Loaded key() {
        Loaded k = loaded;
        if (k == null) {
            synchronized (this) {
                k = loaded;
                if (k == null) {
                    try {
                        k = read(file);
                    } catch (NoSuchFileException e) {
                        throw new IllegalStateException("there is no platform signing key at REMIT_PLATFORM_KEY_PATH: "
                                + "the file is made (on a test store) or expected (on the live one) when the server starts, never by a command");
                    } catch (IOException | RemitException e) {
                        throw new IllegalStateException("the platform signing key at REMIT_PLATFORM_KEY_PATH cannot be read: " + e.getClass().getSimpleName());
                    }
                    loaded = k;
                }
            }
        }
        return k;
    }

    /** {@code STONEHASH-SIGN-xxxxxxxx}. */
    public String keyId() {
        return key().keyId;
    }

    /** The public half, base64 of its SPKI: what a counterparty verifies the platform's signatures with. */
    public String spki() {
        return key().spki;
    }

    /**
     * The platform's signature over an event payload: the detached envelope
     * {@code { alg: "ES256", key_id, issuer: "STONEHASH", sig }}.
     *
     * <p>A payload that has no canonical form — a fraction in it, a number
     * beyond what the format carries — is refused in the words the service
     * has always used for it ({@link Canonical#forSdk}).
     */
    public Map<String, Object> signEvent(Object payload) {
        Loaded k = key();
        return Conventions.signEvent(Canonical.forSdk(payload), k.signer, k.keyId, ISSUER);
    }
}
