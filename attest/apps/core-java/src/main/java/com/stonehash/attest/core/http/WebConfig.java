package com.stonehash.attest.core.http;

import com.stonehash.attest.core.attest.AttestRoutes;
import com.stonehash.attest.core.attest.PublicRoutes;
import com.stonehash.attest.core.audit.Audit;
import com.stonehash.attest.core.auth.KeyRoutes;
import com.stonehash.attest.core.config.CoreConfig;
import com.stonehash.attest.core.console.ConsoleRoutes;
import com.stonehash.attest.core.console.ProductRoutes;
import com.stonehash.attest.core.evidence.EvidenceRoutes;
import com.stonehash.attest.core.ops.OperationsRoutes;
import com.stonehash.attest.core.por.PorRoutes;
import com.stonehash.attest.core.remit.RemitRoutes;
import com.stonehash.attest.core.sandbox.SandboxRoutes;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import org.apache.catalina.Lifecycle;
import org.apache.catalina.connector.Request;
import org.apache.catalina.connector.Response;
import org.apache.catalina.valves.ValveBase;
import org.apache.coyote.ProtocolHandler;
import org.springframework.boot.tomcat.servlet.TomcatServletWebServerFactory;
import org.springframework.boot.web.server.WebServerFactoryCustomizer;
import org.springframework.boot.web.servlet.ServletRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * The route table, in the order the routes are consulted, and the embedded
 * server it is served from.
 *
 * <p>Routes are registered here, in one place and in a fixed order, rather
 * than discovered: the first route that fits a request answers it, so the
 * order is part of the behaviour.
 */
@Configuration
public class WebConfig {

    @Bean
    public Router router(CoreConfig cfg, Audit audit, OperationsRoutes operations, AttestRoutes attest, PublicRoutes freeTier, KeyRoutes keys,
            ConsoleRoutes console, ProductRoutes products, RemitRoutes remit, PorRoutes por, EvidenceRoutes evidence, SandboxRoutes sandbox) {
        Router r = new Router();

        // The screens are static and client-only. They are consulted only when no route
        // matched, so a file can never shadow an endpoint. Each is optional: in production
        // every screen has its own host name and this process serves none.
        List<StaticFiles.Mount> mounts = new ArrayList<>();
        if (!cfg.playgroundDir.isEmpty()) {
            mounts.add(new StaticFiles.Mount(cfg.playgroundDir, "/playground"));
        }
        if (!cfg.docsDir.isEmpty()) {
            mounts.add(new StaticFiles.Mount(cfg.docsDir, "/docs"));
        }
        if (!cfg.consoleDir.isEmpty()) {
            mounts.add(new StaticFiles.Mount(cfg.consoleDir, "/console"));
        }
        if (!mounts.isEmpty()) {
            // The bare address is the console; where none is mounted the developer hub stands
            // in, then whichever screen there is. With nothing mounted `/` stays a 404.
            StaticFiles.Mount first = mounts.get(0);
            for (String preferred : new String[] { "/docs", "/console" }) {
                for (StaticFiles.Mount m : mounts) {
                    if (m.mount.equals(preferred)) {
                        first = m;
                    }
                }
            }
            String landing = first.mount + "/";
            r.fallback((method, target, res) -> {
                if (StaticFiles.redirectRoot(landing, method, target, res)) {
                    return true;
                }
                for (StaticFiles.Mount m : mounts) {
                    if (StaticFiles.serve(m, method, target, res)) {
                        return true;
                    }
                }
                return false;
            });
        }

        // The audit trail: one row per request that acted as someone, written once the status is
        // known and before the response goes out.
        r.onDone(audit::afterRequest);

        // ── Operations ───────────────────────────────────────────────────────
        operations.registerHealth(r);
        // The settlement rail and the reserve proofs register here, where the rail is enabled, in the
        // order they always did: the rail's metadata and partner registration, the console's product
        // screen and what it does to a subscription and to an institution's keys, the rest of the rail
        // — and after the rail's routes the reserve proofs. `GET /v1/settlements/:id` is thereby ahead
        // of nothing it could shadow but a GET of the two stateless evaluators, which it answers.
        if (cfg.remit.enabled) {
            remit.registerProvisioning(r);
            products.register(r);
            remit.register(r);
            por.register(r);
        }
        operations.registerReady(r);
        operations.registerMeta(r);

        // ── Attestations, issuer keys ────────────────────────────────────────
        attest.registerAttestations(r);
        attest.registerIssuerKeys(r);

        // ── Free tier: no account, no key ────────────────────────────────────
        freeTier.register(r);

        // ── Settlement evidence ──────────────────────────────────────────────
        // Stateless: evidence and policy arrive in the request, the verdict and the archive go
        // back, nothing is stored.
        evidence.register(r);

        // ── Sandbox console ──────────────────────────────────────────────────
        // Session-authenticated; it sits beside the keyed API, not in front of it.
        console.register(r);
        // Material for the evaluation sandbox: documents and packages. The verdict itself always
        // comes from /v1/settlements/reconcile above.
        sandbox.register(r);

        // ── Provisioning ─────────────────────────────────────────────────────
        keys.register(r);
        return r;
    }

    /** Every path and every method goes to the one servlet. */
    @Bean
    public ServletRegistrationBean<CoreServlet> coreServlet(Router router) {
        ServletRegistrationBean<CoreServlet> bean = new ServletRegistrationBean<>(new CoreServlet(router), "/*");
        bean.setName("core");
        bean.setLoadOnStartup(1);
        return bean;
    }

    /**
     * The connector is told to pass on what it would refuse by default, so
     * that the router decides: characters a strict reading of the URL
     * grammar forbids, a TRACE request, and — through {@link RawTargetAdapter}
     * — the request target itself, undecoded. The room for the request line
     * and headers is the 16 KiB the previous server allowed.
     */
    @Bean
    public WebServerFactoryCustomizer<TomcatServletWebServerFactory> tomcat() {
        return (factory) -> {
            factory.addConnectorCustomizers((connector) -> {
                connector.setAllowTrace(true);
                connector.setProperty("relaxedPathChars", "\"<>[\\]^`{|}");
                connector.setProperty("relaxedQueryChars", "\"<>[\\]^`{|}");
                connector.setProperty("maxHttpRequestHeaderSize", "16384");
                connector.addLifecycleListener((event) -> {
                    if (Lifecycle.AFTER_INIT_EVENT.equals(event.getType())) {
                        ProtocolHandler handler = connector.getProtocolHandler();
                        if (!(handler.getAdapter() instanceof RawTargetAdapter)) {
                            handler.setAdapter(new RawTargetAdapter(handler.getAdapter()));
                        }
                    }
                });
            });
            factory.addContextValves(new VerbatimContentType());
        };
    }

    /** Lets {@link ResponseHeaders} write a Content-Type exactly as given, for the request a thread is serving. */
    static final class VerbatimContentType extends ValveBase {
        VerbatimContentType() {
            super(true);
        }

        @Override
        public void invoke(Request request, Response response) throws IOException, jakarta.servlet.ServletException {
            ResponseHeaders.verbatimContentType((res, value) -> response.getCoyoteResponse().setContentTypeNoCharset(value));
            // Closing without an answer: what the document route does with an upload past its ceiling.
            ResponseHeaders.connectionCutter(() -> response.getCoyoteResponse().action(org.apache.coyote.ActionCode.CLOSE_NOW, null));
            try {
                getNext().invoke(request, response);
            } finally {
                ResponseHeaders.clear();
            }
        }
    }
}
