package handlers

import (
	"context"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/chocolate/gosing/internal/adapters"
	"github.com/chocolate/gosing/internal/core"
	"github.com/chocolate/gosing/internal/observability"
)

type recordingProcessor struct {
	path      string
	err       error
	job       *core.AudioJob
	statusErr error
}

func (p *recordingProcessor) StartIsolation(_ context.Context, path string) (string, error) {
	p.path = path
	if p.err != nil {
		return "", p.err
	}
	if _, err := os.Stat(path); err != nil {
		return "", err
	}
	return "job-1", nil
}

func (p *recordingProcessor) CheckStatus(context.Context, string) (*core.AudioJob, error) {
	return p.job, p.statusErr
}

func uploadRequest(t *testing.T, name string, body io.Reader) *http.Request {
	t.Helper()
	buf := &strings.Builder{}
	w := multipart.NewWriter(buf)
	part, err := w.CreateFormFile("audio", name)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = io.Copy(part, body); err != nil {
		t.Fatal(err)
	}
	if err = w.Close(); err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodPost, "/api/audio/upload", strings.NewReader(buf.String()))
	r.Header.Set("Content-Type", w.FormDataContentType())
	return r
}

func TestHandleUpload(t *testing.T) {
	for _, tt := range []struct {
		name, filename string
		body           io.Reader
		processorErr   error
		wantStatus     int
	}{
		{"valid cleans up", "song.MP3", strings.NewReader("audio"), nil, http.StatusOK},
		{"processor error cleans up", "song.wav", strings.NewReader("audio"), errors.New("worker failed"), http.StatusInternalServerError},
		{"worker rate limited", "song.wav", strings.NewReader("audio"), adapters.ErrWorkerRateLimited, http.StatusTooManyRequests},
		{"worker deadline", "song.wav", strings.NewReader("audio"), context.DeadlineExceeded, http.StatusGatewayTimeout},
		{"invalid extension", "song.txt", strings.NewReader("audio"), nil, http.StatusBadRequest},
		{"over limit", "song.mp3", strings.NewReader(strings.Repeat("a", maxAudioSize+1)), nil, http.StatusBadRequest},
	} {
		t.Run(tt.name, func(t *testing.T) {
			p := &recordingProcessor{err: tt.processorErr}
			h := NewAudioHandler(p)
			h.tempDir = t.TempDir()
			r := uploadRequest(t, tt.filename, tt.body)
			rec := httptest.NewRecorder()
			h.HandleUpload(rec, r)
			if rec.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d", rec.Code, tt.wantStatus)
			}
			if p.path != "" {
				if _, err := os.Stat(p.path); !os.IsNotExist(err) {
					t.Fatalf("temporary upload remains: %q, err=%v", p.path, err)
				}
			}
		})
	}

	t.Run("same name receives unique paths", func(t *testing.T) {
		paths := make([]string, 0, 2)
		tempDir := t.TempDir()
		for range 2 {
			p := &recordingProcessor{}
			h := NewAudioHandler(p)
			h.tempDir = tempDir
			h.HandleUpload(httptest.NewRecorder(), uploadRequest(t, "same.mp3", strings.NewReader("audio")))
			paths = append(paths, p.path)
		}
		if paths[0] == paths[1] {
			t.Fatalf("uploads used the same temporary path: %q", paths[0])
		}
	})
}

