package com.stonehash.attest.core.http;

/** One route. What it returns is the body of a 200, or an {@link HttpResult}. */
@FunctionalInterface
public interface Handler {
    Object handle(Ctx ctx) throws Exception;
}
