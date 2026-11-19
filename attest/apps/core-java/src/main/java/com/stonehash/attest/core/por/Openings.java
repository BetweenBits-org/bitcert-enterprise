package com.stonehash.attest.core.por;

import com.stonehash.attest.core.json.Js;
import com.stonehash.attest.core.json.JsValues;
import java.util.ArrayList;
import java.util.List;

/**
 * The indices a set of openings covers, put in order and written out — as
 * the service has always ordered and written them, whatever was sent where
 * an index belongs.
 */
final class Openings {
    private Openings() {
    }

    /**
     * The values in ascending order of the numbers they are. A value that
     * was not given at all goes last. One that is no number compares as
     * equal to everything, so it stays where a stable sort leaves it.
     */
    static List<Object> sorted(List<Object> values) {
        List<Object> given = new ArrayList<>();
        int absent = 0;
        for (Object v : values) {
            if (v == Js.UNDEFINED) {
                absent++;
            } else {
                given.add(v);
            }
        }
        double[] key = new double[given.size()];
        boolean ordered = true;
        for (int i = 0; i < key.length; i++) {
            key[i] = SumTree.number(given.get(i));
            ordered = ordered && !Double.isNaN(key[i]);
        }
        List<Object> out;
        if (ordered) {
            // Every value is a number: any stable sort comes to the one answer.
            Integer[] order = new Integer[key.length];
            for (int i = 0; i < order.length; i++) {
                order[i] = i;
            }
            java.util.Arrays.sort(order, (a, b) -> sign(key[a] - key[b]));
            out = new ArrayList<>();
            for (int i : order) {
                out.add(given.get(i));
            }
        } else {
            out = insertionSorted(given, key);
        }
        for (int i = 0; i < absent; i++) {
            out.add(Js.UNDEFINED);
        }
        return out;
    }

    private static int sign(double d) {
        return d < 0 ? -1 : d > 0 ? 1 : 0;
    }

    /**
     * With a value among them that is no number the comparison is not an
     * order, and the result depends on how the sort goes about it: a run
     * found at the start, then each further value put in place by bisection
     * — the way the previous runtime sorted a short list.
     */
    private static List<Object> insertionSorted(List<Object> values, double[] keys) {
        int n = values.size();
        Integer[] a = new Integer[n];
        for (int i = 0; i < n; i++) {
            a[i] = i;
        }
        if (n < 2) {
            return new ArrayList<>(values);
        }
        int run = 2;
        boolean descending = sign(keys[a[1]] - keys[a[0]]) < 0;
        while (run < n) {
            int order = sign(keys[a[run]] - keys[a[run - 1]]);
            if (descending ? order >= 0 : order < 0) {
                break;
            }
            run++;
        }
        if (descending) {
            for (int lo = 0, hi = run - 1; lo < hi; lo++, hi--) {
                Integer t = a[lo];
                a[lo] = a[hi];
                a[hi] = t;
            }
        }
        for (int start = run; start < n; start++) {
            int left = 0;
            int right = start;
            Integer pivot = a[start];
            while (left < right) {
                int mid = left + ((right - left) >> 1);
                if (sign(keys[pivot] - keys[a[mid]]) < 0) {
                    right = mid;
                } else {
                    left = mid + 1;
                }
            }
            System.arraycopy(a, left, a, left + 1, start - left);
            a[left] = pivot;
        }
        List<Object> out = new ArrayList<>();
        for (int i : a) {
            out.add(values.get(i));
        }
        return out;
    }

    /** The values with commas between them; nothing for one that is absent or {@code null}. */
    static String joined(List<?> values) {
        StringBuilder out = new StringBuilder();
        boolean first = true;
        for (Object v : values) {
            if (!first) {
                out.append(',');
            }
            first = false;
            if (!JsValues.nullish(v)) {
                out.append(JsValues.string(v));
            }
        }
        return out.toString();
    }
}
