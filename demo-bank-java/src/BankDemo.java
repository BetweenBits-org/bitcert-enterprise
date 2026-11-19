import com.stonehash.attest.remit.EvidenceReport;
import com.stonehash.attest.remit.EvidenceVerifier;
import com.stonehash.attest.remit.Instruction;
import com.stonehash.attest.remit.InstructionOptions;
import com.stonehash.attest.remit.Json;
import com.stonehash.attest.remit.PartySupplement;
import com.stonehash.attest.remit.Quote;
import com.stonehash.attest.remit.RemitClient;
import com.stonehash.attest.remit.RemitException;
import com.stonehash.attest.remit.Settlement;
import com.stonehash.attest.remit.Signer;
import com.stonehash.attest.remit.Signers;
import com.stonehash.attest.remit.SwiftOptions;
import com.stonehash.attest.remit.SwiftSubmission;
import com.stonehash.attest.remit.TradeParties;
import com.stonehash.attest.remit.swift.Swift;
import com.stonehash.attest.remit.swift.SwiftMapping;
import com.stonehash.attest.remit.swift.SwiftMappingException;
import com.stonehash.attest.remit.swift.SwiftMessageException;
import com.stonehash.attest.remit.swift.SwiftPayment;
import com.stonehash.attest.remit.swift.SwiftStatus;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.OutputStream;
import java.math.BigDecimal;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadLocalRandom;
import java.util.regex.Pattern;

/**
 * 데모은행의 Java 백엔드 — 은행 시스템(Java)이 StoneHash Attest Java SDK를
 * 자기 소스에서 호출하는 모습을 그대로 보여 주는 작은 서버.
 *
 * <p>화면은 요청만 보낸다. 전문 판독과 변환, 견적, 서명, 제출, 추적, 증빙
 * 재확인은 전부 이 프로세스 안에서 SDK 호출로 일어난다 — 아래
 * {@link #payFromSwift} 와 {@link #payFromOwnData} 가 은행 시스템에 들어갈
 * 코드와 같은 코드다.
 *
 * <p>서명키는 이 프로세스에 들어오지 않는다. {@code Signers.external} 뒤에서
 * {@code openssl} 프로세스가 서명한다 — 실제 은행에서는 그 자리가 HSM이다.
 * 지급은 콘솔 계정 ops@demo-bank.example 의 원장에 그대로 보인다.
 */
public final class BankDemo {
    private static final String INSTITUTION = "VN-BANK-001";
    private static final String BANK_NAME = "데모은행 (가상)";

    /** SDK에 든 표본 전문 — 화면의 "표본 불러오기"가 읽는다. */
    private static final String[][] SAMPLES = {
        { "pacs008.sample.xml", "pacs.008 (ISO 20022, 은행간)" },
        { "mt103.sample.txt", "MT103 (자유형식 50K/59)" },
        { "mt103.structured.sample.txt", "MT103 (구조화 50F/59F)" },
        { "pain001.sample.xml", "pain.001 (기업 → 은행)" },
        { "pacs008.envelope.sample.xml", "pacs.008 (봉투·접두사·자유주소)" },
    };
    private static final Pattern UETR = Pattern.compile("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}");
    private static final Pattern MESSAGE_NUMBER = Pattern.compile("(DEMOVNVX20261117|OUT-2026-|OUT2026)(\\d{6})");
    private static final Pattern CUSTOMER_NUMBER = Pattern.compile("(VINATRD-(?:20261117|PMT|INS)-)(\\d{4})");

    private static Path here;
    private static Path samples;
    private static String core;
    private static RemitClient client;
    /** 은행 고객원장 발췌(표본): 송금인 계좌 → 전문에 없는 값. */
    private static Map<String, Object> customerMaster = new LinkedHashMap<>();
    private static final List<Map<String, Object>> BOOK = new ArrayList<>();
    private static final ExecutorService WORKERS = Executors.newFixedThreadPool(4);

    private BankDemo() {
    }

