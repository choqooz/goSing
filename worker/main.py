from fastapi import FastAPI, UploadFile, BackgroundTasks
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
import uuid
import subprocess
import os
import urllib.parse

app = FastAPI()

# Exponemos la carpeta 'separated' al mundo en la ruta '/audio'
app.mount("/audio", StaticFiles(directory="separated"), name="audio")

jobs = {}

def run_demucs(job_id: str, file_path: str, filename: str):
    try:
        # --two-stems vocals: le dice a Demucs que junte Bajo+Batería+Otros en una sola pista 'no_vocals'
        # --mp3: convierte la salida a mp3 para no devolver un WAV inmenso
        subprocess.run(["demucs", "-n", "htdemucs", "--two-stems", "vocals", "--mp3", file_path], check=True)
        
        # Demucs crea una carpeta con el nombre original del archivo (sin extensión)
        folder_name = os.path.splitext(filename)[0]
        safe_folder = urllib.parse.quote(folder_name) # Codificamos espacios de la URL
        
        jobs[job_id]["status"] = "completed"
        # Guardamos las URLs reales expuestas por StaticFiles
        jobs[job_id]["instrumental_url"] = f"http://127.0.0.1:8000/audio/htdemucs/{safe_folder}/no_vocals.mp3"
        jobs[job_id]["vocal_url"] = f"http://127.0.0.1:8000/audio/htdemucs/{safe_folder}/vocals.mp3"
        
    except Exception as e:
        jobs[job_id]["status"] = "failed"
        jobs[job_id]["error"] = str(e)

@app.post("/api/process")
async def process_audio(file: UploadFile, background_tasks: BackgroundTasks):
    job_id = f"demucs-{uuid.uuid4()}"
    file_path = f"/tmp/{file.filename}"
    
    with open(file_path, "wb") as buffer:
        buffer.write(await file.read())
        
    jobs[job_id] = {"status": "processing"}
    background_tasks.add_task(run_demucs, job_id, file_path, file.filename)
    
    return JSONResponse(content={"job_id": job_id})

@app.get("/api/status/{job_id}")
async def get_status(job_id: str):
    if job_id not in jobs:
        return JSONResponse(status_code=404, content={"error": "Trabajo no encontrado"})
    return jobs[job_id]
