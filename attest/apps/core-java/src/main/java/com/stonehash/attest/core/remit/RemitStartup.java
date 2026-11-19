package com.stonehash.attest.core.remit;

import com.stonehash.attest.core.StartMode;
import com.stonehash.attest.core.config.ConfigError;
import com.stonehash.attest.core.config.CoreConfig;
import com.stonehash.attest.core.console.ProductRegistry;
import com.stonehash.attest.core.log.Log;
import org.springframework.beans.factory.SmartInitializingSingleton;
import org.springframework.stereotype.Component;

/**
 * What the settlement rail does when the server starts to serve, before it
 * answers its first request: the platform registers itself in the trust
 * registry, so that its event and webhook signatures resolve like any other
 * institution's.
 *
 * <p>This is the one row the service writes to the store at start, and it
 * reads before it writes: a row that already says what would be written is
 * left alone. On the live store a row that holds <em>another</em> signing
 * key than the key file is not overwritten — the path may name the wrong
 * file, and overwriting would publish a key nobody decided on; the start
 * stops instead. (On a test store the row follows the key file, as it did
 * in the service this one replaces.)
 *
 * <p>Nothing happens here for a command or a test: they are wired, not
 * started to serve ({@link StartMode}). The key file itself is found or made
 * one step earlier ({@link PlatformKey#prepareAtStart}).
 */
@Component
public class RemitStartup implements SmartInitializingSingleton {
    private final CoreConfig cfg;
    private final StartMode mode;
    private final PlatformKey platform;
    private final ProductRegistry registry;

    public RemitStartup(CoreConfig cfg, StartMode mode, PlatformKey platform, ProductRegistry registry) {
        this.cfg = cfg;
        this.mode = mode;
        this.platform = platform;
        this.registry = registry;
    }

    @Override
    public void afterSingletonsInstantiated() {
        if (!mode.serving || !cfg.remit.enabled) {
            return;
        }
        String spki = platform.spki();
        ProductRegistry.PlatformRow row = registry.platformRow(spki);
        if (row == ProductRegistry.PlatformRow.OTHER_KEY && (cfg.cutoverApproved || cfg.env.equals("live"))) {
            throw new ConfigError("refusing to start: the platform's own institution (" + ProductRegistry.PLATFORM_ID + ") is registered with another "
                    + "signing key than the key file at REMIT_PLATFORM_KEY_PATH. On the live store that row is not overwritten at start — "
                    + "the path may name the wrong file. To change the platform's key on purpose, run the command register-platform-key.");
        }
        if (row != ProductRegistry.PlatformRow.CURRENT) {
            registry.registerPlatform(spki);
            Log.line("platform institution registered", Log.fields("id", ProductRegistry.PLATFORM_ID, "key_id", platform.keyId(),
                    "was", row.name().toLowerCase(java.util.Locale.ROOT)));
        }
        Log.line("remit rail enabled", Log.fields("partners", cfg.remit.partnersBase, "corridor", "VN→SG"));
    }
}