    public static void main(String[] args) throws Exception {
        here = Paths.get("").toAbsolutePath();
        Path bank = here.resolveSibling("demo-bank");
        Map<String, Object> state = Json.object(Json.parse(Files.readString(bank.resolve("state.json"))), "invalid_state", "demo-bank/state.json");
        core = (String) state.get("core");
        Path keyFile = bank.resolve("hsm").resolve("bank-hsm.key");
        String publicKeyPem = Files.readString(bank.resolve("hsm").resolve("issuer-public.pem"));

        // 은행 HSM 자리: 서명할 바이트는 표준입력으로, 서명(DER)은 표준출력으로.
        // 실제 HSM이면 이 람다 안이 PKCS#11 Signature 호출로 바뀐다.
        Signer hsm = Signers.external(publicKeyPem, (message) -> {
            Process p = new ProcessBuilder("openssl", "dgst", "-sha256", "-sign", keyFile.toString()).start();
            try (OutputStream stdin = p.getOutputStream()) {
                stdin.write(message);
            }
            byte[] der = p.getInputStream().readAllBytes();
            if (p.waitFor() != 0) {
                throw new IOException("openssl exited with " + p.exitValue());
            }
            return der;
        });
        client = RemitClient.builder().core(core).apiKey((String) state.get("apiKey"))
                .institution(INSTITUTION, BANK_NAME).signer(hsm).build();
        client.assertRegistered();

        samples = here.resolveSibling("attest").resolve("packages").resolve("attest-remit").resolve("samples");
        Path parties = samples.resolve("parties.sample.json");
        if (Files.isRegularFile(parties)) {
            customerMaster = Json.object(Json.parse(Files.readString(parties)), "invalid_sample", "parties.sample.json");
        }

        loadBook();
        int port = Integer.parseInt(System.getenv().getOrDefault("PORT", "3500"));
        HttpServer server = HttpServer.create(new InetSocketAddress("0.0.0.0", port), 0);
        server.setExecutor(Executors.newFixedThreadPool(8));
        server.createContext("/", BankDemo::handle);
        server.start();
        System.out.println("demo-bank-java on :" + port + " — " + INSTITUTION + " via the Java SDK, core " + core
                + ", Java " + System.getProperty("java.version"));
    }

    // ── 은행 시스템에 들어갈 코드 ────────────────────────────────────────────

    /**
     * 은행 시스템이 이미 쓰는 전문으로 한 건: MT103 · pacs.008 · pain.001 을
     * 그대로 넘기면 판독 → 변환 → 견적 → 서명 → 제출이 호출 한 번이다.
     */
    private static void payFromSwift(Map<String, Object> rec, String message) {
        try {
            // 전문에 없는 값(자유형식 MT103 의 사업자번호 등)은 고객원장에서 — 송금인 계좌로 찾는다.
            SwiftOptions options = new SwiftOptions().supplement((payment) ->
                    PartySupplement.fromJson(customerMaster.get(payment.debtor().account())));

            // 먼저 무엇이 보내질지 본다 — 서명도 전송도 없다.
            SwiftMapping mapping = client.inspectSwift(message, options);
            SwiftPayment payment = mapping.payment();
            Map<String, Object> read = new LinkedHashMap<>();
            read.put("type", payment.messageType());
            read.put("sha256", payment.digest());
            put(rec, "message", read);
            if (payment.amount() != null) {
                put(rec, "amount", payment.amount().value() + " " + payment.amount().currency());
            }
            put(rec, "mapping", mapping.toJson());
            step(rec, "전문 판독 — client.inspectSwift(message, options)  ·  " + payment.messageType()
                    + " · SHA-256 " + payment.digest().substring(0, 16) + "…");
            if (mapping.input() == null) {
                throw new SwiftMappingException(mapping);
            }
            put(rec, "source", mapping.input().source());

            SwiftSubmission sent = client.submitSwift(message, options);
            put(rec, "paymentId", sent.paymentId());
            // 이미 있던 지급을 다시 본 것은 오늘 "지시한" 건이 아니다 — 일별 대사(:3200)가 이 표시를 보고 뺀다.
            put(rec, "already", sent.already());
            step(rec, sent.already()
                    ? "이미 제출된 전문 — 같은 지급(" + sent.paymentId() + ")을 다시 만들지 않고 이어서 추적"
                    : "제출 — client.submitSwift(message, options)  ·  견적 → 증거요소 3건·지급승인 서명(HSM) → 접수 " + sent.state());

            String[] last = { "" };
            Settlement settled = client.track(sent.paymentId(), Duration.ofMinutes(4), Duration.ofMillis(1200), (state, view) -> {
                SwiftStatus status = Swift.statusOf(view.json());
                noteSwiftStatus(rec, status);
                String sign = status.code() + "/" + status.reason();
                step(rec, sign.equals(last[0]) ? "상태 → " + state
                        : "상태 → " + state + "  ·  SWIFT 상태 " + status.code() + (status.reason() == null ? "" : " (" + status.reason() + ")"));
                last[0] = sign;
            });
            SwiftStatus status = Swift.statusOf(settled.json());
            noteSwiftStatus(rec, status);
            if (status.creditReference() != null) {
                put(rec, "creditReference", status.creditReference());
            }
            finish(rec, settled);
        } catch (SwiftMappingException e) {
            fail(rec, "전문에 지급에 필요한 값이 없습니다 — " + e.getMessage());
        } catch (SwiftMessageException e) {
            fail(rec, "전문을 읽을 수 없습니다 (" + e.code() + ") — " + e.getMessage());
        } catch (RemitException e) {
            fail(rec, "reference_reused".equals(e.code())
                    ? "같은 참조번호(UETR·전문번호)가 금액이나 당사자가 다른 지급에 이미 쓰였습니다 — 반복 제출로 보지 않고, "
                            + "아무것도 보내지 않았습니다. 지급마다 고유한 UETR을 쓰십시오."
                    : e.code() + " — " + e.getMessage());
        } catch (RuntimeException e) {
            fail(rec, String.valueOf(e));
        }
    }

