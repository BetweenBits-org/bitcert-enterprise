package com.stonehash.attest.remit;

import java.io.IOException;
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
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * The test runner: every static method named {@code test...} of every class
 * whose name ends in {@code Test}, one line each, and a non-zero exit when any
 * fails.
 *
 * <p>The classes are found, not listed: whatever is under the compiled test
 * directory runs, in any package, so adding a test class is adding a file.
 *
 * <p>Usage: {@code TestMain <compiled test classes> <test resources> [name filter]}.
 */
public final class TestMain {
    private static Path resources;
    private static Path scratch;

    private TestMain() {
    }

    /** {@code src/test/resources}: the golden files and whatever else the tests read. */
    public static Path resources() {
        return resources;
    }

    /** A file under the test resources, read whole. */
    public static byte[] resource(String relative) throws IOException {
        return Files.readAllBytes(resources.resolve(relative));
    }

    /** A fresh, empty directory that is removed when the run ends. */
    public static Path newDirectory(String name) throws IOException {
        return Files.createTempDirectory(scratch, name + "-");
    }

    public static void main(String[] args) throws Exception {
        if (args.length < 2 || !Files.isDirectory(Paths.get(args[0])) || !Files.isDirectory(Paths.get(args[1]))) {
            System.err.println("usage: TestMain <compiled test classes> <test resources> [name filter]");
            System.exit(1);
        }
        Path classes = Paths.get(args[0]).toAbsolutePath();
        resources = Paths.get(args[1]).toAbsolutePath();
        String filter = args.length > 2 ? args[2] : "";
        scratch = Files.createTempDirectory("attest-remit-java-test-");
        int passed = 0;
        List<String> failed = new ArrayList<>();
        try {
            for (Class<?> suite : suites(classes)) {
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
                        System.out.println("ok   " + name);
                    } catch (InvocationTargetException e) {
                        Throwable cause = e.getCause();
                        failed.add(name);
                        System.out.println("FAIL " + name + "\n      " + cause);
                        StackTraceElement[] trace = cause.getStackTrace();
                        for (int i = 0; i < Math.min(trace.length, 6); i++) {
                            System.out.println("        at " + trace[i]);
                        }
                    }
                }
            }
        } finally {
            deleteRecursively(scratch);
        }
        System.out.println(passed + " passed, " + failed.size() + " failed" + (failed.isEmpty() ? "" : ": " + failed));
        System.exit(failed.isEmpty() && passed > 0 ? 0 : 1);
    }

    /** Every compiled class named {@code ...Test}, in the order of its fully qualified name. */
    private static List<Class<?>> suites(Path classes) throws IOException, ClassNotFoundException {
        List<String> names;
        try (Stream<Path> files = Files.walk(classes)) {
            names = files.filter((p) -> p.getFileName().toString().endsWith("Test.class"))
                    .map((p) -> classes.relativize(p).toString().replace(java.io.File.separatorChar, '.'))
                    .map((n) -> n.substring(0, n.length() - ".class".length()))
                    .sorted().collect(Collectors.toList());
        }
        List<Class<?>> out = new ArrayList<>();
        for (String name : names) {
            out.add(Class.forName(name));
        }
        return out;
    }

    private static void deleteRecursively(Path root) throws IOException {
        if (root == null || !Files.exists(root)) {
            return;
        }
        try (Stream<Path> files = Files.walk(root)) {
            for (Path p : files.sorted(Comparator.reverseOrder()).collect(Collectors.toList())) {
                Files.deleteIfExists(p);
            }
        }
    }
}
