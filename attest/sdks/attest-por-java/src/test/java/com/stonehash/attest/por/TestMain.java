package com.stonehash.attest.por;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.stream.Stream;

/**
 * The test runner: every static method named {@code test...} of the classes
 * listed here, one line each, and a non-zero exit when any fails.
 *
 * <p>Usage: {@code TestMain <vectors directory> [name filter]}.
 */
public final class TestMain {
    private static final List<Class<?>> SUITES = Arrays.asList(
            JsonTest.class, AmountsTest.class, CsvTest.class, LedgerBuilderTest.class, TreeTest.class,
            StatementTest.class, ClientTest.class, SnapshotDirectoryTest.class, ExampleTest.class);

    private static Path vectors;
    private static Path scratch;

    private TestMain() {
    }

    /** The directory holding SPEC.md and the conformance vectors. */
    static Path vectors() {
        return vectors;
    }

    /** A fresh, empty directory that is removed when the run ends. */
    static Path newDirectory(String name) throws java.io.IOException {
        return Files.createTempDirectory(scratch, name + "-");
    }

    public static void main(String[] args) throws Exception {
        if (args.length < 1 || !Files.isRegularFile(Paths.get(args[0]).resolve("SPEC.md"))) {
            System.err.println("usage: TestMain <directory holding SPEC.md and the vectors> [name filter]");
            System.exit(1);
        }
        vectors = Paths.get(args[0]).toAbsolutePath();
        String filter = args.length > 1 ? args[1] : "";
        scratch = Files.createTempDirectory("attest-por-java-test-");
        int passed = 0;
        List<String> failed = new ArrayList<>();
        try {
            for (Class<?> suite : SUITES) {
                Method[] methods = suite.getDeclaredMethods();
                Arrays.sort(methods, Comparator.comparing(Method::getName));
                for (Method m : methods) {
                    String name = suite.getSimpleName() + "." + m.getName();
                    if (!m.getName().startsWith("test") || !Modifier.isStatic(m.getModifiers()) || !name.contains(filter)) {
                        continue;
                    }
                    m.setAccessible(true);
                    try {
                        m.invoke(null);
                        passed++;
                        System.out.println("ok    " + name);
                    } catch (InvocationTargetException e) {
                        failed.add(name);
                        System.out.println("FAIL  " + name);
                        e.getCause().printStackTrace(System.out);
                    }
                }
            }
        } finally {
            try (Stream<Path> files = Files.walk(scratch)) {
                for (Path p : (Iterable<Path>) files.sorted(Comparator.reverseOrder())::iterator) {
                    Files.delete(p);
                }
            }
        }
        System.out.println();
        System.out.println((passed + failed.size()) + " tests, " + passed + " passed, " + failed.size() + " failed");
        for (String name : failed) {
            System.out.println("  failed: " + name);
        }
        System.exit(failed.isEmpty() ? 0 : 1);
    }
}
