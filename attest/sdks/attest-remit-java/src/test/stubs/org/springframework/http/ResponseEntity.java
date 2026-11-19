package org.springframework.http;

public class ResponseEntity<T> {
    public interface HeadersBuilder<B extends HeadersBuilder<B>> {
        <T> ResponseEntity<T> build();
    }

    public interface BodyBuilder extends HeadersBuilder<BodyBuilder> {
        <T> ResponseEntity<T> body(T body);
    }

    public static BodyBuilder status(HttpStatus status) {
        throw new UnsupportedOperationException("a stand-in for compiling the examples");
    }

    public static BodyBuilder ok() {
        throw new UnsupportedOperationException("a stand-in for compiling the examples");
    }

    public static <T> ResponseEntity<T> ok(T body) {
        throw new UnsupportedOperationException("a stand-in for compiling the examples");
    }

    public static HeadersBuilder<?> noContent() {
        throw new UnsupportedOperationException("a stand-in for compiling the examples");
    }
}
