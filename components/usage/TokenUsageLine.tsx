import { uncachedInputTokens } from "@/lib/client/tokenUsage";

interface Props {
  inputTokensTotal: number;
  inputTokensCacheRead: number;
  outputTokensTotal: number;
  scope: string;
}

/** Compact token breakdown shared by chat answers and dashboard tool detail. */
export default function TokenUsageLine({ inputTokensTotal, inputTokensCacheRead, outputTokensTotal, scope }: Props) {
  return (
    <div className="flex justify-start gap-2.5 px-0.5 text-2xs select-none">
      <span title={`Uncached input tokens ${scope}`} className="text-sky-800">
        ↑ {uncachedInputTokens(inputTokensTotal, inputTokensCacheRead).toLocaleString()}
      </span>
      <span title={`Cached input tokens ${scope}`} className="text-text-3">
        ↻ {inputTokensCacheRead.toLocaleString()}
      </span>
      <span title={`Output tokens ${scope}`} className="text-orange-800">
        ↓ {outputTokensTotal.toLocaleString()}
      </span>
    </div>
  );
}
