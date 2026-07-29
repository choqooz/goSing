package core

import "context"

// AudioJob representa el estado del procesamiento en la IA
type AudioJob struct {
	ID              string `json:"id"`
	Status          string `json:"status"` // "processing", "completed", "failed"
	InstrumentalURL string `json:"instrumental_url"`
	VocalURL        string `json:"vocal_url"`
}

// AudioProcessor es EL PUERTO (El contrato).
// Define QUÉ tiene que hacer cualquier proveedor de IA que usemos,
// sin importar si es Replicate, Fal.ai o un simulador.
type AudioProcessor interface {
	// StartIsolation envía el archivo y devuelve un ID de trabajo asíncrono
	StartIsolation(ctx context.Context, filePath string) (string, error)
	
	// CheckStatus revisa si la IA ya terminó de procesar ese ID
	CheckStatus(ctx context.Context, jobID string) (*AudioJob, error)
}
