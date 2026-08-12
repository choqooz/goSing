package adapters

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/chocolate/gosing/internal/observability"
)

const validJobID = "550e8400-e29b-41d4-a716-446655440000"

func TestDemucsAdapter(t *testing.T) {
	for _, tt := range []struct {
		name, startBody, statusBody string
		startCode, statusCode       int
		status                      bool
		wantErr                     error
	}{
		{"start success", `{"job_id":"550e8400-e29b-41d4-a716-446655440000"}`, "", http.StatusOK, 0, false, nil},
		{"malformed job id", `{`, "", http.StatusOK, 0, false, nil},
		{"empty job id", `{"job_id":""}`, "", http.StatusOK, 0, false, nil},
		{"non UUID job id", `{"job_id":"job-123"}`, "", http.StatusOK, 0, false, nil},
		{"start rate limited", "", "", http.StatusTooManyRequests, 0, false, ErrWorkerRateLimited},
		{"status not found", "", "", 0, http.StatusNotFound, true, nil},
		{"status rate limited", "", "", 0, http.StatusTooManyRequests, true, ErrWorkerRateLimited},
		{"failed status", "", `{"status":"failed","error":"processing failed"}`, 0, http.StatusOK, true, nil},
	} {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/process" {
					w.WriteHeader(tt.startCode)
					w.Write([]byte(tt.startBody))
					return
				}
				w.WriteHeader(tt.statusCode)
				w.Write([]byte(tt.statusBody))
			}))
			defer server.Close()
			a := NewDemucsAdapter(server.URL)
			if tt.status {
				job, err := a.CheckStatus(context.Background(), validJobID)
				if tt.wantErr != nil {
					if !errors.Is(err, tt.wantErr) {
						t.Fatalf("error = %v", err)
					}
					return
				}
				if tt.statusCode != http.StatusOK {
					var workerErr *WorkerHTTPError
					if !errors.As(err, &workerErr) || workerErr.StatusCode != tt.statusCode {
						t.Fatalf("error = %v", err)
					}
					return
				}
				if err != nil || job.Error != "processing failed" {
					t.Fatalf("job/error = %#v/%v", job, err)
				}
				return
			}
			path := t.TempDir() + "/audio.mp3"
			if err := os.WriteFile(path, []byte("audio"), 0600); err != nil {
				t.Fatal(err)
			}
			jobID, err := a.StartIsolation(context.Background(), path)
			if tt.wantErr != nil {
				if !errors.Is(err, tt.wantErr) {
					t.Fatalf("error = %v", err)
				}
				return
			}
			if tt.startBody == `{"job_id":""}` || tt.startBody == `{"job_id":"job-123"}` || tt.startBody == `{` {
				if err == nil {
					t.Fatal("empty job ID accepted")
				}
				return
			}
			if err != nil || jobID != validJobID {
				t.Fatalf("job/error = %q/%v", jobID, err)
			}
		})
	}
}

func TestDemucsAdapterRespectsContextAndTimeout(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { time.Sleep(time.Second) }))
	defer server.Close()
	a := NewDemucsAdapter(server.URL)
	a.statusClient.Timeout = 10 * time.Millisecond

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := a.CheckStatus(ctx, validJobID); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled error = %v", err)
	}
	if _, err := a.CheckStatus(context.Background(), validJobID); err == nil {
		t.Fatal("client timeout did not fail")
	}
}

func TestDemucsAdapterLogsOnlySafeJobIDs(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()

	var logs strings.Builder
	a := NewDemucsAdapterWithLogger(server.URL, observability.NewLogger(&logs), time.Now)
	for _, jobID := range []string{"https://private/path", "/secret/file"} {
		if _, err := a.CheckStatus(context.Background(), jobID); err == nil {
			t.Fatal("status request unexpectedly succeeded")
		}
	}
	if strings.Contains(logs.String(), "https://private/path") || strings.Contains(logs.String(), "/secret/file") {
		t.Fatalf("unsafe job ID leaked: %q", logs.String())
	}

	if _, err := a.CheckStatus(context.Background(), validJobID); err == nil {
		t.Fatal("status request unexpectedly succeeded")
	}
	if !strings.Contains(logs.String(), `"job_id":"`+validJobID+`"`) {
		t.Fatalf("valid job ID was not logged: %q", logs.String())
	}
}

func TestDemucsAdapterRejectsInvalidWorkerJobIDWithoutLoggingIt(t *testing.T) {
	const invalidJobID = "https://private/path"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`{"job_id":"` + invalidJobID + `"}`))
	}))
	defer server.Close()

	var logs strings.Builder
	a := NewDemucsAdapterWithLogger(server.URL, observability.NewLogger(&logs), time.Now)
	path := t.TempDir() + "/audio.mp3"
	if err := os.WriteFile(path, []byte("audio"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := a.StartIsolation(context.Background(), path); !errors.Is(err, errWorkerResponseInvalid) {
		t.Fatalf("error = %v, want worker response invalid", err)
	}
	if !strings.Contains(logs.String(), `"error_code":"worker_response_invalid"`) {
		t.Fatalf("worker response error was not logged: %q", logs.String())
	}
	if strings.Contains(logs.String(), invalidJobID) {
		t.Fatalf("invalid worker job ID leaked: %q", logs.String())
	}
}

func TestDemucsAdapterPropagatesIDAndSanitizesFailures(t *testing.T) {
	for _, tt := range []struct {
		name, body, wantCode string
		code                 int
		wait                 bool
	}{
		{"rate limited", "/private/path?secret=1", "capacity_full", http.StatusTooManyRequests, false},
		{"malformed response", "{https://secret.example/path", "worker_response_invalid", http.StatusOK, false},
		{"timeout", "", "timeout", http.StatusOK, true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("X-Request-ID") != "trace-1" {
					t.Fatalf("request ID = %q", r.Header.Get("X-Request-ID"))
				}
				if tt.wait {
					time.Sleep(50 * time.Millisecond)
				}
				w.WriteHeader(tt.code)
				w.Write([]byte(tt.body))
			}))
			defer server.Close()
			var logs strings.Builder
			a := NewDemucsAdapterWithLogger(server.URL, observability.NewLogger(&logs), time.Now)
			if tt.wait {
				a.startClient.Timeout = time.Millisecond
			}
			path := t.TempDir() + "/audio.mp3"
			if err := os.WriteFile(path, []byte("audio"), 0600); err != nil {
				t.Fatal(err)
			}
			_, err := a.StartIsolation(observability.WithRequestID(context.Background(), "trace-1"), path)
			if err == nil || !strings.Contains(logs.String(), `"error_code":"`+tt.wantCode+`"`) {
				t.Fatalf("error/log = %v/%q", err, logs.String())
			}
			if strings.Contains(logs.String(), "/private") || strings.Contains(logs.String(), "secret") {
				t.Fatalf("private worker response leaked: %q", logs.String())
			}
		})
	}
}
