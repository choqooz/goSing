import { Progress } from "@/components/ui/progress";

interface ProcessingStatusProps {
  isUploading: boolean;
}

export function ProcessingStatus({ isUploading }: ProcessingStatusProps) {
  const message = isUploading ? "Cargando pista..." : "Procesando audio...";

  return (
    <div role="status" aria-live="polite" className="w-full max-w-2xl flex flex-col items-center gap-6 text-center bg-white/[0.04] backdrop-blur-2xl saturate-[180%] border border-white/10 p-6 sm:p-12 rounded-[2rem] shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_24px_40px_rgba(0,0,0,0.4)]">
      <div aria-hidden="true" className="w-20 h-20 rounded-full border-4 border-white/30 border-t-white animate-spin motion-reduce:animate-none" />
      <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-white text-balance">{message}</h2>
      <p className="text-white/60 max-w-xs text-pretty">Aislando voces y sincronizando letras...</p>
      {!isUploading && <div aria-hidden="true"><Progress value={66} className="w-64 h-2 bg-white/10" /></div>}
    </div>
  );
}
