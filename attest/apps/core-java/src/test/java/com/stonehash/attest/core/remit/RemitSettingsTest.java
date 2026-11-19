package com.stonehash.attest.core.remit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.stonehash.attest.core.config.ConfigError;
import com.stonehash.attest.core.config.CoreConfig;
import com.stonehash.attest.core.config.EnvSource;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The two settings the settlement rail has here and the service it replaces
 * has not ({@code docs/JAVA-REMIT-DESIGN.md} 17) — there is no reference to
 * record an answer from, so what they mean is stated here — and the start's
 * rule about the platform key file, which is this service's own as well.
 * (The settings both services read are held to the reference in
 * {@code HttpVectorsTest}; those vectors also show the reference unmoved by
 * these two keys.)
 */
class RemitSettingsTest {
    private static CoreConfig load(String... pairs) {
        Map<String, String> env = new LinkedHashMap<>();
        env.put("STONEHASH_DATA_DIR", "/srv/stonehash/data");
        for (int i = 0; i < pairs.length; i += 2) {
            env.put(pairs[i], pairs[i + 1]);
        }
        return CoreConfig.load(EnvSource.of(env));
    }

    @Test
    void retriesAStepAfterTwoTenAndThirtySecondsUnlessToldOtherwise() {
        assertEquals(List.of(2000L, 10000L, 30000L), load().remit.stepRetryMs, "the default");
        assertEquals(List.of(2000L, 10000L, 30000L), load("REMIT_STEP_RETRY_MS", "").remit.stepRetryMs, "an empty value is no value, as for every other setting");
        assertEquals(List.of(), load("REMIT_STEP_RETRY_MS", "off").remit.stepRetryMs, "off: the first failure is the last");
        assertEquals(List.of(100L, 200L), load("REMIT_STEP_RETRY_MS", "100,200").remit.stepRetryMs);
        assertEquals(List.of(0L), load("REMIT_STEP_RETRY_MS", "0").remit.stepRetryMs);
        assertEquals(List.of(5L, 1000L), load("REMIT_STEP_RETRY_MS", " 5 , 1e3 ").remit.stepRetryMs, "numbers are read as every other number of the settings is");
        for (String bad : new String[] { "OFF", "none", "1,,2", "1,", ",", "-1", "1.5", "2000;10000", "1 2", "Infinity" }) {
            ConfigError e = assertThrows(ConfigError.class, () -> load("REMIT_STEP_RETRY_MS", bad), bad);
            assertEquals("REMIT_STEP_RETRY_MS must be \"off\" or a comma-separated list of non-negative integers (milliseconds), got " + bad, e.getMessage());
        }
    }

    @Test
    void takesNothingInOnlyWhenTheSettingIsOne() {
        assertFalse(load().remit.intakePaused, "the default");
        assertTrue(load("REMIT_INTAKE_PAUSED", "1").remit.intakePaused);
        for (String other : new String[] { "", "0", "true", "yes", "on", " 1x" }) {
            assertFalse(load("REMIT_INTAKE_PAUSED", other).remit.intakePaused, other);
        }
    }

    @Test
    void makesAKeyFileAtStartOnATestStoreAndNeverOnTheLiveOne(@TempDir Path dir) throws Exception {
        // A test store: the file is made the first time, and kept from then on.
        Path made = dir.resolve("test-store/platform-remit-key.pem");
        CoreConfig test = load("REMIT_PLATFORM_KEY_PATH", made.toString());
        PlatformKey.Loaded first = PlatformKey.prepareAtStart(test);
        assertTrue(Files.exists(made));
        assertEquals(first.keyId, PlatformKey.prepareAtStart(test).keyId, "the second start reads the key the first one made");
        assertEquals(first.keyId, new PlatformKey(test).keyId(), "and so does the service once it is wired");

        // The live environment: a missing file stops the start, and nothing is made.
        Path absent = dir.resolve("live/platform-remit-key.pem");
        CoreConfig live = load("STONEHASH_ENV", "live", "ANCHOR_BACKEND", "mainnet", "REMIT_ENABLED", "1", "REMIT_CHAIN_RPC", "https://rpc.example",
                "REMIT_PLATFORM_KEY_PATH", absent.toString());
        ConfigError refused = assertThrows(ConfigError.class, () -> PlatformKey.prepareAtStart(live));
        assertTrue(refused.getMessage().startsWith("refusing to start: there is no platform signing key at REMIT_PLATFORM_KEY_PATH."), refused.getMessage());
        assertFalse(Files.exists(absent), "no key was made");
        assertFalse(Files.exists(absent.getParent()), "nor its folder");
        // With the file in place the live start reads it.
        Files.createDirectories(absent.getParent());
        Files.copy(made, absent);
        assertEquals(first.keyId, PlatformKey.prepareAtStart(live).keyId);

        // A file that is not a key stops any start, and its content is in no message.
        Path wrong = dir.resolve("wrong.pem");
        Files.writeString(wrong, "-----BEGIN PRIVATE KEY-----\nbm90IGEga2V5\n-----END PRIVATE KEY-----\n");
        ConfigError notAKey = assertThrows(ConfigError.class, () -> PlatformKey.prepareAtStart(load("REMIT_PLATFORM_KEY_PATH", wrong.toString())));
        assertEquals("the file at REMIT_PLATFORM_KEY_PATH is not a platform signing key: an unencrypted PKCS#8 P-256 key in PEM is expected", notAKey.getMessage());

        // A command or a test is wired, not started: it never makes a key, and says what is missing when it needs one.
        Path never = dir.resolve("never/platform-remit-key.pem");
        IllegalStateException needed = assertThrows(IllegalStateException.class, () -> new PlatformKey(load("REMIT_PLATFORM_KEY_PATH", never.toString())).keyId());
        assertTrue(needed.getMessage().startsWith("there is no platform signing key at REMIT_PLATFORM_KEY_PATH"), needed.getMessage());
        assertFalse(Files.exists(never.getParent()));
    }
}
