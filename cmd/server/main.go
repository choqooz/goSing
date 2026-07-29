package main

import (
	"fmt"
	"io/fs"
	"log"
	"net/http"

	"github.com/chocolate/gosing/internal/adapters"
	"github.com/chocolate/gosing/internal/handlers"
	"github.com/chocolate/gosing/ui"
)

func main() {
	distFS, err := fs.Sub(ui.Files, "dist")
	if err != nil {
		log.Fatal("Error cargando frontend: ", err)
	}

	// --- INYECCIÓN DE DEPENDENCIAS (La magia de Clean Architecture) ---
	// 1. Instanciamos los Adaptadores (los conectores al mundo exterior)
	// Ya no usamos el Mock. Usamos el cliente HTTP real apuntando a Python.
	demucsClient := adapters.NewDemucsAdapter("http://127.0.0.1:8000")
	
	// 2. Instanciamos los Handlers inyectándole el adaptador real
	// El handler ni se entera de que cambiamos el adaptador, ¡cumple el mismo contrato!
	audioHandler := handlers.NewAudioHandler(demucsClient)
	// -----------------------------------------------------------------

	mux := http.NewServeMux()

	// Healthcheck
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"status": "ok", "message": "API corriendo"}`)
	})

	// Endpoints de Audio
	mux.HandleFunc("/api/audio/search", audioHandler.SearchYouTube)
	mux.HandleFunc("/api/audio/suggest", audioHandler.SuggestYouTube)
	mux.HandleFunc("POST /api/audio/upload", audioHandler.HandleUpload)
	mux.HandleFunc("POST /api/audio/download", audioHandler.HandleDownload)
	mux.HandleFunc("GET /api/audio/status", audioHandler.HandleStatus)

	// Frontend estático
	mux.Handle("/", http.FileServer(http.FS(distFS)))

	port := ":8080"
	log.Printf("🚀 Servidor levantado en http://localhost%s\n", port)
	if err := http.ListenAndServe(port, mux); err != nil {
		log.Fatal(err)
	}
}
