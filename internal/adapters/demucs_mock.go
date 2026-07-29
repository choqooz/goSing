package adapters

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/chocolate/gosing/internal/core"
)

// DemucsMock es EL ADAPTADOR. Implementa la interfaz core.AudioProcessor.
type DemucsMock struct {
	mu   sync.Mutex // Mutex para evitar problemas de concurrencia al leer/escribir jobs
	jobs map[string]*core.AudioJob
}

// NewDemucsMock crea una nueva instancia del simulador
func NewDemucsMock() *DemucsMock {
	return &DemucsMock{
		jobs: make(map[string]*core.AudioJob),
	}
}

func (m *DemucsMock) StartIsolation(ctx context.Context, filePath string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	// Generamos un ID falso único
	jobID := fmt.Sprintf("mock-job-%d", time.Now().UnixNano())
	
	m.jobs[jobID] = &core.AudioJob{
		ID:     jobID,
		Status: "processing",
	}

	// Acá viene la magia de Go: Goroutines.
	// Simulamos que la IA (a través del túnel) tarda 10 segundos de forma asíncrona
	go func(id string) {
		time.Sleep(10 * time.Second)
		
		m.mu.Lock()
		defer m.mu.Unlock()
		
		if job, exists := m.jobs[id]; exists {
			job.Status = "completed"
			// URLs falsas simulando que el túnel nos devolvió los archivos
			job.InstrumentalURL = "https://simulador.com/instrumental.mp3"
			job.VocalURL = "https://simulador.com/voz.mp3"
		}
	}(jobID)

	return jobID, nil
}

func (m *DemucsMock) CheckStatus(ctx context.Context, jobID string) (*core.AudioJob, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	job, exists := m.jobs[jobID]
	if !exists {
		return nil, fmt.Errorf("trabajo no encontrado: %s", jobID)
	}

	return job, nil
}
