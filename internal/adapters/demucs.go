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
)

// DemucsAdapter es el cliente HTTP real que habla con nuestro Worker en Python
type DemucsAdapter struct {
	baseURL      string
	startClient  *http.Client
	statusClient *http.Client
}

func NewDemucsAdapter(baseURL string) *DemucsAdapter {
	return &DemucsAdapter{
		baseURL:      baseURL,
		startClient:  &http.Client{Timeout: workerStartTimeout},
		statusClient: &http.Client{Timeout: workerStatusTimeout},
	}
}

const (
	workerStartTimeout  = 30 * time.Second // Upload acceptance returns a job ID, not Demucs output.
	workerStatusTimeout = 10 * time.Second // Polling must fail quickly so clients can retry later.
	maxWorkerResponse   = 1 << 20
)

var ErrWorkerRateLimited = errors.New("worker rate limited")

type WorkerHTTPError struct{ StatusCode int }

func (e *WorkerHTTPError) Error() string {
	return fmt.Sprintf("worker returned status %d", e.StatusCode)
}

func (a *DemucsAdapter) StartIsolation(ctx context.Context, filePath string) (string, error) {
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

	resp, err := a.startClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("worker request failed: %w", err)
	}
	defer resp.Body.Close()

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
		return "", fmt.Errorf("error parseando respuesta del worker: %w", err)
	}
	if result.JobID == "" {
		return "", errors.New("worker returned an empty job ID")
	}

	return result.JobID, nil
}

func (a *DemucsAdapter) CheckStatus(ctx context.Context, jobID string) (*core.AudioJob, error) {
	ctx, cancel := context.WithTimeout(ctx, workerStatusTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", a.baseURL+"/api/status/"+jobID, nil)
	if err != nil {
		return nil, err
	}

	resp, err := a.statusClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("worker request failed: %w", err)
	}
	defer resp.Body.Close()

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
		return nil, fmt.Errorf("error parseando estado: %w", err)
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
