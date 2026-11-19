package por_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
)

// goBlocks returns the Go code of the README: each block is a complete file.
func goBlocks(t *testing.T) []string {
	t.Helper()
	readme, err := os.ReadFile("README.md")
	if err != nil {
		t.Fatal(err)
	}
	var blocks []string
	for _, m := range regexp.MustCompile("(?s)```go\n(.*?)```").FindAllStringSubmatch(string(readme), -1) {
		blocks = append(blocks, m[1])
	}
	if len(blocks) < 5 {
		t.Fatalf("the README has %d Go blocks; the examples have gone missing", len(blocks))
	}
	return blocks
}

// The README tells a customer how to use the SDK from an extracted archive.
// This does what it says, in a module of its own, with the code it shows:
// the directory beside the code, the `go mod edit` line, a build; then
// `go mod vendor`, and a build again. No network is involved at any point.
func TestTheREADMEInstructionsWorkAndItsCodeCompiles(t *testing.T) {
	if testing.Short() {
		t.Skip("runs the go command several times")
	}
	goTool, err := exec.LookPath("go")
	if err != nil {
		goTool = filepath.Join(runtime.GOROOT(), "bin", "go")
	}
	readme, _ := os.ReadFile("README.md")
	edit := regexp.MustCompile(`(?s)go mod edit (-require=\S+) \\\n\s+(-replace=\S+)`).FindStringSubmatch(string(readme))
	if edit == nil {
		t.Fatal("the README no longer shows the `go mod edit` line")
	}

	customer := t.TempDir()
	extracted := filepath.Join(customer, "third_party", "attest-por-go")
	copySources(t, extracted, ".")
	for i, block := range goBlocks(t) {
		if !strings.HasPrefix(block, "package reserves\n") {
			t.Fatalf("Go block %d of the README is not a complete file of package reserves", i+1)
		}
		name := filepath.Join(customer, "reserves", "readme"+string(rune('a'+i))+".go")
		os.MkdirAll(filepath.Dir(name), 0o755)
		if err := os.WriteFile(name, []byte(block), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(customer, "go.mod"), []byte("module exchange.example/backend\n\ngo 1.21\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command(goTool, args...)
		cmd.Dir = customer
		// Nothing may be fetched; a failure to resolve offline is a failure.
		cmd.Env = append(os.Environ(), "GOPROXY=off", "GOTOOLCHAIN=local", "GOFLAGS=", "GOWORK=off")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("go %s: %v\n%s", strings.Join(args, " "), err, out)
		}
	}
	run("mod", "edit", edit[1], edit[2])
	gomod, _ := os.ReadFile(filepath.Join(customer, "go.mod"))
	for _, line := range []string{"require stonehash.com/attest/por v0.0.0", "replace stonehash.com/attest/por => ./third_party/attest-por-go"} {
		if !strings.Contains(string(gomod), line) || !strings.Contains(string(readme), line) {
			t.Errorf("go.mod and the README should both show %q; go.mod is\n%s", line, gomod)
		}
	}
	run("build", "./...")
	run("vet", "./reserves/")

	run("mod", "vendor")
	if _, err := os.Stat(filepath.Join(customer, "vendor", "stonehash.com", "attest", "por", "ledger.go")); err != nil {
		t.Fatalf("`go mod vendor` did not copy the SDK: %v", err)
	}
	// With the vendored copy in place the extracted directory is not read:
	// the build still passes when it is gone.
	if err := os.RemoveAll(filepath.Join(extracted, "ledger.go")); err != nil {
		t.Fatal(err)
	}
	run("build", "-mod=vendor", "./...")
}

// copySources copies the module as an archive of it would hold it: the Go
// files and go.mod, without the local build output.
func copySources(t *testing.T, to, from string) {
	t.Helper()
	err := filepath.WalkDir(from, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			if entry.Name() == ".build" {
				return filepath.SkipDir
			}
			return os.MkdirAll(filepath.Join(to, path), 0o755)
		}
		if !strings.HasSuffix(path, ".go") && entry.Name() != "go.mod" {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(filepath.Join(to, path), data, 0o644)
	})
	if err != nil {
		t.Fatal(err)
	}
}

// The SDK is handed over as an archive. Nothing in its pages may send the
// reader to a registry it is not on.
func TestTheDocumentsDoNotPointAtARegistry(t *testing.T) {
	for _, file := range []string{"README.md", "CONFORMANCE.md"} {
		raw, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		// Line breaks inside a sentence are not part of what it says.
		text := strings.Join(strings.Fields(string(raw)), " ")
		for _, instruction := range []string{"go get ", "go install ", "pip install", "npm install", "npm i ", "mvn ", "pkg.go.dev", "proxy.golang.org"} {
			if strings.Contains(text, instruction) {
				t.Errorf("%s contains %q", file, instruction)
			}
		}
		if file == "README.md" && !strings.Contains(text, "Developer Hub") {
			t.Error("the README does not say where the archive comes from")
		}
	}
}
