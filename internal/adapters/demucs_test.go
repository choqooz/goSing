package adapters

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"
)

func TestDemucsAdapter(t *testing.T) {
	for _, tt := range []struct {
		name, startBody, statusBody string
		startCode, statusCode       int
		status                      bool
		wantErr                     error
	}{
		{"start success", `{"job_id":"job-1"}`, "", http.StatusOK, 0, false, nil},
		{"malformed job id", `{`, "", http.StatusOK, 0, false, nil},
		{"empty job id", `{"job_id":""}`, "", http.StatusOK, 0, false, nil},
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
				job, err := a.CheckStatus(context.Background(), "job-1")
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
			if tt.startBody == `{"job_id":""}` || tt.startBody == `{` {
				if err == nil {
					t.Fatal("empty job ID accepted")
				}
				return
			}
			if err != nil || jobID != "job-1" {
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
	if _, err := a.CheckStatus(ctx, "job-1"); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled error = %v", err)
	}
	if _, err := a.CheckStatus(context.Background(), "job-1"); err == nil {
		t.Fatal("client timeout did not fail")
	}
}
