import { useEffect, useId, useRef, useState } from "react";
import { Loader2, Search } from "lucide-react";

export interface SearchResult { author?: string; thumb?: string; title: string; videoId: string; }
interface SongSearchProps { compact?: boolean; onSelect: (result: SearchResult) => void; }
interface ActiveSearch { controller: AbortController; generation: number; value: string; }

function splitTitle(result: SearchResult) {
  if (!result.title.includes("-")) return { artist: result.author ?? "", title: result.title };
  const [artist, ...titleParts] = result.title.split("-");
  return { artist: artist.trim(), title: titleParts.join("-").trim() };
}

export function SongSearch({ compact = false, onSelect }: SongSearchProps) {
  const id = useId().replace(/:/g, "");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState("");
  const activeSearch = useRef<ActiveSearch | null>(null);
  const searchGeneration = useRef(0);
  const listboxId = `${id}-suggestions`;

  useEffect(() => {
    if (query.trim().length < 2) { setSuggestions([]); return; }
    let active = true;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch(`/api/audio/suggest?q=${encodeURIComponent(query)}`, { signal: controller.signal });
          if (!response.ok) throw new Error("Suggestion request failed");
          const data: unknown = await response.json();
          if (active && Array.isArray(data) && Array.isArray(data[1])) setSuggestions(data[1].slice(0, 5).filter((item): item is string => typeof item === "string"));
        } catch {
          if (active) setSuggestions([]);
        }
      })();
    }, 300);
    return () => { active = false; window.clearTimeout(timer); controller.abort(); };
  }, [query]);

  useEffect(() => () => {
    activeSearch.current?.controller.abort();
    searchGeneration.current += 1;
  }, []);

  const search = async (value = query) => {
    const normalizedValue = value.trim();
    if (!normalizedValue || activeSearch.current?.value === normalizedValue) return;
    activeSearch.current?.controller.abort();
    const controller = new AbortController();
    const generation = ++searchGeneration.current;
    activeSearch.current = { controller, generation, value: normalizedValue };
    setQuery(normalizedValue);
    setIsOpen(false);
    setActiveIndex(-1);
    setIsSearching(true);
    setError("");
    try {
      const response = await fetch(`/api/audio/search?q=${encodeURIComponent(normalizedValue)}`, { signal: controller.signal });
      if (!response.ok) throw new Error();
      const data: unknown = await response.json();
      if (generation === searchGeneration.current) setResults(Array.isArray(data) ? data.filter(isSearchResult) : []);
    } catch {
      if (generation === searchGeneration.current && !controller.signal.aborted) setError("No se pudo buscar la canción. Intentá nuevamente.");
    } finally {
      if (activeSearch.current?.generation === generation) activeSearch.current = null;
      if (generation === searchGeneration.current) setIsSearching(false);
    }
  };

  const selectSuggestion = (suggestion: string) => { void search(suggestion); };
  const expanded = isOpen && suggestions.length > 0;
  const resultContainerClass = compact ? "flex flex-col gap-3 max-h-80 lg:h-full lg:max-h-none overflow-y-auto pr-2 custom-scrollbar" : "flex flex-col gap-3 max-h-72 overflow-y-auto pr-2 custom-scrollbar";
  const resultClass = compact ? "flex w-full min-w-0 gap-4 p-4 bg-white/5 hover:bg-white/10 border-0 ring-1 ring-white/5 hover:ring-white/10 rounded-2xl cursor-pointer active:scale-[0.96] transition motion-reduce:transition-none motion-reduce:transform-none items-center backdrop-blur-sm text-left" : "flex w-full min-w-0 gap-4 p-4 bg-white/5 hover:bg-white/10 border border-white/5 hover:border-white/10 rounded-2xl cursor-pointer active:scale-[0.96] transition motion-reduce:transition-none motion-reduce:transform-none items-center backdrop-blur-sm text-left";

  return (
    <div className="relative min-w-0 shrink-0">
      <form onSubmit={(event) => { event.preventDefault(); void search(); }} className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <button type="submit" disabled={isSearching} aria-label="Buscar canción" className="absolute left-1 top-1/2 -translate-y-1/2 w-11 h-11 flex items-center justify-center text-white/40 hover:text-white transition active:scale-90 motion-reduce:transition-none motion-reduce:transform-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30 disabled:opacity-50">
            <Search className="w-5 h-5" />
          </button>
          <label className="sr-only" htmlFor={`${id}-input`}>Buscar canción en YouTube</label>
          <input
            id={`${id}-input`}
            type="text"
            role="combobox"
            aria-activedescendant={activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined}
            aria-autocomplete="list"
            aria-controls={listboxId}
            aria-expanded={expanded}
            placeholder={compact ? "Buscar en YouTube..." : "Buscar canción en YouTube..."}
            className="w-full pl-12 pr-4 h-14 bg-white/5 backdrop-blur-md border-0 ring-1 ring-white/10 rounded-2xl text-sm focus:outline-none focus:ring-2 focus:ring-white/30 placeholder:text-white/40 text-white"
            value={query}
            onChange={(event) => { setQuery(event.target.value); setIsOpen(true); setActiveIndex(-1); }}
            onKeyDown={(event) => {
              if (event.key === "Escape") { setIsOpen(false); setActiveIndex(-1); return; }
              if (!suggestions.length || (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Enter")) return;
              if (event.key === "Enter" && activeIndex >= 0) { event.preventDefault(); selectSuggestion(suggestions[activeIndex]); return; }
              if (event.key !== "Enter") { event.preventDefault(); setIsOpen(true); setActiveIndex((index) => event.key === "ArrowDown" ? (index + 1) % suggestions.length : index <= 0 ? suggestions.length - 1 : index - 1); }
            }}
          />
        </div>
        <button type="submit" disabled={isSearching} className={`w-full sm:w-auto bg-white/[0.06] hover:bg-white/10 active:scale-[0.96] backdrop-blur-md border-0 ring-1 ring-white/10 text-white h-14 rounded-2xl font-medium whitespace-nowrap transition motion-reduce:transition-none motion-reduce:transform-none disabled:opacity-50 ${compact ? "px-6" : "px-8 shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_8px_20px_rgba(0,0,0,0.2)]"}`}>
          {isSearching ? <Loader2 className="w-5 h-5 animate-spin motion-reduce:animate-none" /> : "Buscar"}
        </button>
      </form>
      {expanded && (
        <ul id={listboxId} role="listbox" className={`absolute z-50 w-full mt-2 bg-[#1c1c1e]/90 backdrop-blur-3xl saturate-[180%] border border-white/10 rounded-2xl overflow-hidden ${compact ? "shadow-2xl" : "shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_24px_40px_rgba(0,0,0,0.8)]"}`}>
          {suggestions.map((suggestion, index) => <li key={suggestion} id={`${id}-option-${index}`} role="option" aria-selected={activeIndex === index} className={`px-5 py-4 text-left text-sm text-white/90 hover:bg-white/5 cursor-pointer transition-colors border-b border-white/5 last:border-0 ${activeIndex === index ? "bg-white/5" : ""}`} onMouseDown={(event) => event.preventDefault()} onClick={() => selectSuggestion(suggestion)}>{suggestion}</li>)}
        </ul>
      )}
      {error && <p role="alert" className="text-red-400 text-sm">{error}</p>}
      {results.length > 0 && (
        <ul className={resultContainerClass}>
          {results.map((result) => {
            const { artist, title } = splitTitle(result);
            return <li key={result.videoId}><button type="button" className={resultClass} onClick={() => onSelect(result)} aria-label={`Seleccionar ${title}${artist ? ` de ${artist}` : ""}`}><img src={result.thumb ?? ""} alt="" className="w-16 h-12 object-cover rounded-md outline outline-1 outline-white/10" /><span className="flex-1 min-w-0 flex flex-col">{artist && <span className="text-xs text-white/50 truncate">{artist}</span>}<span className="text-sm font-semibold truncate text-white">{title}</span></span></button></li>;
          })}
        </ul>
      )}
    </div>
  );
}

function isSearchResult(value: unknown): value is SearchResult { return typeof value === "object" && value !== null && "title" in value && typeof value.title === "string" && "videoId" in value && typeof value.videoId === "string"; }
