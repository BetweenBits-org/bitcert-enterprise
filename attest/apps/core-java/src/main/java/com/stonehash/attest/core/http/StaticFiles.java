package com.stonehash.attest.core.http;

import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.InvalidPathException;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/**
 * The built screens — console, developer hub, verification tool — served
 * from this process on a test box, so that one port is one thing to run. In
 * production each has its own host name and this process serves none, which
 * is why the directories are configuration.
 *
 * <p>Path handling is the whole security surface here, so it is deliberate:
 * the resolved path must stay inside the root, checked on the resolved path
 * and not by looking for {@code ..} in the request — the check that
 * classically gets bypassed.
 */
public final class StaticFiles {
    private StaticFiles() {
    }

    private static final Map<String, String> TYPES = new LinkedHashMap<>();
    static {
        TYPES.put(".html", "text/html; charset=utf-8");
        TYPES.put(".js", "text/javascript; charset=utf-8");
        TYPES.put(".mjs", "text/javascript; charset=utf-8");
        TYPES.put(".css", "text/css; charset=utf-8");
        TYPES.put(".json", "application/json; charset=utf-8");
        TYPES.put(".svg", "image/svg+xml");
        TYPES.put(".png", "image/png");
        TYPES.put(".jpg", "image/jpeg");
        TYPES.put(".ico", "image/x-icon");
        TYPES.put(".woff2", "font/woff2");
        TYPES.put(".txt", "text/plain; charset=utf-8");
        // The developer hub fetches its documents as Markdown and renders them in the browser.
        TYPES.put(".md", "text/markdown; charset=utf-8");
        TYPES.put(".pdf", "application/pdf");
        TYPES.put(".map", "application/json; charset=utf-8");
    }

    /** A directory and the URL prefix it answers. */
    public static final class Mount {
        /** Absolute directory to serve from. */
        public final String root;
        /** URL prefix this mount answers, e.g. {@code /playground}. */
        public final String mount;

        public Mount(String root, String mount) {
            this.root = root;
            this.mount = mount;
        }
    }

    /**
     * The bare address: {@code /} has no page of its own, so where a screen
     * is mounted the visitor is sent to it. Temporary and uncached, so the
     * landing can change; only {@code /} itself is claimed and the target is
     * a fixed local path; the query is carried over because it is how the
     * language is chosen.
     */
    public static boolean redirectRoot(String landing, String method, RequestTarget target, HttpServletResponse res) {
        if (!method.equals("GET") && !method.equals("HEAD")) {
            return false;
        }
        if (!target.pathname.equals("/")) {
            return false;
        }
        res.setStatus(302);
        res.setHeader("location", landing + target.search);
        res.setHeader("cache-control", "no-store");
        res.setContentLength(0);
        return true;
    }

    /** Returns {@code true} if the request was answered. The API keeps priority over any file of the same name. */
    public static boolean serve(Mount opts, String method, RequestTarget target, HttpServletResponse res) throws IOException {
        if (!target.pathname.startsWith(opts.mount)) {
            return false;
        }
        if (!method.equals("GET") && !method.equals("HEAD")) {
            return false;
        }
        // A malformed escape names no file, and it is the client's error.
        String rel = Router.decodeUriComponent(target.pathname.substring(opts.mount.length()));
        if (rel == null) {
            text(res, 400, "malformed percent-encoding in path");
            return true;
        }
        // A directory without its trailing slash is a redirect, not a page: served directly,
        // every relative reference in it would resolve one level too high.
        if (rel.isEmpty()) {
            res.setStatus(301);
            res.setHeader("location", opts.mount + "/" + target.search);
            res.setContentLength(0);
            return true;
        }
        if (rel.equals("/")) {
            rel = "/index.html";
        }
        Path resolved;
        try {
            resolved = Path.of(opts.root).resolve("." + rel).normalize();
        } catch (InvalidPathException e) {
            text(res, 404, "not found");
            return true;
        }
        // Containment on the resolved path, with the separator appended so that
        // /srv/app-evil cannot pass as being inside /srv/app.
        String resolvedText = resolved.toString();
        if (!resolvedText.equals(opts.root) && !resolvedText.startsWith(opts.root + "/")) {
            text(res, 403, "forbidden");
            return true;
        }
        Path file = resolved;
        if (Files.isDirectory(file)) {
            if (!target.pathname.endsWith("/")) {
                res.setStatus(301);
                res.setHeader("location", target.pathname + "/" + target.search);
                res.setContentLength(0);
                return true;
            }
            file = file.resolve("index.html");
        }
        if (!Files.exists(file) || Files.isDirectory(file)) {
            text(res, 404, "not found");
            return true;
        }
        String name = file.getFileName().toString().toLowerCase(Locale.ROOT);
        int dot = name.lastIndexOf('.');
        String type = dot > 0 ? TYPES.get(name.substring(dot)) : null;
        res.setStatus(200);
        ResponseHeaders.set(res, "content-type", type != null ? type : "application/octet-stream");
        // A verification tool must not run from a stale copy: a cached build could disagree with the SDK beside it.
        res.setHeader("cache-control", "no-cache");
        // It runs no remote code and loads no remote assets, so the policy can be this strict.
        res.setHeader("content-security-policy",
                "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
                        + "font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
        res.setHeader("x-content-type-options", "nosniff");
        res.setHeader("referrer-policy", "no-referrer");
        if (method.equals("HEAD")) {
            return true;
        }
        // Looking and reading are two moments: a rebuild between them removes the file. The
        // response is cut short then, not turned into an error page after its headers went out.
        try (InputStream in = Files.newInputStream(file); OutputStream out = res.getOutputStream()) {
            in.transferTo(out);
        }
        return true;
    }

    private static void text(HttpServletResponse res, int status, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        res.setStatus(status);
        ResponseHeaders.set(res, "content-type", "text/plain; charset=utf-8");
        res.setContentLength(bytes.length);
        res.getOutputStream().write(bytes);
    }
}
