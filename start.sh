#!/bin/bash
# GoSing Unified Launcher
# Este script levanta el Frontend, el Backend en Go y el Worker en Python, 
# y se asegura de apagar los tres cuando presiones Ctrl+C.

echo "🚀 Iniciando el ecosistema GoSing (Vite + Go + Python)..."
echo "========================================================="

# Matar procesos hijos al cerrar el script (Ctrl+C)
trap 'echo -e "\n🛑 Apagando todos los servicios..."; kill 0' EXIT

# 1. Iniciar Frontend (Vite) en segundo plano
echo "🎨 Levantando Frontend (Puerto 5173)..."
cd frontend && npm run dev &
cd ..

# 2. Iniciar Python Worker en segundo plano
echo "🧠 Levantando Python Worker (Demucs/YT-DLP)..."
cd worker && source venv/bin/activate && python main.py &
cd ..

# 3. Iniciar Backend (Go) en segundo plano
echo "⚙️  Levantando Go Backend..."
go run cmd/server/main.go &

echo "========================================================="
echo "✅ Sistema corriendo en paralelo."
echo "👉 Presiona Ctrl+C para detener todo al mismo tiempo."
echo "========================================================="

# Esperar a que los procesos en segundo plano terminen
wait
