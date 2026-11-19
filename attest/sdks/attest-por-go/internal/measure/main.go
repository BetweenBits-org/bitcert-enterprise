// Command measure times the road from ledger rows in memory to a built tree
// and reports the memory it took. The size figures in the README come from
// it; scripts/measure.sh runs it under /usr/bin/time.
//
// The rows are synthetic and deterministic: every account holds each of
// three assets with probability three in four, amounts written as a ledger
// prints them. They are all in memory before the clock starts, as a result
// set a driver has buffered would be, so the peak the process reaches is the
// input and what the SDK builds from it together.
//
// With -export the same rows are written out as a balance export instead, so
// that the road through a file can be timed with the example program.
package main

import (
	"bufio"
	"flag"
	"fmt"
	"math/rand"
	"os"
	"runtime"
	"strings"
	"time"

	por "stonehash.com/attest/por"
)

type row struct{ account, asset, amount string }

var assets = []por.Asset{{Symbol: "BTC", Decimals: 8}, {Symbol: "ETH", Decimals: 18}, {Symbol: "USDT", Decimals: 6}}

func main() {
	accounts := flag.Int("accounts", 0, "number of accounts")
	export := flag.String("export", "", "write the rows to this CSV file instead of measuring")
	flag.Parse()
	if *accounts <= 0 {
		fmt.Fprintln(os.Stderr, "usage: measure -accounts N [-export FILE]")
		os.Exit(1)
	}
	run := measure
	if *export != "" {
		run = func(accounts int) error { return writeExport(*export, accounts) }
	}
	if err := run(*accounts); err != nil {
		fmt.Fprintln(os.Stderr, "measure:", err)
		os.Exit(1)
	}
}

// writeExport writes the synthetic ledger in the long layout.
func writeExport(path string, accounts int) error {
	file, err := os.Create(path)
	if err != nil {
		return err
	}
	out := bufio.NewWriter(file)
	fmt.Fprintln(out, "account_id,asset,balance")
	for _, r := range synthesise(accounts) {
		fmt.Fprintf(out, "%s,%s,%s\n", r.account, r.asset, r.amount)
	}
	if err := out.Flush(); err != nil {
		file.Close()
		return err
	}
	return file.Close()
}

func measure(accounts int) error {
	rows := synthesise(accounts)
	input := heapInUse()

	started := time.Now()
	builder, err := por.NewLedgerBuilder(por.LedgerOptions{Assets: assets, Amounts: por.Decimal})
	if err != nil {
		return err
	}
	for _, r := range rows {
		if err := builder.Add(r.account, r.asset, r.amount); err != nil {
			return err
		}
	}
	ledger, report := builder.Finish()
	if !report.OK {
		return fmt.Errorf("the synthetic ledger was refused: %v", report.Problems)
	}
	read := time.Since(started)

	seed := make([]byte, por.SeedSize)
	for i := range seed {
		seed[i] = byte(i)
	}
	tree, err := por.BuildTree("KR-EX-measure", seed, ledger)
	if err != nil {
		return err
	}
	total := time.Since(started)

	// The work is real: a proof from the tree holds against its root.
	proof, err := tree.Proof(accounts / 2)
	if err != nil {
		return err
	}
	if err := por.VerifyProof(proof, tree.Root(), tree.Totals()); err != nil {
		return err
	}

	withInput := heapInUse()
	// Without this the collector may already have taken the rows: nothing
	// after the loop above reads them.
	runtime.KeepAlive(rows)
	rowCount := len(rows)
	rows = nil
	kept := heapInUse()
	fmt.Printf("accounts            %d\n", accounts)
	fmt.Printf("assets              %d\n", len(assets))
	fmt.Printf("rows                %d\n", rowCount)
	fmt.Printf("ledger              %.2f s   (LedgerBuilder.Add for every row, Finish)\n", read.Seconds())
	fmt.Printf("tree                %.2f s   (BuildTree: leaves derived, ordered, folded)\n", (total - read).Seconds())
	fmt.Printf("rows to root        %.2f s\n", total.Seconds())
	fmt.Printf("heap, input rows    %d MB\n", megabytes(input))
	fmt.Printf("heap, with the tree %d MB   (input rows, ledger and tree)\n", megabytes(withInput))
	fmt.Printf("heap, SDK only      %d MB   (ledger and tree, input rows released)\n", megabytes(kept))
	fmt.Printf("peak resident set   %d MB   (the whole process, from the kernel)\n", peakResidentMB())
	fmt.Printf("root                %s\n", tree.Root())
	runtime.KeepAlive(ledger)
	runtime.KeepAlive(tree)
	return nil
}

func synthesise(accounts int) []row {
	rng := rand.New(rand.NewSource(0x5eed))
	rows := make([]row, 0, accounts*len(assets))
	for i := 0; i < accounts; i++ {
		account := fmt.Sprintf("user-%07d", i+1)
		held := 0
		for j, a := range assets {
			// Not every account holds every asset; every account holds one.
			if rng.Intn(4) == 0 && !(j == len(assets)-1 && held == 0) {
				continue
			}
			held++
			// A heavy tail: most balances small, a few large.
			whole := rng.Int63n(1 + rng.Int63n(1+rng.Int63n(1_000_000)))
			fraction := rng.Int63n(pow10(min(a.Decimals, 9)))
			rows = append(rows, row{account, a.Symbol, fmt.Sprintf("%d.%0*d", whole, min(a.Decimals, 9), fraction)})
		}
	}
	return rows
}

func pow10(n int) int64 {
	p := int64(1)
	for i := 0; i < n; i++ {
		p *= 10
	}
	return p
}

// heapInUse is the live heap after a collection.
func heapInUse() uint64 {
	runtime.GC()
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	return m.HeapAlloc
}

func megabytes(bytes uint64) uint64 { return (bytes + 1<<19) >> 20 }

// peakResidentMB reads the process's high-water mark from the kernel. It is
// zero where /proc is not available; /usr/bin/time -v reports the same figure.
func peakResidentMB() uint64 {
	status, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(status), "\n") {
		if rest, ok := strings.CutPrefix(line, "VmHWM:"); ok {
			var kb uint64
			fmt.Sscanf(strings.TrimSpace(rest), "%d", &kb)
			return (kb + 512) >> 10
		}
	}
	return 0
}
