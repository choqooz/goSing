package observability

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"regexp"
	"sync"
	"time"
)

const requestIDHeader = "X-Request-ID"

var requestIDPattern = regexp.MustCompile(`^[A-Za-z0-9._~-]{1,64}$`)

type Event struct {
	Timestamp  string `json:"timestamp"`
	Level      string `json:"level"`
	Component  string `json:"component"`
	Event      string `json:"event"`
	RequestID  string `json:"request_id,omitempty"`
	JobID      string `json:"job_id,omitempty"`
	Operation  string `json:"operation,omitempty"`
	Outcome    string `json:"outcome,omitempty"`
	Status     string `json:"status,omitempty"`
	DurationMS int64  `json:"duration_ms"`
	StatusCode int    `json:"status_code,omitempty"`
	SizeBytes  int64  `json:"size_bytes,omitempty"`
	ErrorCode  string `json:"error_code,omitempty"`
}

type Logger struct {
	writer io.Writer
	now    func() time.Time
	mu     sync.Mutex
}

func NewLogger(writer io.Writer) *Logger {
	return &Logger{writer: writer, now: time.Now}
}

func DefaultLogger() *Logger { return NewLogger(os.Stderr) }

func (l *Logger) Log(event Event) {
	event.Timestamp = l.now().UTC().Format(time.RFC3339)
	if event.DurationMS < 0 {
		event.DurationMS = 0
	}
	payload, err := json.Marshal(event)
	if err != nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	_, _ = l.writer.Write(append(payload, '\n'))
}

type requestIDKey struct{}

func ValidRequestID(value string) bool { return requestIDPattern.MatchString(value) }

func NewRequestID() string {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "request-id-unavailable"
	}
	value[6] = value[6]&0x0f | 0x40
	value[8] = value[8]&0x3f | 0x80
	return hex.EncodeToString(value[0:4]) + "-" + hex.EncodeToString(value[4:6]) + "-" + hex.EncodeToString(value[6:8]) + "-" + hex.EncodeToString(value[8:10]) + "-" + hex.EncodeToString(value[10:])
}

func WithRequestID(ctx context.Context, value string) context.Context {
	return context.WithValue(ctx, requestIDKey{}, value)
}

func RequestID(ctx context.Context) string {
	value, _ := ctx.Value(requestIDKey{}).(string)
	return value
}

func RequestIDMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		values := r.Header.Values(requestIDHeader)
		requestID := NewRequestID()
		if len(values) == 1 && ValidRequestID(values[0]) {
			requestID = values[0]
		}
		w.Header().Set(requestIDHeader, requestID)
		next.ServeHTTP(w, r.WithContext(WithRequestID(r.Context(), requestID)))
	})
}
