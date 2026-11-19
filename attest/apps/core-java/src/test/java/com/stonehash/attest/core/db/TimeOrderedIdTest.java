package com.stonehash.attest.core.db;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import org.junit.jupiter.api.Test;

/** The ids of the tables this service adds: version 7 UUIDs that sort in the order they were made. */
class TimeOrderedIdTest {
    @Test
    void makesIdsThatSortInTheOrderTheyWereMade() {
        String before = null;
        long started = System.currentTimeMillis();
        for (int i = 0; i < 20_000; i++) {
            String id = TimeOrderedId.next();
            assertTrue(id.matches("[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"), id);
            if (before != null) {
                assertTrue(before.compareTo(id) < 0, before + " was made before " + id);
            }
            before = id;
        }
        // The first twelve hex digits are the time in milliseconds; a burst may borrow from the milliseconds ahead, never from those behind.
        long stamped = Long.parseLong(before.substring(0, 8) + before.substring(9, 13), 16);
        assertTrue(stamped >= started && stamped <= System.currentTimeMillis() + 20, "stamped " + stamped + ", started " + started);
    }

    @Test
    void makesNoIdTwiceOnEightThreads() throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(8);
        try {
            List<Future<List<String>>> waiting = new ArrayList<>();
            for (int t = 0; t < 8; t++) {
                waiting.add(pool.submit(() -> {
                    List<String> made = new ArrayList<>();
                    for (int i = 0; i < 5_000; i++) {
                        made.add(TimeOrderedId.next());
                    }
                    return made;
                }));
            }
            Set<String> all = new HashSet<>();
            for (Future<List<String>> f : waiting) {
                List<String> made = f.get();
                for (int i = 1; i < made.size(); i++) {
                    assertTrue(made.get(i - 1).compareTo(made.get(i)) < 0, "in order on each thread");
                }
                all.addAll(made);
            }
            assertEquals(40_000, all.size());
        } finally {
            pool.shutdownNow();
        }
    }
}
