import { useState, useRef, useEffect } from "react";
import { Upload, Music, Play, Pause, SkipBack, SkipForward, Repeat, Mic2, FileAudio, Search, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";
import { Progress } from "@/components/ui/progress";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [trackMeta, setTrackMeta] = useState<{ title: string, artist: string, thumb: string } | null>(null);
  const [status, setStatus] = useState<"idle" | "uploading" | "processing" | "ready">("idle");
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState("");
  
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  
  const [instrumentalUrl, setInstrumentalUrl] = useState("");
  const [vocalUrl, setVocalUrl] = useState("");
  
  const [isPlaying, setIsPlaying] = useState(false);
  const [vocalVolume, setVocalVolume] = useState([50]);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [showAlert, setShowAlert] = useState(false);
  const [alertTriggered, setAlertTriggered] = useState(false);

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
  
  const instrumentalRef = useRef<HTMLAudioElement>(null);
  const vocalRef = useRef<HTMLAudioElement>(null);

  const formatTime = (secs: number) => {
    if (!secs || isNaN(secs)) return "00:00";
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  // --- LYRICS STATE ---
  const [lyrics, setLyrics] = useState<{time: number, text: string}[]>([]);
  const [currentLyricIndex, setCurrentLyricIndex] = useState(-1);
  const lyricsContainerRef = useRef<HTMLDivElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      setFile(e.target.files[0]);
    }
  };

  const handleUpload = async () => {
    if (!file) return;
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
      });
      if (!res.ok) throw new Error("Error en la subida");
      const data = await res.json();
      setJobId(data.job_id);
      setStatus("processing");
    } catch (err: any) {
      setError(err.message);
      setStatus("idle");
    }
  };

  useEffect(() => {
    if (searchQuery.trim().length < 2) {
      setSuggestions([]);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/audio/suggest?q=${encodeURIComponent(searchQuery)}`);
        if (!res.ok) return;
        const data = await res.json();
        if (Array.isArray(data) && data.length > 1 && Array.isArray(data[1])) {
          setSuggestions(data[1].slice(0, 5));
        }
      } catch (err) {}
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const handleSearch = async (e?: React.FormEvent, directQuery?: string) => {
    if (e) e.preventDefault();
    const q = directQuery || searchQuery;
    if (!q.trim()) return;
    setSearchQuery(q);
    setShowSuggestions(false);
    setIsSearching(true);
    try {
      const res = await fetch(`/api/audio/search?q=${encodeURIComponent(q)}`);
      if (!res.ok) throw new Error("Search API failed");
      const data = await res.json();
      setSearchResults(data || []);
    } catch (err) {
      console.error("Error buscando:", err);
    }
    setIsSearching(false);
  };

  const handleDownload = async (videoId: string, title: string, thumb: string, author: string) => {
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
      });
      if (!res.ok) throw new Error("Error en la descarga");
      const data = await res.json();
      setJobId(data.job_id);
      setStatus("processing");
    } catch (err: any) {
      setError(err.message);
      setStatus("idle");
    }
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
    } catch (e) {
      setLyrics([{ time: 0, text: "Letra no encontrada en LRCLIB." }]);
    }
  };

  useEffect(() => {
    if (status === "processing" && jobId) {
      const interval = setInterval(async () => {
        try {
          const res = await fetch(`/api/audio/status?job_id=${jobId}`);
          const data = await res.json();
          if (data.status === "completed") {
            setInstrumentalUrl(data.instrumental_url);
            setVocalUrl(data.vocal_url);
            setStatus("ready");
            if (file) fetchLyrics(file.name);
            clearInterval(interval);
          } else if (data.status === "failed") {
            setError(data.error || "Error procesando audio");
            setStatus("idle");
            clearInterval(interval);
          }
        } catch (e) {
          console.error(e);
        }
      }, 3000);
      return () => clearInterval(interval);
    }
  }, [status, jobId, file]);

  const togglePlay = () => {
    if (!instrumentalRef.current || !vocalRef.current) return;
    if (isPlaying) {
      instrumentalRef.current.pause();
      vocalRef.current.pause();
    } else {
      instrumentalRef.current.play();
      vocalRef.current.play();
    }
    setIsPlaying(!isPlaying);
  };

  useEffect(() => {
    if (vocalRef.current) {
      vocalRef.current.volume = vocalVolume[0] / 100;
    }
  }, [vocalVolume]);

  const handleTimeUpdate = () => {
    if (!instrumentalRef.current || lyrics.length === 0) return;
    const currentT = instrumentalRef.current.currentTime;
    setCurrentTime(currentT);
    
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
        const activeElement = lyricsContainerRef.current.children[1]?.children[newIndex] as HTMLElement;
        if (activeElement) {
          activeElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }
    }
  };

  return (
    <div className="h-screen w-full bg-black text-white flex overflow-hidden font-sans relative antialiased">
      {/* Background with volume and subtle noise/gradient */}
      <div className="absolute inset-0 bg-gradient-to-br from-[#1c1c1e] via-black to-black z-0" />
      
      <main className="flex-1 px-8 relative z-10 flex flex-col justify-center items-center overflow-hidden h-full min-h-0 w-full">
        {/* El popup viejo se reemplazó por un panel lateral animado (split-screen) */}

        {status === "idle" && (
          <div className="flex flex-col gap-8 w-full max-w-2xl">
            <Card className="relative z-50 bg-white/[0.04] backdrop-blur-2xl saturate-[180%] border-0 ring-1 ring-white/5 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_24px_40px_rgba(0,0,0,0.4)] overflow-visible rounded-[2rem]">
              <CardContent className="p-8 flex flex-col gap-6 overflow-visible">
                <h2 className="text-2xl font-bold tracking-tight text-center text-balance">Busca tu canción en YouTube</h2>
                <div className="relative">
                  <form onSubmit={e => handleSearch(e)} className="flex gap-2">
                    <div className="relative flex-1">
                      <button type="submit" className="absolute left-4 top-1/2 -translate-y-1/2 text-white/40 hover:text-white transition active:scale-90">
                        <Search className="w-5 h-5" />
                      </button>
                      <input
                        type="text"
                        placeholder="Buscar canción en YouTube..."
                        className="w-full pl-12 pr-4 h-14 bg-white/5 backdrop-blur-md border-0 ring-1 ring-white/10 rounded-2xl text-sm focus:outline-none focus:ring-2 focus:ring-white/30 placeholder:text-white/40 text-white"
                        value={searchQuery}
                        onChange={e => {
                          setSearchQuery(e.target.value);
                          setShowSuggestions(true);
                        }}
                      />
                    </div>
                    <Button 
                      type="submit" 
                      className="bg-white/[0.06] hover:bg-white/10 active:scale-[0.96] backdrop-blur-md border-0 ring-1 ring-white/10 text-white px-8 h-14 rounded-2xl font-medium whitespace-nowrap transition shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_8px_20px_rgba(0,0,0,0.2)]"
                      disabled={isSearching}
                    >
                      {isSearching ? (
                        <Loader2 className="w-5 h-5 animate-spin" />
                      ) : (
                        "Buscar"
                      )}
                    </Button>
                  </form>
                  {showSuggestions && suggestions.length > 0 && (
                    <div className="absolute z-50 w-full mt-2 bg-[#1c1c1e]/90 backdrop-blur-3xl saturate-[180%] border border-white/10 rounded-2xl overflow-hidden shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_24px_40px_rgba(0,0,0,0.8)]">
                      {suggestions.map((sugg, idx) => (
                        <div
                          key={idx}
                          className="px-5 py-4 text-sm text-white/90 hover:bg-white/5 cursor-pointer transition-colors border-b border-white/5 last:border-0"
                          onClick={() => handleSearch(undefined, sugg)}
                        >
                          {sugg}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                {searchResults.length > 0 && (
                  <div className="flex flex-col gap-3 max-h-72 overflow-y-auto pr-2 custom-scrollbar">
                    {searchResults.map(result => {
                      let pArtist = result.author || "";
                      let pTitle = result.title;
                      if (result.title.includes("-")) {
                        const pts = result.title.split("-");
                        pArtist = pts[0].trim();
                        pTitle = pts.slice(1).join("-").trim();
                      }
                      return (
                        <div 
                          key={result.videoId} 
                          onClick={() => handleDownload(result.videoId, result.title, result.thumb || "", result.author || "")}
                          className="flex gap-4 p-4 bg-white/5 hover:bg-white/10 border border-white/5 hover:border-white/10 rounded-2xl cursor-pointer active:scale-[0.96] transition items-center backdrop-blur-sm"
                        >
                          <img src={result.thumb || ""} alt={result.title} className="w-16 h-12 object-cover rounded-md outline outline-1 outline-white/10" />
                          <div className="flex-1 min-w-0 flex flex-col">
                            {pArtist && <span className="text-xs text-white/50 truncate">{pArtist}</span>}
                            <span className="text-sm font-semibold truncate text-white">{pTitle}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>

            <div className="flex items-center gap-4 text-white/20">
              <div className="flex-1 h-px bg-white/10"></div>
              <span className="text-sm font-medium tracking-wide">O SUBIR ARCHIVO LOCAL</span>
              <div className="flex-1 h-px bg-white/10"></div>
            </div>

            <Card className="w-full bg-white/[0.04] backdrop-blur-2xl saturate-[180%] border-0 ring-1 ring-white/5 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_24px_40px_rgba(0,0,0,0.4)] rounded-[2rem]">
              <CardContent className="p-8 flex flex-col items-center gap-6">
                <div 
                  className="w-full border-0 ring-1 ring-white/5 rounded-3xl p-10 text-center hover:bg-white/10 active:scale-[0.98] transition cursor-pointer bg-black/20 relative shadow-[inset_0_4px_24px_rgba(0,0,0,0.4)]"
                  onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                      setFile(e.dataTransfer.files[0]);
                    }
                  }}
                  onClick={() => document.getElementById("file-upload")?.click()}
                >
                  <input 
                    id="file-upload"
                    type="file" 
                    accept="audio/mp3, audio/wav, audio/mpeg" 
                    onChange={handleFileChange}
                    className="hidden"
                  />
                  <Upload className="w-8 h-8 mx-auto text-white/50 mb-4" />
                  <p className="text-white/70 font-medium text-pretty">
                    {file ? file.name : "Arrastrá tu MP3 acá o hacé clic"}
                  </p>
                </div>

                {error && <p className="text-red-400 text-sm">{error}</p>}

                <Button 
                  onClick={handleUpload} 
                  disabled={!file}
                  className="w-full bg-white/[0.06] hover:bg-white/10 active:scale-[0.96] backdrop-blur-md border-0 ring-1 ring-white/10 text-white h-14 rounded-2xl text-md font-medium whitespace-nowrap transition shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_8px_20px_rgba(0,0,0,0.4)]"
                >
                  <Upload className="w-5 h-5 mr-2" /> {file ? "Procesar Archivo" : "Seleccioná una canción"}
                </Button>
              </CardContent>
            </Card>
          </div>
        )}

        {(status === "uploading" || status === "processing") && (
          <div className="flex flex-col items-center gap-6 text-center bg-white/[0.04] backdrop-blur-2xl saturate-[180%] border border-white/10 p-12 rounded-[2rem] shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_24px_40px_rgba(0,0,0,0.4)]">
            <div className="w-20 h-20 rounded-full border-4 border-white/30 border-t-white animate-spin" />
            <h2 className="text-3xl font-bold tracking-tight text-white text-balance">
              {status === "uploading" ? "Cargando pista..." : "Procesando audio..."}
            </h2>
            <p className="text-white/60 max-w-xs text-pretty">Aislando voces y sincronizando letras...</p>
            {status === "processing" && <Progress value={66} className="w-64 h-2 bg-white/10" />}
          </div>
        )}

        {status === "ready" && (
          <div className="w-full max-w-[90rem] flex h-full gap-8 justify-center items-center py-6 overflow-hidden">
            <motion.div 
              layout
              transition={{ type: "tween", ease: [0.16, 1, 0.3, 1], duration: 1.2 }}
              className={cn(
                "flex flex-col gap-6 h-full min-h-0 overflow-hidden",
                showAlert ? "w-1/2 max-w-2xl" : "w-full max-w-3xl"
              )}
            >
              <div className="flex flex-col gap-4 shrink-0 w-full relative">
                <Button 
                  variant="ghost" 
                  size="icon" 
                  onClick={() => setShowAlert(!showAlert)}
                  className={cn(
                    "absolute right-0 top-0 rounded-full w-12 h-12 transition active:scale-95 z-10",
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
              className="w-full grow shrink min-h-0 bg-white/[0.04] backdrop-blur-2xl saturate-[180%] border border-white/10 rounded-[2rem] flex flex-col relative shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_12px_40px_rgba(0,0,0,0.5)] overflow-y-auto custom-scrollbar"
            >
               <div className="sticky top-0 left-0 w-full h-1 bg-white/20 z-20" />
               
               {lyrics.length === 0 ? (
                 <div className="flex h-full items-center justify-center">
                    <div className="w-10 h-10 rounded-full border-2 border-t-white border-r-transparent border-b-transparent border-l-transparent animate-spin" />
                 </div>
               ) : (
                 <div className="py-32 flex flex-col gap-8 px-8">
                   {lyrics.map((line, idx) => {
                     const isActive = idx === currentLyricIndex;
                     const isPast = idx < currentLyricIndex;
                     
                     return (
                         <h2 
                         key={idx}
                         className={`text-3xl md:text-5xl font-bold text-center leading-tight transition duration-500 ease-out cursor-pointer ${
                           isActive 
                             ? "text-white scale-[1.05] opacity-100 drop-shadow-[0_4px_12px_rgba(255,255,255,0.1)]" 
                             : isPast 
                                ? "text-white/40 scale-100 opacity-50"
                                : "text-white/40 scale-100 opacity-50"
                         }`}
                         onClick={() => {
                           if (instrumentalRef.current && vocalRef.current) {
                             instrumentalRef.current.currentTime = line.time;
                             vocalRef.current.currentTime = line.time;
                             if (!isPlaying) togglePlay();
                           }
                         }}
                       >
                         {line.text}
                       </h2>
                     );
                   })}
                 </div>
               )}
            </div>

            {/* Playback Controls */}
            <div className="flex flex-col gap-6 bg-white/[0.04] backdrop-blur-2xl saturate-[180%] border border-white/10 p-8 rounded-[2rem] shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_12px_40px_rgba(0,0,0,0.5)] shrink-0">
              <audio 
                ref={instrumentalRef} 
                src={instrumentalUrl} 
                onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
                onTimeUpdate={handleTimeUpdate} 
                onEnded={() => setIsPlaying(false)} 
              />
              <audio ref={vocalRef} src={vocalUrl} />

              <div className="flex items-center gap-4 w-full">
                <span className="text-xs font-medium text-white/50 w-12 text-right tabular-nums">{formatTime(currentTime)}</span>
                <Slider
                  value={[currentTime]}
                  max={duration || 100}
                  step={1}
                  onValueChange={(val) => {
                    if (instrumentalRef.current && vocalRef.current) {
                      instrumentalRef.current.currentTime = val[0];
                      vocalRef.current.currentTime = val[0];
                      setCurrentTime(val[0]);
                    }
                  }}
                  className="flex-1 cursor-pointer"
                />
                <span className="text-xs font-medium text-white/50 w-12 tabular-nums">{formatTime(duration)}</span>
              </div>

              <div className="flex items-center justify-between">
                <Button variant="ghost" size="icon" className="text-white/60 hover:text-white hover:bg-white/10 active:scale-[0.96] rounded-full w-12 h-12 transition">
                  <Repeat className="w-5 h-5" />
                </Button>
                
                <div className="flex items-center gap-6">
                  <Button variant="ghost" size="icon" className="text-white hover:bg-white/10 active:scale-[0.96] rounded-full w-12 h-12 transition">
                    <SkipBack className="w-6 h-6" />
                  </Button>
                  <Button 
                    onClick={togglePlay}
                    className="w-20 h-20 rounded-full bg-white text-black hover:scale-[1.03] active:scale-[0.96] transition shadow-[0_4px_20px_rgba(255,255,255,0.3)] border-0 flex items-center justify-center"
                  >
                    {isPlaying ? <Pause className="w-8 h-8 fill-current" /> : <Play className="w-8 h-8 fill-current translate-x-0.5" />}
                  </Button>
                  <Button variant="ghost" size="icon" className="text-white/80 hover:text-white hover:bg-white/10 active:scale-[0.96] rounded-full w-12 h-12 transition">
                    <SkipForward className="w-6 h-6" />
                  </Button>
                </div>

                <div className="flex items-center gap-4 bg-white/[0.04] backdrop-blur-2xl saturate-[180%] border border-white/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.1)] px-6 py-3 rounded-2xl">
                  <div className="flex flex-col">
                    <span className="text-xs font-bold text-white/90 uppercase tracking-wider">Voz Original</span>
                    <span className="text-white/50 text-[10px]">Ajustá el cantante original</span>
                  </div>
                  <Slider 
                    value={vocalVolume} 
                    onValueChange={(val) => setVocalVolume(Array.isArray(val) ? val : [val])} 
                    max={100} 
                    step={1}
                    className="w-32"
                  />
                </div>
              </div>
            </div>
            </motion.div>

            <AnimatePresence mode="popLayout">
              {showAlert && (
                <motion.div
                  layout
                  initial={{ opacity: 0, x: 100, scale: 0.95 }}
                  animate={{ opacity: 1, x: 0, scale: 1 }}
                  exit={{ opacity: 0, x: 100, scale: 0.95 }}
                  transition={{
                    default: { type: "tween", ease: [0.16, 1, 0.3, 1], duration: 1.2 },
                    opacity: { duration: 0.4, ease: "linear" }
                  }}
                  className="w-1/2 max-w-2xl h-full min-h-0 flex flex-col py-4"
                >
                  <Card className="w-full h-full bg-white/[0.04] backdrop-blur-2xl saturate-[180%] border-0 ring-1 ring-white/5 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_24px_40px_rgba(0,0,0,0.4)] overflow-hidden flex flex-col rounded-[2rem]">
                    <CardContent className="p-8 flex flex-col gap-6 h-full min-h-0">
                      <div className="flex justify-between items-center shrink-0">
                        <h2 className="text-2xl font-bold tracking-tight text-white">Buscar próxima canción</h2>
                        <button onClick={() => setShowAlert(false)} className="text-white/40 hover:text-white transition active:scale-90">
                          <div className="text-2xl">&times;</div>
                        </button>
                      </div>

                      <div className="relative shrink-0">
                        <form onSubmit={e => handleSearch(e)} className="flex gap-2">
                          <div className="relative flex-1">
                            <button type="submit" className="absolute left-4 top-1/2 -translate-y-1/2 text-white/40 hover:text-white transition active:scale-90">
                              <Search className="w-5 h-5" />
                            </button>
                            <input
                              type="text"
                              placeholder="Buscar en YouTube..."
                              className="w-full pl-12 pr-4 h-14 bg-white/5 backdrop-blur-md border-0 ring-1 ring-white/10 rounded-2xl text-sm focus:outline-none focus:ring-2 focus:ring-white/30 placeholder:text-white/40 text-white"
                              value={searchQuery}
                              onChange={e => {
                                setSearchQuery(e.target.value);
                                setShowSuggestions(true);
                              }}
                            />
                          </div>
                          <Button 
                            type="submit" 
                            className="bg-white/[0.06] hover:bg-white/10 active:scale-[0.96] backdrop-blur-md border-0 ring-1 ring-white/10 text-white px-6 h-14 rounded-2xl font-medium whitespace-nowrap transition"
                            disabled={isSearching}
                          >
                            {isSearching ? <Loader2 className="w-5 h-5 animate-spin" /> : "Buscar"}
                          </Button>
                        </form>
                        {showSuggestions && suggestions.length > 0 && (
                          <div className="absolute z-50 w-full mt-2 bg-[#1c1c1e]/90 backdrop-blur-3xl saturate-[180%] border border-white/10 rounded-2xl overflow-hidden shadow-2xl">
                            {suggestions.map((sugg, idx) => (
                              <div
                                key={idx}
                                className="px-5 py-4 text-sm text-white/90 hover:bg-white/5 cursor-pointer transition-colors border-b border-white/5 last:border-0"
                                onClick={() => handleSearch(undefined, sugg)}
                              >
                                {sugg}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {searchResults.length > 0 && (
                        <div className="flex flex-col gap-3 h-full overflow-y-auto pr-2 custom-scrollbar">
                          {searchResults.map(result => {
                            let pArtist = result.author || "";
                            let pTitle = result.title;
                            if (result.title.includes("-")) {
                              const pts = result.title.split("-");
                              pArtist = pts[0].trim();
                              pTitle = pts.slice(1).join("-").trim();
                            }
                            return (
                              <div 
                                key={result.videoId} 
                                onClick={() => handleDownload(result.videoId, result.title, result.thumb || "", result.author || "")}
                                className="flex gap-4 p-4 bg-white/5 hover:bg-white/10 border-0 ring-1 ring-white/5 hover:ring-white/10 rounded-2xl cursor-pointer active:scale-[0.96] transition items-center backdrop-blur-sm"
                              >
                                <img src={result.thumb || ""} alt={result.title} className="w-16 h-12 object-cover rounded-md outline outline-1 outline-white/10" />
                                <div className="flex-1 min-w-0 flex flex-col">
                                  {pArtist && <span className="text-xs text-white/50 truncate">{pArtist}</span>}
                                  <span className="text-sm font-semibold truncate text-white">{pTitle}</span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
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
