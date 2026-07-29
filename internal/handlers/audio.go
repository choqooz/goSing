package handlers

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/chocolate/gosing/internal/core"
)

type AudioHandler struct {
	processor core.AudioProcessor
}

type SearchResult struct {
	VideoID string `json:"videoId"`
	Title   string `json:"title"`
	Author  string `json:"author"`
	Thumb   string `json:"thumb"`
}

func NewAudioHandler(p core.AudioProcessor) *AudioHandler {
	return &AudioHandler{processor: p}
}

// SuggestYouTube devuelve sugerencias de autocompletado ultra rápidas.
func (h *AudioHandler) SuggestYouTube(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query().Get("q")
	if query == "" {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`[]`))
		return
	}

	apiUrl := fmt.Sprintf("https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=%s", url.QueryEscape(query))
	res, err := http.Get(apiUrl)
	if err != nil {
		http.Error(w, "failed to get suggestions", http.StatusInternalServerError)
		return
	}
	defer res.Body.Close()

	w.Header().Set("Content-Type", "application/json")
	io.Copy(w, res.Body)
}

// SearchYouTube busca en YouTube usando yt-dlp.
func (h *AudioHandler) SearchYouTube(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query().Get("q")
	if query == "" {
		http.Error(w, "missing query parameter", http.StatusBadRequest)
		return
	}

	// Buscamos 10 resultados, ordenados por relevancia (por defecto en ytsearch)
	args := []string{fmt.Sprintf("ytsearch10:%s", query), "--dump-json", "--ignore-errors", "--no-warnings", "--flat-playlist", "-v"}
	cmd := exec.Command("yt-dlp", args...)
	cmd.Stderr = os.Stderr // Redirigir errores y logs informativos a la terminal para poder ver si las cookies funcionan
	out, _ := cmd.Output()

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
	// 1. Limitar tamaño a 20MB (protege la memoria de tu VPS gratuito)
	r.Body = http.MaxBytesReader(w, r.Body, 20<<20)
	if err := r.ParseMultipartForm(20 << 20); err != nil {
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

	// 3. Guardar temporalmente (cumpliendo la regla del PRD: procesamiento efímero)
	tmpPath := filepath.Join("/tmp", handler.Filename)
	dst, err := os.Create(tmpPath)
	if err != nil {
		http.Error(w, "Error interno guardando archivo", http.StatusInternalServerError)
		return
	}
	defer dst.Close()
	io.Copy(dst, file)

	// 4. Iniciar aislamiento pasándole la ruta temporal al adaptador inyectado
	jobID, err := h.processor.StartIsolation(r.Context(), tmpPath)
	if err != nil {
		http.Error(w, "Error iniciando la IA", http.StatusInternalServerError)
		return
	}

	// 5. Devolver el JobID
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"job_id": jobID})
}

// GET /api/audio/status?job_id=xxx
func (h *AudioHandler) HandleStatus(w http.ResponseWriter, r *http.Request) {
	jobID := r.URL.Query().Get("job_id")
	if jobID == "" {
		http.Error(w, "Falta el parámetro job_id", http.StatusBadRequest)
		return
	}

	job, err := h.processor.CheckStatus(r.Context(), jobID)
	if err != nil {
		http.Error(w, "Trabajo no encontrado", http.StatusNotFound)
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
	var req DownloadRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Cuerpo de petición inválido", http.StatusBadRequest)
		return
	}

	if req.VideoID == "" {
		http.Error(w, "Falta videoId", http.StatusBadRequest)
		return
	}

	tmpPath := filepath.Join("/tmp", fmt.Sprintf("%s.mp3", req.VideoID))
	url := fmt.Sprintf("https://youtube.com/watch?v=%s", req.VideoID)

	args := []string{
		"-f", "bestaudio",
		"--extract-audio",
		"--audio-format", "mp3",
		"-o", tmpPath,
		"-v",
		url,
	}
	cmd := exec.Command("yt-dlp", args...)
	cmd.Stderr = os.Stderr // Mostrar progreso en la terminal
	if err := cmd.Run(); err != nil {
		http.Error(w, "Error descargando audio", http.StatusInternalServerError)
		return
	}

	jobID, err := h.processor.StartIsolation(r.Context(), tmpPath)
	if err != nil {
		http.Error(w, "Error iniciando la IA", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"job_id": jobID})
}
