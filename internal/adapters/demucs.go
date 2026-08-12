package adapters

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/chocolate/gosing/internal/core"
	"github.com/chocolate/gosing/internal/observability"
)

// DemucsAdapter es el cliente HTTP real que habla con nuestro Worker en Python
type DemucsAdapter struct {
	baseURL      string
	startClient  *http.Client
	statusClient *http.Client
	logger       *observability.Logger
	clock        func() time.Time
}

func NewDemucsAdapter(baseURL string) *DemucsAdapter {
	return NewDemucsAdapterWithLogger(baseURL, observability.DefaultLogger(), time.Now)
}

func NewDemucsAdapterWithLogger(baseURL string, logger *observability.Logger, clock func() time.Time) *DemucsAdapter {
	return &DemucsAdapter{
		baseURL:      baseURL,
		startClient:  &http.Client{Timeout: workerStartTimeout},
		statusClient: &http.Client{Timeout: workerStatusTimeout},
		logger:       logger,
		clock:        clock,
	}
}

const (
	workerStartTimeout  = 30 * time.Second // Upload acceptance returns a job ID, not Demucs output.
	workerStatusTimeout = 10 * time.Second // Polling must fail quickly so clients can retry later.
	maxWorkerResponse   = 1 << 20
)

var ErrWorkerRateLimited = errors.New("worker rate limited")
var errWorkerResponseInvalid = errors.New("worker response invalid")

type WorkerHTTPError struct{ StatusCode int }

func (e *WorkerHTTPError) Error() string {
	return fmt.Sprintf("worker returned status %d", e.StatusCode)
}

func (a *DemucsAdapter) StartIsolation(ctx context.Context, filePath string) (jobID string, err error) {
	start, statusCode := a.clock(), 0
	defer func() { a.log(ctx, "start", jobID, statusCode, start, err) }()
	ctx, cancel := context.WithTimeout(ctx, workerStartTimeout)
	defer cancel()
	// 1. Abrimos el MP3 que el usuario subió (y que Go guardó temporalmente)
	file, err := os.Open(filePath)
	if err != nil {
		return "", fmt.Errorf("no se pudo abrir el archivo local: %w", err)
	}
	defer file.Close()

	// 2. Armamos un formulario multipart (como si fuéramos un navegador web)
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)

	part, err := writer.CreateFormFile("file", filepath.Base(filePath))
	if err != nil {
		return "", fmt.Errorf("error creando form-data: %w", err)
	}

	if _, err = io.Copy(part, file); err != nil {
		return "", fmt.Errorf("error copiando archivo al form-data: %w", err)
	}
	writer.Close()

	// 3. Le disparamos el POST a la API de Python
	req, err := http.NewRequestWithContext(ctx, "POST", a.baseURL+"/api/process", body)
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())
	req.Header.Set("X-Request-ID", observability.RequestID(ctx))

	resp, err := a.startClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("worker request failed: %w", err)
	}
	defer resp.Body.Close()
	statusCode = resp.StatusCode

	if resp.StatusCode == http.StatusTooManyRequests {
		return "", ErrWorkerRateLimited
	}
	if resp.StatusCode != http.StatusOK {
		return "", &WorkerHTTPError{StatusCode: resp.StatusCode}
	}

	// 4. Parseamos el JSON para sacar el job_id real de Python
	var result struct {
		JobID string `json:"job_id"`
	}
	if err := decodeWorkerResponse(resp.Body, &result); err != nil {
		return "", fmt.Errorf("%w: %v", errWorkerResponseInvalid, err)
	}
	jobID = safeJobID(result.JobID)
	if jobID == "" {
		return "", errWorkerResponseInvalid
	}

	return jobID, nil
}

func (a *DemucsAdapter) CheckStatus(ctx context.Context, jobID string) (job *core.AudioJob, err error) {
	start, statusCode := a.clock(), 0
	defer func() { a.log(ctx, "status", jobID, statusCode, start, err) }()
	ctx, cancel := context.WithTimeout(ctx, workerStatusTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", a.baseURL+"/api/status/"+jobID, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-Request-ID", observability.RequestID(ctx))

	resp, err := a.statusClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("worker request failed: %w", err)
	}
	defer resp.Body.Close()
	statusCode = resp.StatusCode

	if resp.StatusCode == http.StatusTooManyRequests {
		return nil, ErrWorkerRateLimited
	}
	if resp.StatusCode != http.StatusOK {
		return nil, &WorkerHTTPError{StatusCode: resp.StatusCode}
	}

	// Parseamos el estado que devuelve Python
	var result struct {
		Status          string `json:"status"`
		Error           string `json:"error"`
		InstrumentalURL string `json:"instrumental_url"`
		VocalURL        string `json:"vocal_url"`
	}
	if err := decodeWorkerResponse(resp.Body, &result); err != nil {
		return nil, fmt.Errorf("%w: %v", errWorkerResponseInvalid, err)
	}

	// Lo transformamos al modelo Core de Go
	return &core.AudioJob{
		ID:              jobID,
		Status:          result.Status,
		Error:           result.Error,
		InstrumentalURL: result.InstrumentalURL,
		VocalURL:        result.VocalURL,
	}, nil
}

func (a *DemucsAdapter) log(ctx context.Context, operation, jobID string, statusCode int, start time.Time, err error) {
	event := observability.Event{Level: "info", Component: "adapter", Event: "adapter." + operation, RequestID: observability.RequestID(ctx), JobID: safeJobID(jobID), Operation: operation, Outcome: "success", DurationMS: a.clock().Sub(start).Milliseconds(), StatusCode: statusCode}
	if err != nil {
		event.Level, event.Outcome, event.ErrorCode = "error", "failure", adapterErrorCode(err)
	}
	a.logger.Log(event)
}

func safeJobID(value string) string {
	if len(value) != 36 || value[8] != '-' || value[13] != '-' || value[18] != '-' || value[23] != '-' || value[14] != '4' || !isUUIDv4Variant(value[19]) {
		return ""
	}
	for i := range value {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			continue
		}
		if value[i] < '0' || value[i] > '9' {
			if value[i] < 'a' || value[i] > 'f' {
				return ""
			}
		}
	}
	return value
}

func isUUIDv4Variant(value byte) bool {
	return value == '8' || value == '9' || value == 'a' || value == 'b'
}

func adapterErrorCode(err error) string {
	var workerErr *WorkerHTTPError
	switch {
	case errors.Is(err, ErrWorkerRateLimited):
		return "capacity_full"
	case errors.Is(err, context.DeadlineExceeded):
		return "timeout"
	case errors.Is(err, context.Canceled):
		return "canceled"
	case errors.Is(err, errWorkerResponseInvalid):
		return "worker_response_invalid"
	case errors.As(err, &workerErr):
		return "worker_http_error"
	default:
		return "storage_failed"
	}
}

func decodeWorkerResponse(body io.Reader, target any) error {
	payload, err := io.ReadAll(io.LimitReader(body, maxWorkerResponse+1))
	if err != nil {
		return err
	}
	if len(payload) > maxWorkerResponse {
		return errors.New("worker response exceeds limit")
	}
	return json.Unmarshal(payload, target)
}