    private static void noteSwiftStatus(Map<String, Object> rec, SwiftStatus status) {
        Map<String, Object> swift = new LinkedHashMap<>();
        swift.put("code", status.code());
        swift.put("reason", status.reason());
        put(rec, "swift", swift);
    }

    /** 표본 전문을 새 참조번호로: 같은 전문은 같은 지급이므로, 매번 새 UETR·전문번호를 채운다. */
    private static String freshSample(String file) throws IOException {
        String text = Files.readString(samples.resolve(file));
        String n = String.valueOf(ThreadLocalRandom.current().nextInt(100000, 1000000));
        text = UETR.matcher(text).replaceAll((m) -> UUID.randomUUID().toString());
        text = MESSAGE_NUMBER.matcher(text).replaceAll((m) -> m.group(1) + n);
        // 기업 전문(pain.001)에는 UETR이 없어 이 번호들이 곧 지급의 신원이다 — 표본끼리 겹치지 않게 여덟 자리로.
        String wide = String.valueOf(ThreadLocalRandom.current().nextInt(10000000, 100000000));
        text = CUSTOMER_NUMBER.matcher(text).replaceAll((m) -> m.group(1) + wide);
        return text;
    }

    /** 자체 데이터로 한 건: 견적 → 서명 → 제출 → 추적 → 증빙 재확인. */
    private static void payFromOwnData(Map<String, Object> rec, String amount) {
        try {
            Quote quote = client.quote(amount);
            step(rec, "견적 — client.quote(\"" + amount + "\")  ·  수납 " + quote.collectAmount() + " VND → "
                    + quote.settlementAmount() + " USDC → 지급 " + quote.payoutAmount() + " SGD");

            TradeParties parties = TradeParties.of(
                    new TradeParties.Debtor().name("Vina Trading Co., Ltd.").country("VN")
                            .address("12 Le Loi Boulevard, District 1, Ho Chi Minh City").registrationNumber("0312345678")
                            .account("VN-ACC-000777"),
                    new TradeParties.Creditor().name("Pacific Supply Pte Ltd").country("SG").account("SG-ACC-000009").bank("DBS (sim)"));
            Instruction instruction = client.buildInstruction(quote, parties, new InstructionOptions()
                    .instructionRef("JAVA-" + rec.get("id").toString().substring(0, 8)));
            put(rec, "paymentId", instruction.paymentId());
            step(rec, "서명 — client.buildInstruction(quote, parties, options)  ·  증거요소 3건과 지급승인에 HSM 서명 4회");

            Settlement accepted = client.submit(instruction);
            step(rec, "제출 — client.submit(instruction)  ·  접수 " + accepted.state());

            Settlement settled = client.track(instruction.paymentId(), Duration.ofMinutes(4), Duration.ofMillis(1200),
                    (state, view) -> step(rec, "상태 → " + state));
            finish(rec, settled);
        } catch (RemitException e) {
            fail(rec, e.code() + " — " + e.getMessage());
        } catch (RuntimeException e) {
            fail(rec, String.valueOf(e));
        }
    }

