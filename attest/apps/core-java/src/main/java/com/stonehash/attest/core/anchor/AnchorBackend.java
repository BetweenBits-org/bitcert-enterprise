package com.stonehash.attest.core.anchor;

/**
 * The anchor backend seam.
 *
 * <p>This interface is the reason "regtest now, mainnet when a customer
 * subscribes" is a configuration change rather than a migration. Batching,
 * bundling, Merkle aggregation and verification all sit above it and know
 * nothing about which chain is underneath.
 *
 * <p>What a backend owns: turning a commitment into a transaction on some
 * chain, and reporting that transaction's state. What it must never own:
 * deciding what to commit, or what the result means.
 *
 * <p>Committing is two steps here, because what lies between them is the one
 * moment a stop can cost a second transaction: {@link #prepare} makes and
 * signs the transaction and names it, the caller writes that down, and only
 * then {@link #send} puts it on the network. {@link #resend} is for a
 * transaction written down earlier whose fate is not known.
 */
public interface AnchorBackend {
    /** {@code regtest} or {@code mainnet} — written verbatim into every bundle. */
    String network();

    /** Label for logs. */
    String name();

    /** A signed transaction that has not been sent yet. */
    final class Prepared {
        public final String txid;
        /** Full raw transaction hex. Bundles need it for offline binding. */
        public final String rawTxHex;
        /** The anchor output's payload, so the assembler need not re-parse the transaction. */
        public final String payloadHex;

        public Prepared(String txid, String rawTxHex, String payloadHex) {
            this.txid = txid;
            this.rawTxHex = rawTxHex;
            this.payloadHex = payloadHex;
        }
    }

    /** What became of a transaction that was written down before it was sent. */
    enum Fate {
        /** It is on the network or in a block: sent now, or known already. */
        SENT,
        /** It can never be: the node says what it spends is gone. */
        DEAD
    }

    /** The state of a transaction that was sent. */
    final class State {
        public final boolean confirmed;
        public final Long blockHeight;
        /** Display (big-endian) order, as explorers quote it. */
        public final String blockHash;
        public final long confirmations;

        public State(boolean confirmed, Long blockHeight, String blockHash, long confirmations) {
            this.confirmed = confirmed;
            this.blockHeight = blockHeight;
            this.blockHash = blockHash;
            this.confirmations = confirmations;
        }
    }

    /** Make, fund and sign the transaction that commits this payload. Nothing is sent. */
    Prepared prepare(byte[] payload) throws Exception;

    /** Send a prepared transaction. Throws if it cannot be broadcast. */
    void send(Prepared prepared) throws Exception;

    /**
     * Settle what became of a transaction recorded earlier: the same bytes
     * are sent again unless the node knows them already. Throws when the node
     * cannot say (unreachable, or a refusal that is neither) — then nothing
     * is decided and the caller asks again later.
     */
    Fate resend(String txid, String rawTxHex) throws Exception;

    /** Current state of a transaction that was sent. */
    State poll(String txid) throws Exception;

    /** Whether the node holds this transaction in its mempool: sent, and in no block yet. */
    boolean waiting(String txid) throws Exception;

    /** On a private chain nothing mines by itself: make {@code n} blocks so that a submission confirms. Refused elsewhere. */
    void generate(int n) throws Exception;
}