func TestSuggestionsAndSearch(t *testing.T) {
	t.Run("suggestions success", func(t *testing.T) {
		h := NewAudioHandler(&recordingProcessor{})
		h.suggestClient = &http.Client{Transport: roundTripper(func(r *http.Request) (*http.Response, error) {
			if r.Context() == nil {
				t.Fatal("suggestion request lacks context")
			}
			return response(http.StatusOK, `["query",["song"]]`), nil
		})}
		rec := httptest.NewRecorder()
		h.SuggestYouTube(rec, httptest.NewRequest(http.MethodGet, "/api/audio/suggest?q=song", nil))
		if rec.Code != http.StatusOK || rec.Body.String() != `["query",["song"]]` {
			t.Fatalf("status/body = %d/%q", rec.Code, rec.Body.String())
		}
	})
	t.Run("suggestions canceled", func(t *testing.T) {
		h := NewAudioHandler(&recordingProcessor{})
		h.suggestClient = &http.Client{Transport: roundTripper(func(*http.Request) (*http.Response, error) { return nil, context.Canceled })}
		rec := httptest.NewRecorder()
		h.SuggestYouTube(rec, httptest.NewRequest(http.MethodGet, "/api/audio/suggest?q=song", nil))
		if rec.Code != http.StatusRequestTimeout {
			t.Fatalf("status = %d", rec.Code)
		}
	})
	t.Run("suggestions deadline", func(t *testing.T) {
		h := NewAudioHandler(&recordingProcessor{})
		h.suggestClient = &http.Client{Transport: roundTripper(func(*http.Request) (*http.Response, error) { return nil, context.DeadlineExceeded })}
		rec := httptest.NewRecorder()
		h.SuggestYouTube(rec, httptest.NewRequest(http.MethodGet, "/api/audio/suggest?q=song", nil))
		if rec.Code != http.StatusGatewayTimeout {
			t.Fatalf("status = %d", rec.Code)
		}
	})

	for _, tt := range []struct {
		name string
		err  error
		code int
	}{
		{"suggestions external status", nil, http.StatusBadGateway},
		{"search deadline", context.DeadlineExceeded, http.StatusGatewayTimeout},
		{"search canceled", context.Canceled, http.StatusRequestTimeout},
		{"search success", nil, http.StatusOK},
	} {
		t.Run(tt.name, func(t *testing.T) {
			h := NewAudioHandler(&recordingProcessor{})
			if tt.name == "suggestions external status" {
				h.suggestClient = &http.Client{Transport: roundTripper(func(*http.Request) (*http.Response, error) {
					return response(http.StatusServiceUnavailable, "unavailable"), nil
				})}
				rec := httptest.NewRecorder()
				h.SuggestYouTube(rec, httptest.NewRequest(http.MethodGet, "/api/audio/suggest?q=song", nil))
				if rec.Code != tt.code {
					t.Fatalf("status = %d, want %d", rec.Code, tt.code)
				}
				return
			}
			h.runSearch = func(context.Context, string) ([]byte, error) {
				if tt.err != nil {
					return nil, tt.err
				}
				return []byte(`{"id":"dQw4w9WgXcQ","title":"song"}`), nil
			}
			rec := httptest.NewRecorder()
			h.SearchYouTube(rec, httptest.NewRequest(http.MethodGet, "/api/audio/search?q=song", nil))
			if rec.Code != tt.code {
				t.Fatalf("status = %d, want %d", rec.Code, tt.code)
			}
		})
	}
}

func TestHandleStatus(t *testing.T) {
	for _, tt := range []struct {
		name string
		p    *recordingProcessor
		code int
	}{
		{"failed job remains a polling response", &recordingProcessor{job: &core.AudioJob{Status: "failed", Error: "processing failed"}}, http.StatusOK},
		{"worker not found", &recordingProcessor{statusErr: &adapters.WorkerHTTPError{StatusCode: http.StatusNotFound}}, http.StatusNotFound},
		{"worker timeout", &recordingProcessor{statusErr: context.DeadlineExceeded}, http.StatusGatewayTimeout},
	} {
		t.Run(tt.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			NewAudioHandler(tt.p).HandleStatus(rec, httptest.NewRequest(http.MethodGet, "/api/audio/status?job_id=job-1", nil))
			if rec.Code != tt.code {
				t.Fatalf("status = %d, want %d", rec.Code, tt.code)
			}
			if tt.code == http.StatusOK && !strings.Contains(rec.Body.String(), `"error":"processing failed"`) {
				t.Fatalf("body = %q", rec.Body.String())
			}
		})
	}
}