    /** 추적이 멈춘 곳에서: 끝났으면 증빙을 받아 이 프로세스에서 다시 확인한다. */
    private static void finish(Map<String, Object> rec, Settlement settled) {
        if ("EVIDENCE_ANCHORED".equals(settled.state())) {
            EvidenceReport report = EvidenceVerifier.verify(client.evidence(settled.paymentId()));
            List<Object> checks = new ArrayList<>();
            for (EvidenceReport.Check c : report.checks()) {
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("name", c.name());
                row.put("state", c.state().name());
                row.put("detail", c.detail());
                checks.add(row);
            }
            put(rec, "evidence", checks);
            put(rec, "evidenceLevel", settled.evidenceLevel());
            step(rec, "증빙 재확인 — EvidenceVerifier.verify(client.evidence(id))  ·  "
                    + (report.verified() ? "네 검사 모두 통과" : report.noneFailed() ? "실패 없음 (다시 실행하지 않은 검사 있음)" : "실패 있음"));
            put(rec, "status", "anchored");
        } else if (settled.isFinal()) {
            put(rec, "status", "stopped");
        } else {
            put(rec, "status", "paused");
        }
        put(rec, "state", settled.state());
        save();
    }

    // ── 장부 ─────────────────────────────────────────────────────────────────

    private static void step(Map<String, Object> rec, String title) {
        synchronized (BOOK) {
            @SuppressWarnings("unchecked")
            List<Object> steps = (List<Object>) rec.get("steps");
            Map<String, Object> s = new LinkedHashMap<>();
            s.put("at", Instant.now().toString());
            s.put("title", title);
            steps.add(s);
        }
        save();
    }

    private static void put(Map<String, Object> rec, String key, Object value) {
        synchronized (BOOK) {
            rec.put(key, value);
        }
    }

    private static void fail(Map<String, Object> rec, String error) {
        put(rec, "status", "failed");
        put(rec, "error", error);
        save();
    }

    private static void loadBook() throws IOException {
        Path file = here.resolve("data").resolve("payments.json");
        if (Files.isRegularFile(file)) {
            for (Object row : Json.array(Json.parse(Files.readString(file)), "invalid_book", "payments.json")) {
                Map<String, Object> rec = new LinkedHashMap<>(Json.object(row, "invalid_book", "a payment"));
                rec.put("steps", new ArrayList<>(Json.array(rec.get("steps"), "invalid_book", "steps")));
                // 서버가 꺼질 때 진행 중이던 건은 더 따라가지 않는다 — 그렇게 적어 둔다.
                if ("running".equals(rec.get("status"))) {
                    rec.put("status", "stopped");
                    rec.put("error", "서버 재시작으로 추적이 중단되었습니다 — 콘솔에서 상태를 확인하십시오");
                }
                BOOK.add(rec);
            }
        }
    }

