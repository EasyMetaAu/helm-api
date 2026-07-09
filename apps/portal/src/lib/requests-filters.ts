export const RANGE_KEYS = ["all", "today", "yesterday", "7d", "30d"] as const;
export type RangeKey = (typeof RANGE_KEYS)[number];

export const PAGE_SIZE_OPTIONS = [25, 50, 100, 200] as const;
export const DEFAULT_PAGE_SIZE = 50;
export const DEFAULT_RANGE: RangeKey = "today";

export interface RequestsFilters {
  range: RangeKey;
  startDate?: string;
  endDate?: string;
  status?: "ok" | "error";
  model?: string;
  page: number;
  pageSize: number;
}

export const DEFAULT_FILTERS: RequestsFilters = {
  range: DEFAULT_RANGE,
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
};

const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = new Set<RequestsFilters["status"]>(["ok", "error"]);

function isRange(value: string | null): value is RangeKey {
  return value !== null && (RANGE_KEYS as readonly string[]).includes(value);
}

export function parseFilters(sp: URLSearchParams): RequestsFilters {
  const rangeRaw = sp.get("range");
  const startDate = sp.get("start")?.trim();
  const endDate = sp.get("end")?.trim();
  const status = sp.get("status");
  const model = sp.get("model")?.trim();
  const pageRaw = Number(sp.get("page"));
  const pageSizeRaw = Number(sp.get("pageSize"));

  return {
    range: isRange(rangeRaw) ? rangeRaw : DEFAULT_RANGE,
    startDate: isValidDateParam(startDate) ? startDate : undefined,
    endDate: isValidDateParam(endDate) ? endDate : undefined,
    status:
      status && STATUSES.has(status as RequestsFilters["status"])
        ? (status as RequestsFilters["status"])
        : undefined,
    model: model || undefined,
    page: Number.isInteger(pageRaw) && pageRaw > 1 ? pageRaw : 1,
    pageSize: (PAGE_SIZE_OPTIONS as readonly number[]).includes(pageSizeRaw)
      ? pageSizeRaw
      : DEFAULT_PAGE_SIZE,
  };
}

export function filtersToSearch(filters: RequestsFilters): string {
  const qs = new URLSearchParams();
  const custom =
    filters.startDate && filters.endDate
      ? resolveCustomDayWindow(filters.startDate, filters.endDate)
      : null;

  if (custom) {
    qs.set("start", filters.startDate as string);
    qs.set("end", filters.endDate as string);
  } else if (filters.range !== DEFAULT_RANGE) {
    qs.set("range", filters.range);
  }
  if (filters.status) qs.set("status", filters.status);
  if (filters.model?.trim()) qs.set("model", filters.model.trim());
  if (filters.page > 1) qs.set("page", String(filters.page));
  if (filters.pageSize !== DEFAULT_PAGE_SIZE)
    qs.set("pageSize", String(filters.pageSize));
  return qs.toString();
}

export function resolveWindow(
  range: RangeKey,
  nowMs: number,
): { start?: number; end?: number } {
  switch (range) {
    case "all":
      return {};
    case "today": {
      const d = new Date(nowMs);
      d.setHours(0, 0, 0, 0);
      return { start: d.getTime() };
    }
    case "yesterday": {
      const d = new Date(nowMs);
      d.setHours(0, 0, 0, 0);
      const end = d.getTime();
      d.setDate(d.getDate() - 1);
      return { start: d.getTime(), end };
    }
    case "7d":
      return { start: nowMs - 7 * DAY_MS };
    case "30d":
      return { start: nowMs - 30 * DAY_MS };
  }
}

export function localMidnightMs(date: string): number | null {
  if (!DATE_RE.test(date)) return null;
  const d = new Date(`${date}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  const [year, month, day] = date.split("-").map(Number);
  if (
    d.getFullYear() !== year ||
    d.getMonth() + 1 !== month ||
    d.getDate() !== day
  ) {
    return null;
  }
  return d.getTime();
}

export function isValidDateParam(date: string | undefined): date is string {
  return date !== undefined && localMidnightMs(date) !== null;
}

export function resolveCustomDayWindow(
  startDate: string,
  endDate: string,
): { start: number; end: number } | null {
  const start = localMidnightMs(startDate);
  const endMidnight = localMidnightMs(endDate);
  if (start === null || endMidnight === null || start > endMidnight)
    return null;
  const end = new Date(endMidnight);
  end.setDate(end.getDate() + 1);
  return { start, end: end.getTime() };
}

export function todayLocalDate(nowMs: number = Date.now()): string {
  const d = new Date(nowMs);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}
