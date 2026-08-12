package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/chocolate/gosing/internal/adapters"
	"github.com/chocolate/gosing/internal/core"
	"github.com/chocolate/gosing/internal/observability"
)

type AudioHandler struct {
	processor     core.AudioProcessor
	suggestClient *http.Client
	runSearch     func(context.Context, string) ([]byte, error)
	runDownload   func(context.Context, string, string) error
	tempDir       string
	logger        *observability.Logger
	clock         func() time.Time
}

type SearchResult struct {
	VideoID string `json:"videoId"`
	Title   string `json:"title"`
	Author  string `json:"author"`
	Thumb   string `json:"thumb"`
}

func NewAudioHandler(p core.AudioProcessor) *AudioHandler {
	return NewAudioHandlerWithLogger(p, observability.DefaultLogger(), time.Now)
}

func NewAudioHandlerWithLogger(p core.AudioProcessor, logger *observability.Logger, clock func() time.Time) *AudioHandler {
	return &AudioHandler{processor: p, suggestClient: &http.Client{Timeout: suggestionTimeout}, runSearch: searchYouTube, runDownload: downloadAudio, tempDir: os.TempDir(), logger: logger, clock: clock}
}

// SuggestYouTube devuelve sugerencias de autocompletado ultra rápidas.
func (h *AudioHandler) SuggestYouTube(w http.ResponseWriter, r *http.Request) {
	w, finish := h.observe(w, r, "suggest")
	defer finish()
	query := r.URL.Query().Get("q")
	if query == "" {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`[]`))
		return
	}

	apiUrl := fmt.Sprintf("https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=%s", url.QueryEscape(query))
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, apiUrl, nil)
	if err != nil {
		http.Error(w, "failed to get suggestions", http.StatusInternalServerError)
		return
	}
	res, err := h.suggestClient.Do(req)
	if err != nil {
		http.Error(w, "failed to get suggestions", requestErrorStatus(err))
		return
	}
	defer res.Body.Close()
	if res.StatusCode < http.StatusOK || res.StatusCode >= http.StatusMultipleChoices {
		http.Error(w, "failed to get suggestions", http.StatusBadGateway)
		return
	}
	payload, err := io.ReadAll(io.LimitReader(res.Body, maxSuggestionResponse+1))
	if err != nil || len(payload) > maxSuggestionResponse {
		http.Error(w, "failed to get suggestions", http.StatusBadGateway)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Write(payload)
}