    private static void save() {
        try {
            String text;
            synchronized (BOOK) {
                text = Json.pretty(new ArrayList<Object>(BOOK));
                Path dir = here.resolve("data");
                Files.createDirectories(dir);
                Path tmp = dir.resolve("payments.json.tmp");
                Files.writeString(tmp, text);
                Files.move(tmp, dir.resolve("payments.json"), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            }
        } catch (IOException e) {
            System.err.println("could not save the book: " + e);
        }
    }

    // ── HTTP ─────────────────────────────────────────────────────────────────

    private static void handle(HttpExchange x) throws IOException {
        try {
            String method = x.getRequestMethod();
            String path = x.getRequestURI().getPath();
            if ("GET".equals(method) && "/api/config".equals(path)) {
                Map<String, Object> config = new LinkedHashMap<>();
                config.put("bank", BANK_NAME);
                config.put("institution", INSTITUTION);
                config.put("signing", "HSM 자리(openssl 프로세스) — 개인키는 이 Java 프로세스에 들어오지 않음");
                config.put("java", System.getProperty("java.version"));
                config.put("sdk", "stonehash-attest-remit 0.1.0 (Java)");
                config.put("corePort", java.net.URI.create(core).getPort());
                json(x, 200, config);
            } else if ("GET".equals(method) && "/api/payments".equals(path)) {
                List<Object> rows;
                synchronized (BOOK) {
                    rows = new ArrayList<>();
                    for (int i = 0; i < Math.min(BOOK.size(), 30); i++) {
                        Map<String, Object> copy = new LinkedHashMap<>(BOOK.get(i));
                        copy.put("steps", new ArrayList<>((List<?>) copy.get("steps")));
                        rows.add(copy);
                    }
                }
                Map<String, Object> out = new LinkedHashMap<>();
                out.put("data", rows);
                json(x, 200, out);
            } else if ("GET".equals(method) && "/api/samples".equals(path)) {
                List<Object> rows = new ArrayList<>();
                for (String[] sample : SAMPLES) {
                    if (Files.isRegularFile(samples.resolve(sample[0]))) {
                        Map<String, Object> row = new LinkedHashMap<>();
                        row.put("file", sample[0]);
                        row.put("label", sample[1]);
                        rows.add(row);
                    }
                }
                Map<String, Object> out = new LinkedHashMap<>();
                out.put("data", rows);
                json(x, 200, out);
            } else if ("GET".equals(method) && path.startsWith("/api/samples/")) {
                String file = path.substring("/api/samples/".length());
                boolean known = false;
                for (String[] sample : SAMPLES) {
                    known = known || sample[0].equals(file);
                }
                if (!known || !Files.isRegularFile(samples.resolve(file))) {
                    json(x, 404, error("not_found", path));
                    return;
                }
                text(x, 200, "text/plain; charset=utf-8", freshSample(file), null);
            } else if ("POST".equals(method) && "/api/payments/swift".equals(path)) {
                byte[] raw = x.getRequestBody().readNBytes(512 * 1024 + 1);
                if (raw.length > 512 * 1024) {
                    json(x, 413, error("too_large", "전문이 너무 큽니다"));
                    return;
                }
                Map<String, Object> body = Json.object(Json.parse(new String(raw, StandardCharsets.UTF_8)), "invalid_json", "the request");
                String message = body.get("message") instanceof String ? (String) body.get("message") : "";
                if (message.trim().isEmpty()) {
                    json(x, 400, error("no_message", "SWIFT 전문을 붙여 넣으십시오"));
                    return;
                }
                Map<String, Object> rec = newRecord("swift", null);
                WORKERS.submit(() -> payFromSwift(rec, message));
                Map<String, Object> out = new LinkedHashMap<>();
                out.put("id", rec.get("id"));
                json(x, 202, out);
            } else if ("GET".equals(method) && path.startsWith("/api/payments/") && path.endsWith("/pacs002")) {
                String id = path.substring("/api/payments/".length(), path.length() - "/pacs002".length());
                String paymentId = null;
                synchronized (BOOK) {
                    for (Map<String, Object> rec : BOOK) {
                        if (id.equals(rec.get("id")) && rec.get("paymentId") instanceof String) {
                            paymentId = (String) rec.get("paymentId");
                        }
                    }
                }
                if (paymentId == null) {
                    json(x, 404, error("not_found", path));
                    return;
                }
                // 지급 허브가 이미 처리하는 형식으로: client.statusReport(paymentId)
                text(x, 200, "application/xml; charset=utf-8", client.statusReport(paymentId), paymentId + ".pacs002.xml");
            } else if ("POST".equals(method) && "/api/payments".equals(path)) {
                Map<String, Object> body = Json.object(Json.parse(new String(x.getRequestBody().readAllBytes(), StandardCharsets.UTF_8)), "invalid_json", "the request");
                String amount = String.valueOf(body.get("amount")).trim();
                BigDecimal value;
                try {
                    value = new BigDecimal(amount);
                } catch (NumberFormatException e) {
                    value = BigDecimal.ZERO;
                }
                if (!amount.matches("\\d{1,9}(\\.\\d{1,2})?") || value.signum() <= 0) {
                    json(x, 400, error("invalid_amount", "금액은 1000.00 처럼 적으십시오 (USD)"));
                    return;
                }
                Map<String, Object> rec = newRecord("amount", amount + " USD");
                final String asked = amount;
                WORKERS.submit(() -> payFromOwnData(rec, asked));
                Map<String, Object> out = new LinkedHashMap<>();
                out.put("id", rec.get("id"));
                json(x, 202, out);
            } else if ("GET".equals(method) && "/healthz".equals(path)) {
                Map<String, Object> ok = new LinkedHashMap<>();
                ok.put("status", "ok");
                json(x, 200, ok);
            } else if ("GET".equals(method)) {
                serveStatic(x, path);
            } else {
                json(x, 405, error("method_not_allowed", method));
            }
        } catch (RemitException e) {
            json(x, 400, error(e.code(), e.getMessage()));
        } catch (RuntimeException e) {
            json(x, 500, error("internal", String.valueOf(e)));
        } finally {
            x.close();
        }
    }

    private static Map<String, Object> newRecord(String kind, String amount) {
        Map<String, Object> rec = new LinkedHashMap<>();
        rec.put("id", UUID.randomUUID().toString());
        rec.put("kind", kind);
        rec.put("status", "running");
        rec.put("amount", amount);
        rec.put("createdAt", Instant.now().toString());
        rec.put("steps", new ArrayList<>());
        synchronized (BOOK) {
            BOOK.add(0, rec);
        }
        save();
        return rec;
    }

    private static void text(HttpExchange x, int status, String contentType, String body, String downloadAs) throws IOException {
        byte[] out = body.getBytes(StandardCharsets.UTF_8);
        x.getResponseHeaders().add("content-type", contentType);
        x.getResponseHeaders().add("cache-control", "no-store");
        if (downloadAs != null) {
            x.getResponseHeaders().add("content-disposition", "attachment; filename=\"" + downloadAs + "\"");
        }
        x.sendResponseHeaders(status, out.length);
        x.getResponseBody().write(out);
    }

    private static Map<String, Object> error(String code, String message) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("error", code);
        out.put("message", message);
        return out;
    }

