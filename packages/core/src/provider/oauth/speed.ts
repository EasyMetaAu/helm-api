import { z } from "zod";

const SpeedSchema = z.object({
  ttftMs: z.number().nonnegative(),
  tokensPerSecond: z.number().positive().nullable(),
  estimateMs: z.number().nonnegative(),
});
type Speed = z.infer<typeof SpeedSchema>;

// Passive measurements only: no background requests or additional provider spend.
export function createSpeedHistory(limit = 1024) {
  const records = new Map<string, { speed: Speed; at: number; weight: number }>();
  const key = (account: string, model: string | null) => JSON.stringify([account, model]);
  return {
    read(account: string, model: string | null, now: number): Speed | null {
      const record = records.get(key(account, model));
      return record && now - record.at < 3_600_000 ? record.speed : null;
    },
    record(
      account: string,
      model: string | null,
      ttft: number,
      tokens: number | null,
      generationMs: number,
      now: number,
    ): void {
      if (!Number.isFinite(ttft) || ttft < 0) return;
      const id = key(account, model);
      const previous = records.get(id);
      const weight =
        previous && now - previous.at < 3_600_000
          ? previous.weight * 2 ** (-(now - previous.at) / 1_200_000)
          : 0;
      const ttftMs = (ttft + (previous?.speed.ttftMs ?? 0) * weight) / (1 + weight);
      const tps =
        tokens !== null && tokens > 0 && generationMs > 0 ? (tokens * 1000) / generationMs : null;
      const tokensPerSecond =
        tps === null
          ? null
          : previous?.speed.tokensPerSecond && weight > 0
            ? (tps + previous.speed.tokensPerSecond * weight) / (1 + weight)
            : tps;
      const speed = {
        ttftMs,
        tokensPerSecond,
        estimateMs: ttftMs + (tokensPerSecond === null ? 0 : 200_000 / tokensPerSecond),
      };
      records.delete(id);
      records.set(id, { speed, at: now, weight: weight + 1 });
      while (records.size > limit) records.delete(records.keys().next().value as string);
    },
  };
}
