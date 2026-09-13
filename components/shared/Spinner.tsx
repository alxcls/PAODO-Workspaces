/** Shared spinning ring. Use decorative when a containing status already provides its label. */
export function Spinner({
  className = "w-3.5 h-3.5",
  decorative = false,
}: {
  className?: string;
  decorative?: boolean;
}) {
  return (
    <span
      className={`shrink-0 block border-2 border-current border-t-transparent rounded-full animate-spin ${className}`}
      role={decorative ? undefined : "status"}
      aria-label={decorative ? undefined : "Loading"}
      aria-hidden={decorative || undefined}
    />
  );
}
