package por

import (
	"strconv"
	"strings"

	"stonehash.com/attest/por/internal/cjson"
)

// reader takes typed members out of a JSON object. Every refusal carries the
// same code — the document's — and names the member by its path, so a message
// reads "tree.json: leaf_count must be an integer".
type reader struct {
	code string
	// prefix is what precedes a member's name in a message: "tree.json: " at
	// the top of a file, "tree." inside the member called tree.
	prefix string
	obj    cjson.Object
}

// parseDocument reads data as one JSON object.
func parseDocument(data []byte, code, prefix string) (reader, *Error) {
	v, err := cjson.Parse(data)
	if err != nil {
		return reader{}, wrap(code, err, "%s", subject(prefix))
	}
	return readObject(v, code, prefix)
}

func readObject(v any, code, prefix string) (reader, *Error) {
	obj, ok := v.(cjson.Object)
	if !ok {
		return reader{}, errorf(code, "%s must be a JSON object", subject(prefix))
	}
	return reader{code: code, prefix: prefix, obj: obj}, nil
}

// subject names the object a prefix leads into.
func subject(prefix string) string {
	if name := strings.TrimRight(prefix, ".: "); name != "" {
		return name
	}
	return "the document"
}

func (r reader) has(key string) bool {
	_, ok := r.obj.Get(key)
	return ok
}

func (r reader) str(key string) (string, *Error) {
	v, _ := r.obj.Get(key)
	s, ok := v.(string)
	if !ok {
		return "", errorf(r.code, "%s%s must be a string", r.prefix, key)
	}
	return s, nil
}

// optStr reads a string member that may be absent or null.
func (r reader) optStr(key string) (string, *Error) {
	if v, ok := r.obj.Get(key); !ok || v == nil {
		return "", nil
	}
	return r.str(key)
}

func (r reader) integer(key string) (int64, *Error) {
	v, _ := r.obj.Get(key)
	n, ok := v.(int64)
	if !ok {
		return 0, errorf(r.code, "%s%s must be an integer", r.prefix, key)
	}
	return n, nil
}

func (r reader) object(key string) (reader, *Error) {
	v, _ := r.obj.Get(key)
	return readObject(v, r.code, r.prefix+key+".")
}

func (r reader) array(key string) ([]any, *Error) {
	v, _ := r.obj.Get(key)
	arr, ok := v.([]any)
	if !ok {
		return nil, errorf(r.code, "%s%s must be an array", r.prefix, key)
	}
	return arr, nil
}

// item reads the i-th element of the array member key as an object.
func (r reader) item(key string, i int, v any) (reader, *Error) {
	return readObject(v, r.code, r.prefix+key+"["+strconv.Itoa(i)+"].")
}

// hash reads a member that is 64 lowercase hexadecimal characters.
func (r reader) hash(key string) (string, *Error) {
	s, err := r.str(key)
	if err != nil {
		return "", err
	}
	if !isHex64(s) {
		return "", errorf(r.code, "%s%s must be 64 lowercase hexadecimal characters", r.prefix, key)
	}
	return s, nil
}

// balances reads a member that is an object of decimal strings.
func (r reader) balances(key string) (Balances, *Error) {
	v, _ := r.obj.Get(key)
	b, err := balancesFrom(v, r.prefix+key)
	if err != nil {
		return nil, errorf(r.code, "%s", err.Message)
	}
	return b, nil
}