func TestHandleDownload(t *testing.T) {
	for _, tt := range []struct {
		name     string
		videoID  string
		run      func(string) error
		wantRun  bool
		wantCode int
	}{
		{"invalid id", "not-valid", nil, false, http.StatusBadRequest},
		{"runner error", "dQw4w9WgXcQ", func(string) error { return errors.New("download failed") }, true, http.StatusInternalServerError},
		{"runner deadline", "dQw4w9WgXcQ", func(string) error { return context.DeadlineExceeded }, true, http.StatusGatewayTimeout},
		{"runner canceled", "dQw4w9WgXcQ", func(string) error { return context.Canceled }, true, http.StatusRequestTimeout},
		{"missing output", "dQw4w9WgXcQ", func(string) error { return nil }, true, http.StatusInternalServerError},
		{"empty output", "dQw4w9WgXcQ", func(p string) error { return os.WriteFile(p, nil, 0600) }, true, http.StatusInternalServerError},
		{"oversize output", "dQw4w9WgXcQ", func(p string) error { return os.WriteFile(p, make([]byte, maxAudioSize+1), 0600) }, true, http.StatusInternalServerError},
		{"valid cleans up", "dQw4w9WgXcQ", func(p string) error { return os.WriteFile(p, []byte("audio"), 0600) }, true, http.StatusOK},
	} {
		t.Run(tt.name, func(t *testing.T) {
			p := &recordingProcessor{}
			h := NewAudioHandler(p)
			h.tempDir = t.TempDir()
			ran, output := false, ""
			h.runDownload = func(_ context.Context, _ string, path string) error {
				ran, output = true, path
				if tt.run == nil {
					return errors.New("runner should not execute")
				}
				return tt.run(path)
			}
			r := httptest.NewRequest(http.MethodPost, "/api/audio/download", strings.NewReader(`{"videoId":"`+tt.videoID+`"}`))
			rec := httptest.NewRecorder()
			h.HandleDownload(rec, r)
			if rec.Code != tt.wantCode || ran != tt.wantRun {
				t.Fatalf("status/run = %d/%t, want %d/%t", rec.Code, ran, tt.wantCode, tt.wantRun)
			}
			for _, path := range []string{p.path, output} {
				if path != "" {
					if _, err := os.Stat(path); !os.IsNotExist(err) {
						t.Fatalf("temporary download remains: %q, err=%v", path, err)
					}
				}
			}
			if output != "" {
				if _, err := os.Stat(filepath.Dir(output)); !os.IsNotExist(err) {
					t.Fatalf("temporary download directory remains: %q, err=%v", filepath.Dir(output), err)
				}
			}
		})
	}
}

func TestHandlerObservabilityIsSanitizedAndClassified(t *testing.T) {
	for _, tt := range []struct {
		name, operation, request, wantError string
		wantCode                            int
		processor                           *recordingProcessor
	}{
		{"upload capacity", "upload", "song private.mp3", "capacity_full", http.StatusTooManyRequests, &recordingProcessor{err: adapters.ErrWorkerRateLimited}},
		{"status timeout", "status", "job-1?secret", "timeout", http.StatusGatewayTimeout, &recordingProcessor{statusErr: context.DeadlineExceeded}},
		{"status canceled", "status", "job-1?secret", "canceled", http.StatusRequestTimeout, &recordingProcessor{statusErr: context.Canceled}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			var logs strings.Builder
			now := time.Date(2026, 8, 12, 0, 0, 0, 0, time.UTC)
			h := NewAudioHandlerWithLogger(tt.processor, observability.NewLogger(&logs), func() time.Time { return now })
			h.tempDir = t.TempDir()
			rec := httptest.NewRecorder()
			if tt.operation == "upload" {
				h.HandleUpload(rec, uploadRequest(t, tt.request, strings.NewReader("audio")))
			} else {
				h.HandleStatus(rec, httptest.NewRequest(http.MethodGet, "/api/audio/status?job_id="+tt.request, nil))
			}
			if rec.Code != tt.wantCode || !strings.Contains(logs.String(), `"error_code":"`+tt.wantError+`"`) {
				t.Fatalf("status/log = %d/%q", rec.Code, logs.String())
			}
			if strings.Contains(logs.String(), "private") || strings.Contains(logs.String(), "secret") || strings.Contains(logs.String(), "song ") {
				t.Fatalf("sensitive input leaked: %q", logs.String())
			}
		})
	}
}

type roundTripper func(*http.Request) (*http.Response, error)

func (f roundTripper) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func response(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}
}
