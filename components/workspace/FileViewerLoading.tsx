import { LoadingState } from "@/components/shared/LoadingState";

/** Same label and full-pane layout while the viewer, content, or editor loads. */
export default function FileViewerLoading() {
  return <LoadingState label="Loading file…" className="flex-1 self-stretch min-h-0 w-full bg-bg-tint p-6 text-sm" />;
}
