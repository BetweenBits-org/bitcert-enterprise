package com.stonehash.attest.core.db;

import org.springframework.dao.PessimisticLockingFailureException;
import org.springframework.transaction.support.TransactionCallback;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * A transaction that the database gave up on for a reason that has nothing
 * to do with what it was doing — it lost a deadlock, or waited too long for
 * a lock — is run again from its first statement.
 *
 * <p>Both leave nothing behind: the database rolled the transaction back, or
 * the template does. So the body must be something that can run again from
 * the top — it reads what it decides on inside the transaction, after its
 * lock, and keeps nothing from the try before.
 *
 * <p>Three further tries, then the failure is the caller's.
 */
public final class TxRetry {
    private TxRetry() {
    }

    /** How often a transaction is run again before its failure is passed on. */
    public static final int RETRIES = 3;

    public static <T> T execute(TransactionTemplate tx, TransactionCallback<T> body) {
        for (int tried = 0;; tried++) {
            try {
                return tx.execute(body);
            } catch (PessimisticLockingFailureException e) {
                if (tried >= RETRIES) {
                    throw e;
                }
                try {
                    // A short, growing pause: the transaction that won needs a moment to finish.
                    Thread.sleep(20L * (tried + 1));
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw e;
                }
            }
        }
    }
}