// SearchYouTube busca en YouTube usando yt-dlp.
func (h *AudioHandler) SearchYouTube(w http.ResponseWriter, r *http.Request) {
	w, finish := h.observe(w, r, "search")
	defer finish()
	query := r.URL.Query().Get("q")
	if query == "" {
		http.Error(w, "missing query parameter", http.StatusBadRequest)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), youtubeSearchTimeout)
	defer cancel()
	out, err := h.runSearch(ctx, query)
	if err != nil {
		http.Error(w, "failed to search", requestErrorStatus(commandError(ctx, err)))
		return
	}

	if len(out) == 0 {
		http.Error(w, "failed to search", http.StatusInternalServerError)
		return
	}

	var results []SearchResult
	lines := strings.Split(string(out), "\n")
	for _, line := range lines {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var data struct {
			ID         string `json:"id"`
			Title      string `json:"title"`
			Uploader   string `json:"uploader"`
			Thumbnail  string `json:"thumbnail"`
			Thumbnails []struct {
				URL string `json:"url"`
			} `json:"thumbnails"`
		}
		if err := json.Unmarshal([]byte(line), &data); err == nil {
			thumb := data.Thumbnail
			if thumb == "" && len(data.Thumbnails) > 0 {
				thumb = data.Thumbnails[0].URL
			}
			results = append(results, SearchResult{
				VideoID: data.ID,
				Title:   data.Title,
				Author:  data.Uploader,
				Thumb:   thumb,
			})
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(results)
}

// POST /api/audio/upload
func (h *AudioHandler) HandleUpload(w http.ResponseWriter, r *http.Request) {
	w, finish := h.observe(w, r, "upload")
	defer finish()
	// 1. Limitar tamaño a 20MB (protege la memoria de tu VPS gratuito)
	r.Body = http.MaxBytesReader(w, r.Body, maxAudioSize)
	if err := r.ParseMultipartForm(maxAudioSize); err != nil {
		http.Error(w, "Archivo muy pesado o inválido", http.StatusBadRequest)
		return
	}

	// 2. Extraer el archivo del form-data (campo 'audio')
	file, handler, err := r.FormFile("audio")
	if err != nil {
		http.Error(w, "Falta el campo 'audio'", http.StatusBadRequest)
		return
	}
	defer file.Close()

	// Preserve the format suffix without letting client input control the path.
	ext := strings.ToLower(filepath.Ext(handler.Filename))
	if !allowedAudioExtensions[ext] {
		http.Error(w, "Formato de audio inválido", http.StatusBadRequest)
		return
	}

	// 3. Guardar temporalmente (cumpliendo la regla del PRD: procesamiento efímero)
	dst, err := os.CreateTemp(h.tempDir, "gosing-upload-*"+ext)
	if err != nil {
		http.Error(w, "Error interno guardando archivo", http.StatusInternalServerError)
		return
	}
	tmpPath := dst.Name()
	defer os.Remove(tmpPath)
	_, copyErr := io.Copy(dst, file)
	closeErr := dst.Close()
	if copyErr != nil || closeErr != nil {
		http.Error(w, "Error interno guardando archivo", http.StatusInternalServerError)
		return
	}

	// 4. Iniciar aislamiento pasándole la ruta temporal al adaptador inyectado
	jobID, err := h.processor.StartIsolation(r.Context(), tmpPath)
	if err != nil {
		writeWorkerError(w, err)
		return
	}

	// 5. Devolver el JobID
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"job_id": jobID})
}

// GET /api/audio/status?job_id=xxx
func (h *AudioHandler) HandleStatus(w http.ResponseWriter, r *http.Request) {
	w, finish := h.observe(w, r, "status")
	defer finish()
	jobID := r.URL.Query().Get("job_id")
	if jobID == "" {
		http.Error(w, "Falta el parámetro job_id", http.StatusBadRequest)
		return
	}

	job, err := h.processor.CheckStatus(r.Context(), jobID)
	if err != nil {
		if errors.Is(err, adapters.ErrWorkerRateLimited) {
			http.Error(w, "Error consultando la IA", http.StatusTooManyRequests)
			return
		}
		var workerErr *adapters.WorkerHTTPError
		if errors.As(err, &workerErr) && workerErr.StatusCode == http.StatusNotFound {
			http.Error(w, "Trabajo no encontrado", http.StatusNotFound)
			return
		}
		if status := requestErrorStatus(err); status != http.StatusInternalServerError {
			http.Error(w, "Error consultando la IA", status)
			return
		}
		http.Error(w, "Error consultando la IA", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(job)
}

type DownloadRequest struct {
	VideoID string `json:"videoId"`
}

// POST /api/audio/download
func (h *AudioHandler) HandleDownload(w http.ResponseWriter, r *http.Request) {
	w, finish := h.observe(w, r, "download")
	defer finish()
	var req DownloadRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Cuerpo de petición inválido", http.StatusBadRequest)
		return
	}

	if !youtubeIDPattern.MatchString(req.VideoID) {
		http.Error(w, "Falta videoId", http.StatusBadRequest)
		return
	}

	tmpDir, err := os.MkdirTemp(h.tempDir, "gosing-download-*")
	if err != nil {
		http.Error(w, "Error descargando audio", http.StatusInternalServerError)
		return
	}
	defer os.RemoveAll(tmpDir)
	tmpPath := filepath.Join(tmpDir, "audio.mp3")
	ctx, cancel := context.WithTimeout(r.Context(), youtubeDownloadTimeout)
	defer cancel()
	if err := h.runDownload(ctx, req.VideoID, tmpPath); err != nil {
		http.Error(w, "Error descargando audio", requestErrorStatus(commandError(ctx, err)))
		return
	}
	info, err := os.Stat(tmpPath)
	if err != nil || !info.Mode().IsRegular() || info.Size() == 0 || info.Size() > maxAudioSize {
		http.Error(w, "Error descargando audio", http.StatusInternalServerError)
		return
	}

	jobID, err := h.processor.StartIsolation(r.Context(), tmpPath)
	if err != nil {
		writeWorkerError(w, err)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"job_id": jobID})
}

