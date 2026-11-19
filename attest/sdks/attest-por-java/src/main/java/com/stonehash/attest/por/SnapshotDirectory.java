package com.stonehash.attest.por;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.math.BigInteger;
import java.nio.channels.Channels;
import java.nio.channels.SeekableByteChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.EnumSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * The exchange's private record of a snapshot: what it keeps, and how it is
 * read back (specification §8).
 *
 * <p>A snapshot is useful to a customer only for as long as the exchange can
 * still issue that customer's proof, and a proof needs the leaf's salt and its
 * neighbours all the way up. So a build leaves behind, in a directory the
 * exchange keeps:
 * <pre>
 * snapshot.json   the statement — root and totals. The only part ever sent anywhere.
 * leaves.jsonl    one line per account, in tree order: its reference, its hash,
 *                 its salt, its balances. Private; mode 0600.
 * seed.hex        the secret every salt was derived from. Private; mode 0600.
 * tree.json       a small header naming the root and the leaves file.
 * </pre>
 * The tree itself is not stored. It is a function of the leaves, so it is
 * rebuilt when a proof is needed — and the rebuilt root is compared with the
 * recorded one before anything is issued from it. A leaves file that was
 * edited, truncated or mixed up with another day's fails that comparison
 * instead of producing proofs that do not verify.
 *
 * <p>The layout is shared by the SDKs in every language: a directory written
 * by one is read by the others.
 */
public final class SnapshotDirectory {
    public static final String SNAPSHOT_FILE = "snapshot.json";
    public static final String SUBMISSION_FILE = "submission.json";
    public static final String LEAVES_FILE = "leaves.jsonl";
    public static final String SEED_FILE = "seed.hex";
    public static final String TREE_FILE = "tree.json";
    public static final String RECEIPT_FILE = "receipt.json";
    public static final String OPENINGS_FILE = "openings.json";

    private static final String TREE_SCHEMA = "stonehash.por-tree.v2";
    private static final String OPENINGS_SCHEMA = "stonehash.por-openings.v1";
    private static final Set<PosixFilePermission> OWNER_ONLY = PosixFilePermissions.fromString("rw-------");
    /** A leaf line is a few hundred bytes; one this long is a file that lost its line breaks. */
    private static final int MAX_LINE_BYTES = 16 << 20;

    private SnapshotDirectory() {
    }

    // ── writing ─────────────────────────────────────────────────────────────

    /**
     * Writes the private files of a snapshot that has just been built:
     * {@code leaves.jsonl}, {@code tree.json}, {@code seed.hex} and
     * {@code snapshot.json}. The directory is created if need be.
     *
     * <p>Refused when the directory holds a receipt and another snapshot — a
     * different seed or a different root. A receipt means the platform has
     * taken that snapshot's statement; overwriting its leaves and seed would
     * destroy the only means of issuing proofs for it. A new snapshot gets a
     * new directory. A directory with no receipt is overwritten.
     *
     * @param seed the seed the tree was built with
     * @throws PorException {@code statement_mismatch}, {@code seed_mismatch}, {@code snapshot_exists},
     *                      {@code permissions_unsupported} (the file system cannot restrict a file to its
     *                      owner) or {@code io_error}
     */
    public static void write(Path dir, PorTree tree, byte[] seed, Statement statement) {
        Objects.requireNonNull(dir, "dir");
        Objects.requireNonNull(tree, "tree");
        Objects.requireNonNull(statement, "statement").requireValid();
        if (!tree.root().equals(statement.root()) || tree.leafCount() != statement.leafCount()
                || !tree.totals().equals(statement.totals()) || !tree.exchangeId().equals(statement.institutionId())) {
            throw new PorException("statement_mismatch",
                    "the statement does not declare this tree's exchange, root, totals and account count; nothing was written");
        }
        // A seed that does not reproduce the salts would be a file that looks like a backup and is not one.
        if (!Leaves.salt(seed, tree.userRef(0)).equals(tree.salt(0))) {
            throw new PorException("seed_mismatch", "that is not the seed this tree was built with; nothing was written");
        }
        // Asked before anything is created: the seed must not land, even briefly, where it cannot be kept private.
        if (!dir.getFileSystem().supportedFileAttributeViews().contains("posix")) {
            throw new PorException("permissions_unsupported", "the file system holding " + dir
                    + " cannot restrict a file to its owner; keep the snapshot's private files on one that can");
        }
        String seedLine = Hex.encode(seed) + "\n";
        try {
            refuseToReplaceAnotherSnapshot(dir, tree, seedLine);
            Files.createDirectories(dir);

            MessageDigest sha = Hex.sha256();
            try (OutputStream out = new BufferedOutputStream(privateFile(dir.resolve(LEAVES_FILE)), 1 << 16)) {
                for (int i = 0; i < tree.leafCount(); i++) {
                    byte[] line = (Json.compact(storedLeaf(tree, i)) + "\n").getBytes(StandardCharsets.UTF_8);
                    sha.update(line);
                    out.write(line);
                }
            }

            Map<String, Object> header = new LinkedHashMap<>();
            header.put("schema", TREE_SCHEMA);
            header.put("exchange_id", tree.exchangeId());
            header.put("assets", new ArrayList<Object>(tree.assets()));
            header.put("leaf_count", (long) tree.leafCount());
            header.put("root", tree.root());
            header.put("totals", InclusionProof.amounts(tree.totals()));
            header.put("leaves_file", LEAVES_FILE);
            header.put("leaves_sha256", Hex.encode(sha.digest()));
            writePrivate(dir.resolve(TREE_FILE), Json.pretty(header) + "\n");
            writePrivate(dir.resolve(SEED_FILE), seedLine);
            writeText(dir.resolve(SNAPSHOT_FILE), statement.toJson() + "\n");
        } catch (IOException e) {
            throw new PorException("io_error", "could not write the snapshot to " + dir + ": " + e.getMessage(), e);
        }
    }

