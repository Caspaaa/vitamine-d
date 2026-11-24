export function Splash() {
  return (
    <div className="grid h-dvh place-items-center bg-sand text-ink">
      <div className="flex flex-col items-center gap-3">
        <svg width="72" height="72" viewBox="0 0 72 72" aria-hidden="true">
          <circle cx="36" cy="36" r="16" fill="#ffb703" />
          {Array.from({ length: 12 }, (_, i) => (
            <rect key={i} x="34" y="6" width="4" height="10" rx="2" fill="#fb8500" transform={`rotate(${i * 30} 36 36)`} />
          ))}
        </svg>
        <p className="text-2xl font-semibold">Vitamine D</p>
      </div>
    </div>
  );
}
