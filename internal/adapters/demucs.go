package adapters

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"

	"github.com/chocolate/gosing/internal/core"
)

// DemucsAdapter es el cliente HTTP real que habla con nuestro Worker en Python
type DemucsAdapter struct {
	baseURL string
	client  *http.Client
}

func NewDemucsAdapter(baseURL string) *DemucsAdapter {
	return &DemucsAdapter{
		baseURL: baseURL,
		client:  &http.Client{},
	}
}

func (a *DemucsAdapter) StartIsolation(ctx context.Context, filePath string) (string, error) {
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

	resp, err := a.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("error conectando con el worker de Python (¿está corriendo uvicorn?): %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("el worker devolvió status %d", resp.StatusCode)
	}

	// 4. Parseamos el JSON para sacar el job_id real de Python
	var result struct {
		JobID string `json:"job_id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", fmt.Errorf("error parseando respuesta del worker: %w", err)
	}

	return result.JobID, nil
}

func (a *DemucsAdapter) CheckStatus(ctx context.Context, jobID string) (*core.AudioJob, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", a.baseURL+"/api/status/"+jobID, nil)
	if err != nil {
		return nil, err
	}

	resp, err := a.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("error conectando con el worker: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("el worker devolvió status %d", resp.StatusCode)
	}

	// Parseamos el estado que devuelve Python
	var result struct {
		Status          string `json:"status"`
		Error           string `json:"error"`
		InstrumentalURL string `json:"instrumental_url"`
		VocalURL        string `json:"vocal_url"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("error parseando estado: %w", err)
	}

	// Lo transformamos al modelo Core de Go
	return &core.AudioJob{
		ID:              jobID,
		Status:          result.Status,
		InstrumentalURL: result.InstrumentalURL,
		VocalURL:        result.VocalURL,
	}, nil
}