    /** Writes {@code submission.json}: the statement and its signature, everything a submit sends. */
    public static void writeSubmission(Path dir, Submission submission) {
        writeJson(dir.resolve(SUBMISSION_FILE), Objects.requireNonNull(submission, "submission").toJson());
    }

    /** Writes {@code receipt.json}: what the platform answered. */
    public static void writeReceipt(Path dir, Receipt receipt) {
        writeJson(dir.resolve(RECEIPT_FILE), Objects.requireNonNull(receipt, "receipt").toJson());
    }

    /**
     * Writes {@code openings.json}: an exact record of the account-level data
     * that left the exchange in answer to a spot check.
     */
    public static void writeOpenings(Path dir, List<InclusionProof> openings) {
        List<Object> list = new ArrayList<>();
        for (InclusionProof opening : Objects.requireNonNull(openings, "openings")) {
            list.add(opening.toMap());
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("schema", OPENINGS_SCHEMA);
        out.put("openings", list);
        writeJson(dir.resolve(OPENINGS_FILE), Json.pretty(out));
    }

    /** Writes a customer's proof file where the caller says; it is theirs to hand over. */
    public static void writeProofFile(Path file, ProofFile proof) {
        writeJson(file, Objects.requireNonNull(proof, "proof").toJson());
    }

    // ── reading ─────────────────────────────────────────────────────────────

    /**
     * Reads a snapshot directory back and rebuilds its tree — one written by
     * this SDK or by any of the others.
     *
     * <p>Refuses when the leaves file is not the one recorded in the header,
     * or does not reproduce the recorded root: issuing a proof from a tree
     * that is not the anchored one would hand a customer a file that fails,
     * and leave them to conclude the exchange left them out.
     *
     * @throws PorException {@code not_a_snapshot}, {@code unsupported_snapshot}, {@code leaves_checksum},
     *                      {@code damaged_leaves}, {@code root_mismatch} or {@code io_error}
     */
    public static PorTree load(Path dir) {
        Objects.requireNonNull(dir, "dir");
        Path headerPath = dir.resolve(TREE_FILE);
        if (!Files.exists(headerPath)) {
            throw new PorException("not_a_snapshot", dir + " has no " + TREE_FILE + "; it is not a snapshot directory");
        }
        Map<String, Object> header = Json.object(Json.parse(readText(headerPath), "unsupported_snapshot"),
                "unsupported_snapshot", TREE_FILE);
        if (!TREE_SCHEMA.equals(header.get("schema"))) {
            throw new PorException("unsupported_snapshot", headerPath + " is not a tree header this SDK reads (it reads "
                    + TREE_SCHEMA + ")");
        }
        String code = "unsupported_snapshot";
        String exchangeId = Json.string(header.get("exchange_id"), code, "exchange_id");
        List<String> assets = new ArrayList<>();
        for (Object a : Json.array(header.get("assets"), code, "assets")) {
            assets.add(Json.string(a, code, "an entry of assets"));
        }
        long leafCount = Json.integer(header.get("leaf_count"), code, "leaf_count");
        String root = Json.string(header.get("root"), code, "root");
        String recordedChecksum = Json.string(header.get("leaves_sha256"), code, "leaves_sha256");
        Map<String, BigInteger> totals = new LinkedHashMap<>();
        for (Map.Entry<String, Object> e : Json.object(header.get("totals"), code, "totals").entrySet()) {
            totals.put(e.getKey(), InclusionProof.amount(e.getValue(), code, "totals." + e.getKey()));
        }
        // The header names its leaves file; anything but the fixed name would be a path chosen by whoever edited the header.
        if (!LEAVES_FILE.equals(header.get("leaves_file"))) {
            throw new PorException(code, "leaves_file must be " + LEAVES_FILE);
        }

        PorTree.Builder builder = PorTree.builder(exchangeId, assets);
        MessageDigest sha = Hex.sha256();
        PorException damaged = null;
        try (InputStream in = new BufferedInputStream(Files.newInputStream(dir.resolve(LEAVES_FILE)), 1 << 16)) {
            ByteSink line = new ByteSink();
            long lineNumber = 0;
            byte[] chunk = new byte[1 << 16];
            int n;
            boolean more = true;
            while (more) {
                n = in.read(chunk);
                more = n >= 0;
                if (more) {
                    sha.update(chunk, 0, n);
                }
                int end = more ? n : 1;
                for (int i = 0; i < end; i++) {
                    // The end of the file ends the last line, whether or not a line break did.
                    boolean lineEnd = !more || chunk[i] == '\n';
                    if (!lineEnd) {
                        if (line.length() >= MAX_LINE_BYTES) {
                            throw new PorException("damaged_leaves", LEAVES_FILE + " line " + (lineNumber + 1)
                                    + " is longer than any leaf; the file is damaged");
                        }
                        line.put(chunk[i]);
                        continue;
                    }
                    lineNumber++;
                    // Once one line has failed the file is read on only for its checksum.
                    if (damaged == null && line.length() > 0) {
                        try {
                            addLeaf(builder, line, lineNumber);
                        } catch (PorException e) {
                            damaged = e;
                        }
                    }
                    line.reset();
                }
            }
        } catch (NoSuchFileException e) {
            throw new PorException("not_a_snapshot", dir + " has no " + LEAVES_FILE);
        } catch (IOException e) {
            throw new PorException("io_error", "could not read " + dir.resolve(LEAVES_FILE) + ": " + e.getMessage(), e);
        }

        if (!Hex.encode(sha.digest()).equals(recordedChecksum)) {
            throw new PorException("leaves_checksum", LEAVES_FILE + " is not the file this snapshot was built from "
                    + "(its checksum differs from the one recorded in " + TREE_FILE + ")");
        }
        if (damaged != null) {
            throw damaged;
        }
        PorTree tree = builder.build();
        if (!tree.root().equals(root) || tree.leafCount() != leafCount || !tree.totals().equals(totals)) {
            throw new PorException("root_mismatch",
                    "the leaves do not reproduce the recorded root; refusing to issue anything from them");
        }
        return tree;
    }

    /** Reads {@code snapshot.json}. */
    public static Statement readStatement(Path dir) {
        return Statement.parse(readText(dir.resolve(SNAPSHOT_FILE)));
    }

    /** Reads {@code submission.json}. */
    public static Submission readSubmission(Path dir) {
        return Submission.parse(readText(dir.resolve(SUBMISSION_FILE)));
    }

    /** Reads a customer's proof file. */
    public static ProofFile readProofFile(Path file) {
        return ProofFile.parse(readText(file));
    }

    // ── the pieces ──────────────────────────────────────────────────────────

    /** A leaf as stored: zero balances are implied, so they are not written. */
    private static Map<String, Object> storedLeaf(PorTree tree, int index) {
        Map<String, Object> balances = new LinkedHashMap<>();
        for (Map.Entry<String, BigInteger> e : tree.leaf(index).balances().entrySet()) {
            if (e.getValue().signum() != 0) {
                balances.put(e.getKey(), e.getValue().toString());
            }
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("user_ref", tree.userRef(index));
        out.put("user_ref_hash", tree.userRefHash(index));
        out.put("salt", tree.salt(index));
        out.put("balances", balances);
        return out;
    }

    private static void addLeaf(PorTree.Builder builder, ByteSink line, long lineNumber) {
        String code = "damaged_leaves";
        String where = LEAVES_FILE + " line " + lineNumber;
        byte[] bytes = Arrays.copyOf(line.array(), line.length());
        String text = Text.decodeUtf8(bytes, code, where);
        if (text.endsWith("\r")) {
            text = text.substring(0, text.length() - 1);
        }
        if (text.isEmpty()) {
            return;
        }
        Map<String, Object> leaf;
        try {
            leaf = Json.object(Json.parse(text, code), code, where);
        } catch (PorException e) {
            throw new PorException(code, where + " is not a leaf; the file is damaged");
        }
        Map<String, BigInteger> balances = new LinkedHashMap<>();
        for (Map.Entry<String, Object> e : Json.object(leaf.get("balances"), code, where + " balances").entrySet()) {
            balances.put(e.getKey(), InclusionProof.amount(e.getValue(), code, where + " " + e.getKey()));
        }
        try {
            builder.addLeaf(Json.string(leaf.get("user_ref"), code, where + " user_ref"),
                    Json.string(leaf.get("user_ref_hash"), code, where + " user_ref_hash"),
                    Json.string(leaf.get("salt"), code, where + " salt"), balances);
        } catch (PorException e) {
            throw new PorException(code, where + ": " + e.getMessage());
        }
    }

    private static void refuseToReplaceAnotherSnapshot(Path dir, PorTree tree, String seedLine) throws IOException {
        // Until a snapshot has been handed over, nothing outside this directory depends on it.
        if (!Files.exists(dir.resolve(RECEIPT_FILE))) {
            return;
        }
        Path seedFile = dir.resolve(SEED_FILE);
        Path treeFile = dir.resolve(TREE_FILE);
        boolean other = Files.exists(seedFile) && !readText(seedFile).equals(seedLine);
        if (!other && Files.exists(treeFile)) {
            Object header;
            try {
                header = Json.parse(readText(treeFile), "unsupported_snapshot");
            } catch (PorException unreadable) {
                header = null;
            }
            other = !(header instanceof Map) || !tree.root().equals(((Map<?, ?>) header).get("root"));
        }
        if (other) {
            throw new PorException("snapshot_exists", dir + " holds another snapshot, and the receipt of its submission. "
                    + "Its leaves and seed are the only way to issue proofs for it; write the new snapshot to a new directory");
        }
    }

    /** Opens a file only its owner can read, from its first byte. */
    private static OutputStream privateFile(Path file) throws IOException {
        SeekableByteChannel channel = Files.newByteChannel(file,
                EnumSet.of(StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING, StandardOpenOption.WRITE),
                PosixFilePermissions.asFileAttribute(OWNER_ONLY));
        try {
            // The mode given at creation does not apply to a file that already existed; state it outright.
            Files.setPosixFilePermissions(file, OWNER_ONLY);
        } catch (IOException | RuntimeException e) {
            channel.close();
            throw e;
        }
        return Channels.newOutputStream(channel);
    }

    private static void writePrivate(Path file, String text) throws IOException {
        try (OutputStream out = privateFile(file)) {
            out.write(text.getBytes(StandardCharsets.UTF_8));
        }
    }

    private static void writeText(Path file, String text) throws IOException {
        Files.write(file, text.getBytes(StandardCharsets.UTF_8));
    }

    private static void writeJson(Path file, String json) {
        try {
            writeText(file, json + "\n");
        } catch (IOException e) {
            throw new PorException("io_error", "could not write " + file + ": " + e.getMessage(), e);
        }
    }

    private static String readText(Path file) {
        try {
            return Text.decodeUtf8(Files.readAllBytes(file), "io_error", file.toString());
        } catch (NoSuchFileException e) {
            throw new PorException("not_found", file + " does not exist");
        } catch (IOException e) {
            throw new PorException("io_error", "could not read " + file + ": " + e.getMessage(), e);
        }
    }
}
