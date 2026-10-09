"use client";

// The app's on/off control: a labelled pill switch. `ariaLabel` overrides the visible label for
// assistive tech when the label alone does not say what flipping it does.
export function Switch({
  checked,
  onChange,
  label,
  ariaLabel,
  title,
  disabled,
  className = "",
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  ariaLabel?: string;
  title?: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      title={title}
      onClick={() => onChange(!checked)}
      disabled={disabled}
      className={`shrink-0 flex items-center gap-2.5 select-none transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary-soft disabled:opacity-60 disabled:cursor-default ${className}`}
    >
      <span className={`text-ms font-semibold ${checked ? "text-primary" : "text-text-2"}`}>{label}</span>
      <span className={`relative w-9 h-5 rounded-full transition-colors ${checked ? "bg-primary" : "bg-border"}`}>
        <span
          className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-all ${checked ? "left-[18px]" : "left-0.5"}`}
        />
      </span>
    </button>
  );
}
