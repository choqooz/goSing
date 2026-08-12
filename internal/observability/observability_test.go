package observability

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestRequestIDs(t *testing.T) {
	for _, value := range []string{"a", "request_1.~", strings.Repeat("a", 64)} {
		if !ValidRequestID(value) {
			t.Fatalf("valid request ID rejected: %q", value)
		}
	}
	for _, value := range []string{"", strings.Repeat("a", 65), "space here", "bad/ID"} {
		if ValidRequestID(value) {
			t.Fatalf("invalid request ID accepted: %q", value)
		}
	}
	if !regexpUUIDv4(NewRequestID()) {
		t.Fatal("generated request ID is not UUID v4")
	}
}

func TestRequestIDMiddleware(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(RequestID(r.Context())))
	})
	for _, tt := range []struct{ supplied, want string }{{"trace-1", "trace-1"}, {"bad/id", ""}} {
		r := httptest.NewRequest(http.MethodGet, "/", nil)
		r.Header.Set(requestIDHeader, tt.supplied)
		rec := httptest.NewRecorder()
		RequestIDMiddleware(next).ServeHTTP(rec, r)
		got := rec.Header().Get(requestIDHeader)
		if tt.want != "" && got != tt.want {
			t.Fatalf("header = %q, want %q", got, tt.want)
		}
		if tt.want == "" && !regexpUUIDv4(got) {
			t.Fatalf("invalid ID did not generate UUID: %q", got)
		}
		if rec.Body.String() != got {
			t.Fatalf("context = %q, header = %q", rec.Body.String(), got)
		}
	}
}

func TestLoggerUsesOneLineAllowlistAndNonNegativeDuration(t *testing.T) {
	var output bytes.Buffer
	logger := NewLogger(&output)
	logger.now = func() time.Time { return time.Date(2026, 8, 12, 12, 0, 0, 0, time.FixedZone("other", 3600)) }
	logger.Log(Event{Level: "info", Component: "handler", Event: "handler.search", DurationMS: -1})
	if strings.Count(output.String(), "\n") != 1 {
		t.Fatalf("event was not one JSON line: %q", output.String())
	}
	var event Event
	if err := json.Unmarshal(output.Bytes(), &event); err != nil {
		t.Fatal(err)
	}
	if event.Timestamp != "2026-08-12T11:00:00Z" || event.DurationMS != 0 {
		t.Fatalf("event = %#v", event)
	}
}

func regexpUUIDv4(value string) bool {
	return len(value) == 36 && value[14] == '4' && strings.ContainsRune("89ab", rune(value[19]))
}