    private static void json(HttpExchange x, int status, Object value) throws IOException {
        byte[] out = Json.compact(value).getBytes(StandardCharsets.UTF_8);
        x.getResponseHeaders().add("content-type", "application/json; charset=utf-8");
        x.getResponseHeaders().add("cache-control", "no-store");
        x.sendResponseHeaders(status, out.length);
        x.getResponseBody().write(out);
    }

    private static void serveStatic(HttpExchange x, String path) throws IOException {
        Path root = here.resolve("public").normalize();
        Path file = root.resolve("/".equals(path) ? "index.html" : path.substring(1)).normalize();
        if (!file.startsWith(root) || !Files.isRegularFile(file)) {
            json(x, 404, error("not_found", path));
            return;
        }
        String name = file.getFileName().toString();
        String type = name.endsWith(".html") ? "text/html; charset=utf-8" : name.endsWith(".js") ? "text/javascript; charset=utf-8"
                : name.endsWith(".css") ? "text/css; charset=utf-8" : "application/octet-stream";
        byte[] out = Files.readAllBytes(file);
        x.getResponseHeaders().add("content-type", type);
        x.getResponseHeaders().add("cache-control", "no-cache");
        x.sendResponseHeaders(200, out.length);
        x.getResponseBody().write(out);
    }
}