const (
	maxAudioSize           = 20 << 20
	suggestionTimeout      = 5 * time.Second
	maxSuggestionResponse  = 1 << 20
	youtubeSearchTimeout   = 20 * time.Second // Search is interactive and must not occupy a request indefinitely.
	youtubeDownloadTimeout = 5 * time.Minute  // Audio extraction is expected to take longer than search.
)

var (
	allowedAudioExtensions = map[string]bool{".mp3": true, ".wav": true, ".m4a": true, ".ogg": true, ".flac": true}
	youtubeIDPattern       = regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`)
)

func downloadAudio(ctx context.Context, videoID, outputPath string) error {
	args := []string{
		"-f", "bestaudio", "--extract-audio", "--audio-format", "mp3",
		"-o", outputPath, "-v", "https://youtube.com/watch?v=" + videoID,
	}
	cmd := exec.CommandContext(ctx, "yt-dlp", args...)
	cmd.Stderr = io.Discard
	return cmd.Run()
}

func searchYouTube(ctx context.Context, query string) ([]byte, error) {
	args := []string{fmt.Sprintf("ytsearch10:%s", query), "--dump-json", "--ignore-errors", "--no-warnings", "--flat-playlist", "-v"}
	cmd := exec.CommandContext(ctx, "yt-dlp", args...)
	cmd.Stderr = io.Discard
	return cmd.Output()
}

func requestErrorStatus(err error) int {
	if errors.Is(err, context.DeadlineExceeded) {
		return http.StatusGatewayTimeout
	}
	if errors.Is(err, context.Canceled) {
		return http.StatusRequestTimeout
	}
	return http.StatusInternalServerError
}

func commandError(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return err
}

func writeWorkerError(w http.ResponseWriter, err error) {
	if errors.Is(err, adapters.ErrWorkerRateLimited) {
		http.Error(w, "La IA está ocupada, intentá nuevamente", http.StatusTooManyRequests)
		return
	}
	http.Error(w, "Error iniciando la IA", requestErrorStatus(err))
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(status int) {
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}

func (w *statusWriter) Write(data []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.ResponseWriter.Write(data)
}

func (h *AudioHandler) observe(w http.ResponseWriter, r *http.Request, operation string) (http.ResponseWriter, func()) {
	start, recorder := h.clock(), &statusWriter{ResponseWriter: w}
	return recorder, func() {
		status := recorder.status
		if status == 0 {
			status = http.StatusOK
		}
		event := observability.Event{Level: "info", Component: "handler", Event: "handler." + operation, RequestID: observability.RequestID(r.Context()), Operation: operation, Outcome: "success", DurationMS: h.clock().Sub(start).Milliseconds(), StatusCode: status}
		if status >= http.StatusBadRequest {
			event.Level, event.Outcome, event.ErrorCode = "error", "failure", errorCodeForStatus(status)
		}
		h.logger.Log(event)
	}
}

func errorCodeForStatus(status int) string {
	switch status {
	case http.StatusBadRequest:
		return "invalid_request"
	case http.StatusRequestTimeout:
		return "canceled"
	case http.StatusTooManyRequests:
		return "capacity_full"
	case http.StatusNotFound:
		return "not_found"
	case http.StatusBadGateway:
		return "upstream_unavailable"
	case http.StatusGatewayTimeout:
		return "timeout"
	default:
		return "unknown"
	}
}
