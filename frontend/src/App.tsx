import { useState, useRef, useEffect } from "react";
import { Upload, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { cn } from "@/lib/utils";
import { useDualAudio } from "@/player/use-dual-audio";
import { SongSearch, type SearchResult } from "@/components/song-search";
import { ProcessingStatus } from "@/components/processing-status";
import { UploadDropzone } from "@/components/upload-dropzone";
import { LyricsList } from "@/components/lyrics-list";
import { PlayerControls } from "@/components/player-controls";
import { scrollBehavior } from "@/lib/motion";

interface IngressTask {
  controller: AbortController;
  generation: number;
}

export default function App() {
  const reduceMotion = useReducedMotion();
  const [file, setFile] = useState<File | null>(null);
  const [trackMeta, setTrackMeta] = useState<{ title: string, artist: string, thumb: string } | null>(null);
  const [status, setStatus] = useState<"idle" | "uploading" | "processing" | "ready">("idle");
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState("");
  
  const [instrumentalUrl, setInstrumentalUrl] = useState("");
  const [vocalUrl, setVocalUrl] = useState("");
  
  const [showAlert, setShowAlert] = useState(false);
  const [alertTriggered, setAlertTriggered] = useState(false);
  const ingressTaskRef = useRef<IngressTask | null>(null);

  const startIngressTask = () => {
    const previousTask = ingressTaskRef.current;
    previousTask?.controller.abort();
    const task = {
      controller: new AbortController(),
      generation: (previousTask?.generation ?? 0) + 1,
    };
    ingressTaskRef.current = task;
    setJobId(null);
    return task;
  };

  const isLatestIngressTask = (task: IngressTask) => ingressTaskRef.current?.generation === task.generation;

  useEffect(() => () => {
    ingressTaskRef.current?.controller.abort();
  }, []);

  const getTrackInfo = () => {
    if (trackMeta) return trackMeta;
    if (!file) return { artist: "", title: "Pista Desconocida", thumb: "" };
    let raw = file.name.replace(/\.(mp3|wav)$/i, "").replace(/-\s*SpotubeDL\.com/gi, "").trim();
    if (raw.includes("-")) {
      const parts = raw.split("-");
      return { artist: parts[0].trim(), title: parts.slice(1).join("-").trim(), thumb: "" };
    }
    return { artist: "", title: raw, thumb: "" };
  };
  const { artist, title, thumb } = getTrackInfo();
  
  // --- LYRICS STATE ---
  const [lyrics, setLyrics] = useState<{time: number, text: string}[]>([]);
  const [currentLyricIndex, setCurrentLyricIndex] = useState(-1);
  const lyricsContainerRef = useRef<HTMLDivElement>(null);

  const handleUpload = async () => {
    if (!file) return;
    const task = startIngressTask();
    setStatus("uploading");
    setError("");
    setLyrics([]);
    setShowAlert(false);
    setAlertTriggered(false);
    setTrackMeta(null);

    const formData = new FormData();
    formData.append("audio", file);

    try {
      const res = await fetch("/api/audio/upload", {
        method: "POST",
        body: formData,
        signal: task.controller.signal,
      });
      if (!res.ok) throw new Error("Error en la subida");
      const data = await res.json();
      if (!isLatestIngressTask(task)) return;
      setJobId(data.job_id);
      setStatus("processing");
    } catch (err: any) {
      if (!isLatestIngressTask(task) || task.controller.signal.aborted) return;
      setError(err.message);
      setStatus("idle");
    }
  };

  const handleDownload = async (videoId: string, title: string, thumb: string) => {
    const task = startIngressTask();
    setStatus("uploading");
    setError("");
    setLyrics([]);
    setShowAlert(false);
    setAlertTriggered(false);
    setFile(new File([], `${title}.mp3`));
    
    let parsedArtist = "";
    let parsedTitle = title;
    if (title.includes("-")) {
      const parts = title.split("-");
      parsedArtist = parts[0].trim();
      parsedTitle = parts.slice(1).join("-").trim();
    }
    setTrackMeta({ title: parsedTitle, artist: parsedArtist, thumb });

    try {
      const res = await fetch("/api/audio/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId }),
        signal: task.controller.signal,
      });
      if (!res.ok) throw new Error("Error en la descarga");
      const data = await res.json();
      if (!isLatestIngressTask(task)) return;
      setJobId(data.job_id);
      setStatus("processing");
    } catch (err: any) {
      if (!isLatestIngressTask(task) || task.controller.signal.aborted) return;
      setError(err.message);
      setStatus("idle");
    }
  };

  const handleSearchSelection = (result: SearchResult) => {
    void handleDownload(result.videoId, result.title, result.thumb ?? "");
  };

  const parseLRC = (lrcText: string) => {
    const lines = lrcText.split('\n');
    const parsedLyrics = [];
    const timeRegex = /\[(\d{2}):(\d{2})\.(\d{2,3})\]/;

    for (const line of lines) {
      const match = line.match(timeRegex);
      if (match) {
        const minutes = parseInt(match[1], 10);
        const seconds = parseInt(match[2], 10);
        const milliseconds = parseInt(match[3], 10);
        // Normalize milliseconds length
        const timeInSeconds = minutes * 60 + seconds + milliseconds / (match[3].length === 3 ? 1000 : 100);
        const text = line.replace(timeRegex, '').trim();
        if (text) {
          parsedLyrics.push({ time: timeInSeconds, text });
        }
      }
    }
    setLyrics(parsedLyrics);
  };

  const fetchLyrics = async (filename: string) => {
    try {
      let artist = "";
      let track = filename
        .replace(/\.(mp3|wav)$/i, "")
        .replace(/-\s*SpotubeDL\.com/gi, "") // Limpiamos basura de descargas
        .trim();
      
      // Intentamos parsear "Artista - Canción"
      if (track.includes("-")) {
        const parts = track.split("-");
        artist = parts[0].trim();
        track = parts.slice(1).join("-").trim(); 
      }

      const searchQuery = artist ? `${artist} ${track}` : track;
      const params = new URLSearchParams();
      params.append("q", searchQuery);

      const res = await fetch(`https://lrclib.net/api/search?${params.toString()}`);
      if (!res.ok) throw new Error("Lyrics not found");
      const data = await res.json();
      
      if (data && data.length > 0) {
        const bestResult = data.find((d: any) => d.syncedLyrics);
        if (bestResult) {
          parseLRC(bestResult.syncedLyrics);
        } else {
          setLyrics([{ time: 0, text: "Letra sin sincronizar disponible :(" }]);
        }
      } else {
        setLyrics([{ time: 0, text: "Letra no encontrada en LRCLIB." }]);
      }
    } catch {
      setLyrics([{ time: 0, text: "Letra no encontrada en LRCLIB." }]);
    }
  };

  useEffect(() => {
    if (status !== "processing" || !jobId) return;

    let active = true;
    let timeout: ReturnType<typeof window.setTimeout> | undefined;
    const controller = new AbortController();

    const poll = async () => {
      try {
        const res = await fetch(`/api/audio/status?job_id=${jobId}`, { signal: controller.signal });
        if (!res.ok) throw new Error("Status request failed");
        const data = await res.json();
        if (!active) return;

        if (data.status === "completed") {
          setInstrumentalUrl(data.instrumental_url);
          setVocalUrl(data.vocal_url);
          setStatus("ready");
          if (file) void fetchLyrics(file.name);
          return;
        }
        if (data.status === "failed") {
          setError(data.error || "Error procesando audio");
          setStatus("idle");
          return;
        }
        timeout = window.setTimeout(poll, 3000);
      } catch {
        if (!active || controller.signal.aborted) return;
        setError("No se pudo consultar el estado del procesamiento.");
        setStatus("idle");
      }
    };

    timeout = window.setTimeout(poll, 3000);
    return () => {
      active = false;
      if (timeout !== undefined) window.clearTimeout(timeout);
      controller.abort();
    };
  }, [status, jobId, file]);

  const handleMasterTimeUpdate = (currentT: number) => {
    if (lyrics.length === 0) return;
    
    if (duration > 0 && duration - currentT <= 60 && !alertTriggered) {
      setShowAlert(true);
      setAlertTriggered(true);
    }
    
    let newIndex = -1;
    for (let i = 0; i < lyrics.length; i++) {
      if (currentT >= lyrics[i].time) {
        newIndex = i;
      } else {
        break;
      }
    }
    
    if (newIndex !== currentLyricIndex && newIndex !== -1) {
      setCurrentLyricIndex(newIndex);
      if (lyricsContainerRef.current) {
        const activeElement = lyricsContainerRef.current.querySelector<HTMLElement>(`[data-lyric-index="${newIndex}"]`);
        if (activeElement) {
          activeElement.scrollIntoView({ behavior: scrollBehavior(Boolean(reduceMotion)), block: 'center' });
        }
      }
    }
  };

  const {
    currentTime,
    duration,
    handleMasterEnded,
    handleMasterLoadedMetadata,
    handleMasterTimeUpdate: updateMasterTime,
    instrumentalRef,
    isPlaying,
    playbackError,
    seek,
    setVocalVolume,
    togglePlay,
    vocalRef,
    vocalVolume,
  } = useDualAudio({
    onMasterTimeUpdate: handleMasterTimeUpdate,
    sourceKey: `${instrumentalUrl}\u0000${vocalUrl}`,
    trackMasterTime: lyrics.length > 0,
  });

  return (
    <div className="min-h-[100dvh] lg:h-[100dvh] w-full bg-black text-white flex overflow-x-hidden font-sans relative antialiased">
      {/* Background with volume and subtle noise/gradient */}
      <div className="absolute inset-0 bg-gradient-to-br from-[#1c1c1e] via-black to-black z-0" />
      
      <main className="flex-1 min-w-0 px-4 sm:px-8 py-6 lg:py-0 relative z-10 flex flex-col justify-start lg:justify-center items-center overflow-visible lg:overflow-hidden lg:h-full min-h-0 w-full">
        {/* El popup viejo se reemplazó por un panel lateral animado (split-screen) */}

        {status === "idle" && (
          <div className="flex flex-col gap-8 w-full max-w-2xl">
            <Card className="relative z-50 bg-white/[0.04] backdrop-blur-2xl saturate-[180%] border-0 ring-1 ring-white/5 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_24px_40px_rgba(0,0,0,0.4)] overflow-visible rounded-[2rem]">
              <CardContent className="p-6 sm:p-8 flex flex-col gap-6 overflow-visible">
                <h2 className="text-2xl font-bold tracking-tight text-center text-balance">Busca tu canción en YouTube</h2>
                <SongSearch onSelect={handleSearchSelection} />
              </CardContent>
            </Card>

            <div className="flex items-center gap-4 text-white/20">
              <div className="flex-1 h-px bg-white/10"></div>
              <span className="text-sm font-medium tracking-wide">O SUBIR ARCHIVO LOCAL</span>
              <div className="flex-1 h-px bg-white/10"></div>
            </div>

            <Card className="w-full bg-white/[0.04] backdrop-blur-2xl saturate-[180%] border-0 ring-1 ring-white/5 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_24px_40px_rgba(0,0,0,0.4)] rounded-[2rem]">
              <CardContent className="p-6 sm:p-8 flex flex-col items-center gap-6">
                <UploadDropzone error={error} file={file} onFileChange={setFile} />

                <Button 
                  onClick={handleUpload} 
                  disabled={!file}
                  className="w-full bg-white/[0.06] hover:bg-white/10 active:scale-[0.96] backdrop-blur-md border-0 ring-1 ring-white/10 text-white h-14 rounded-2xl text-md font-medium whitespace-nowrap transition motion-reduce:transition-none motion-reduce:transform-none shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_8px_20px_rgba(0,0,0,0.4)]"
                >
                  <Upload className="w-5 h-5 mr-2" /> {file ? "Procesar Archivo" : "Seleccioná una canción"}
                </Button>
              </CardContent>
            </Card>
          </div>
        )}

        {(status === "uploading" || status === "processing") && (
          <ProcessingStatus isUploading={status === "uploading"} />
        )}

        {status === "ready" && (
          <div className="w-full max-w-[90rem] flex flex-col lg:flex-row gap-6 lg:gap-8 justify-center items-stretch lg:items-center py-0 lg:py-6 overflow-visible lg:overflow-hidden">
            <motion.div 
              layout={!reduceMotion}
              transition={reduceMotion ? { duration: 0 } : { type: "tween", ease: [0.16, 1, 0.3, 1], duration: 1.2 }}
              className={cn(
                "flex flex-col gap-6 w-full lg:h-full lg:min-h-0 overflow-visible lg:overflow-hidden",
                showAlert ? "lg:w-1/2 lg:max-w-2xl" : "lg:w-full lg:max-w-3xl"
              )}
            >
              <div className="flex flex-col gap-4 shrink-0 w-full relative">
                <Button 
                  variant="ghost" 
                  size="icon" 
                  onClick={() => setShowAlert(!showAlert)}
                  aria-label="Buscar próxima canción"
                  className={cn(
                    "absolute right-0 top-0 rounded-full w-12 h-12 transition active:scale-95 motion-reduce:transition-none motion-reduce:transform-none z-10",
                    showAlert ? "bg-white/10 text-white" : "text-white/40 hover:text-white hover:bg-white/10"
                  )}
                  title="Buscar próxima canción"
                >
                  <Search className="w-5 h-5" />
                </Button>
                <p className="text-white/50 font-bold tracking-widest uppercase text-xs text-center">REPRODUCIENDO</p>
              <div className="flex items-center gap-6 justify-center">
                {thumb && <img src={thumb} alt={title} className="w-24 h-24 object-cover rounded-2xl shadow-xl outline outline-1 outline-white/10 shrink-0" />}
                <div className="flex flex-col text-left">
                  {artist && <p className="text-white/60 font-medium text-lg">{artist}</p>}
                  <h1 className="text-3xl font-bold tracking-tight text-balance">{title}</h1>
                </div>
              </div>
            </div>

            {/* Lyrics Area (Dynamic) */}
            <div 
              ref={lyricsContainerRef}
              className="w-full grow shrink min-h-[18rem] h-[48dvh] max-h-[32rem] lg:h-auto lg:max-h-none lg:min-h-0 bg-white/[0.04] backdrop-blur-2xl saturate-[180%] border border-white/10 rounded-[2rem] flex flex-col relative shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_12px_40px_rgba(0,0,0,0.5)] overflow-y-auto overscroll-contain custom-scrollbar"
            >
               <div className="sticky top-0 left-0 w-full h-1 bg-white/20 z-20" />
               
               {lyrics.length === 0 ? (
                 <div className="flex h-full items-center justify-center">
                    <div className="w-10 h-10 rounded-full border-2 border-t-white border-r-transparent border-b-transparent border-l-transparent animate-spin motion-reduce:animate-none" />
                 </div>
               ) : <LyricsList currentLyricIndex={currentLyricIndex} lyrics={lyrics} onSeek={(time) => {
                 if (instrumentalRef.current && vocalRef.current) {
                   seek(time);
                   if (!isPlaying) void togglePlay();
                 }
               }} />}
            </div>

            {/* Playback Controls */}
            <div>
              <audio
                ref={instrumentalRef}
                src={instrumentalUrl}
                aria-hidden="true"
                onLoadedMetadata={handleMasterLoadedMetadata}
                onTimeUpdate={updateMasterTime}
                onEnded={handleMasterEnded}
              />
              <audio ref={vocalRef} src={vocalUrl} aria-hidden="true" />
              <PlayerControls
                currentTime={currentTime}
                duration={duration}
                isPlaying={isPlaying}
                onSeek={seek}
                onTogglePlay={togglePlay}
                onVocalVolumeChange={setVocalVolume}
                playbackError={playbackError}
                vocalVolume={vocalVolume}
              />
            </div>
            </motion.div>

            <AnimatePresence mode="popLayout">
              {showAlert && (
                <motion.div
                  layout={!reduceMotion}
                  initial={reduceMotion ? false : { opacity: 0, x: 100, scale: 0.95 }}
                  animate={reduceMotion ? { opacity: 1 } : { opacity: 1, x: 0, scale: 1 }}
                  exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: 100, scale: 0.95 }}
                  transition={reduceMotion ? { duration: 0.01 } : {
                    default: { type: "tween", ease: [0.16, 1, 0.3, 1], duration: 1.2 },
                    opacity: { duration: 0.4, ease: "linear" }
                  }}
                  className="w-full lg:w-1/2 lg:max-w-2xl lg:h-full lg:min-h-0 flex flex-col pb-6 lg:py-4"
                >
                  <Card className="w-full h-full bg-white/[0.04] backdrop-blur-2xl saturate-[180%] border-0 ring-1 ring-white/5 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_24px_40px_rgba(0,0,0,0.4)] overflow-hidden flex flex-col rounded-[2rem]">
                    <CardContent className="p-6 sm:p-8 flex flex-col gap-6 lg:h-full lg:min-h-0">
                      <div className="flex justify-between items-center shrink-0">
                        <h2 className="text-2xl font-bold tracking-tight text-white">Buscar próxima canción</h2>
                        <button aria-label="Cerrar búsqueda" onClick={() => setShowAlert(false)} className="w-11 h-11 flex items-center justify-center text-white/40 hover:text-white transition active:scale-90 motion-reduce:transition-none motion-reduce:transform-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30">
                          <div className="text-2xl">&times;</div>
                        </button>
                      </div>

                      <SongSearch compact onSelect={handleSearchSelection} />
                    </CardContent>
                  </Card>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}
      </main>
    </div>
  );
}
