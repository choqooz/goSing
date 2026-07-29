import { cn } from "@/lib/utils"

export function Slider({
  className,
  value,
  max = 100,
  step = 1,
  onValueChange,
  ...props
}: any) {
  const val = Array.isArray(value) ? value[0] : value || 0;
  const percentage = max > 0 ? (val / max) * 100 : 0;

  return (
    <div className={cn("relative flex items-center w-full h-4", className)}>
      {/* Track */}
      <div className="absolute w-full h-2 bg-white/20 rounded-full shadow-[inset_0_1px_2px_rgba(0,0,0,0.5)] overflow-hidden">
        {/* Indicator */}
        <div 
          className="absolute top-0 left-0 h-full bg-white"
          style={{ width: `${percentage}%` }}
        />
      </div>
      {/* Native Input for interaction */}
      <input 
        type="range"
        min={0}
        max={max}
        step={step}
        value={val}
        onChange={(e) => onValueChange?.([parseFloat(e.target.value)])}
        className="absolute w-full h-full opacity-0 cursor-pointer z-10"
        {...props}
      />
      {/* Thumb visual (pointer events none so input underneath catches events) */}
      <div 
        className="absolute w-4 h-4 bg-white rounded-full shadow-[0_2px_8px_rgba(0,0,0,0.5)] pointer-events-none z-0"
        style={{ left: `calc(${percentage}% - 8px)` }}
      />
    </div>
  )
}
