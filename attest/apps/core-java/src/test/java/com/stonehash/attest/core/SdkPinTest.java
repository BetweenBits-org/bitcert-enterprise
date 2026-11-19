package com.stonehash.attest.core;

import static org.junit.jupiter.api.Assertions.assertEquals;

import com.stonehash.attest.core.format.Hex;
import com.stonehash.attest.remit.Json;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

/**
 * The SDK jar this build runs against is the release it is pinned to
 * ({@code sdk.lock}). The SDK holds the bytes both sides must agree on, so
 * which SDK is on the class path is not left to whatever was installed last.
 */
class SdkPinTest {
    @Test
    void theSdkOnTheClassPathIsThePinnedRelease() throws Exception {
        Path jar = Path.of(Json.class.getProtectionDomain().getCodeSource().getLocation().toURI());
        String pinned = Files.readString(Path.of("sdk.lock")).trim().split("\\s+")[0];
        assertEquals(pinned, Hex.encode(Hex.sha256(Files.readAllBytes(jar))),
                "the SDK jar at " + jar + " is not the release named in sdk.lock — run tools/install-sdk.sh, or adopt the new release by changing sdk.lock");
    }
}
