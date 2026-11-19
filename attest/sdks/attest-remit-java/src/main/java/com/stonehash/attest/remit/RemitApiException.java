package com.stonehash.attest.remit;

/**
 * The platform refused, or something between this machine and the platform
 * answered in its place.
 *
 * <p>{@link #status()} is the HTTP status; {@link #code()} is the platform's
 * own error code when it refused in its own JSON. An answer that is not the
 * platform's — a gateway's error page, a login wall, a redirect — is reported
 * as status 502 with the code {@code not_a_platform_answer}: the request may
 * or may not have arrived, and nothing is taken to have happened.
 */
public final class RemitApiException extends RemitException {
    private static final long serialVersionUID = 1L;

    private final int status;
    private final String existingPaymentId;
    private final String ground;

    public RemitApiException(int status, String code, String message) {
        this(status, code, message, (String) null);
    }

    /**
     * @param existingPaymentId the settlement that already stands for the message, where the refusal names one; {@code null} otherwise
     */
    public RemitApiException(int status, String code, String message, String existingPaymentId) {
        this(status, code, message, existingPaymentId, null);
    }

    /**
     * @param existingPaymentId the settlement that already stands for the message, where the refusal names one; {@code null} otherwise
     * @param ground            on what ground the platform took the two for one payment, where it says; {@code null} otherwise
     */
    public RemitApiException(int status, String code, String message, String existingPaymentId, String ground) {
        super(code, message);
        this.status = status;
        this.existingPaymentId = existingPaymentId;
        this.ground = ground;
    }

    public RemitApiException(int status, String code, String message, Throwable cause) {
        super(code, message, cause);
        this.status = status;
        this.existingPaymentId = null;
        this.ground = null;
    }

    public int status() {
        return status;
    }

    /**
     * With {@code duplicate_source_message}, {@code reference_reused} and
     * {@code payment_id_conflict}: the settlement that already stands for the
     * message — for a program to act on, so that it does not have to read the
     * id out of the sentence. {@code null} for every other refusal.
     */
    public String existingPaymentId() {
        return existingPaymentId;
    }

    /**
     * With {@code duplicate_source_message}: on what ground the platform took
     * the two for one payment — {@code message} (the same transaction of the
     * same file), {@code uetr}, {@code twin} (the same payment in another
     * message) or {@code twin_undated} (nothing tells the two apart: a
     * refusal, not a recognition). With {@code reference_reused} it is
     * {@code uetr}. {@code null} where the refusal names none.
     */
    public String ground() {
        return ground;
    }
}
