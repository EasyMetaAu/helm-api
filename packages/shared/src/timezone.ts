import { z } from "zod";

export const IanaTimezoneSchema = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => {
    // Reject abbreviations/offsets even if a particular ICU build accepts them.
    if (value !== "UTC" && !/^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)+$/.test(value)) return false;
    try {
      new Intl.DateTimeFormat("en", { timeZone: value }).format(0);
      return true;
    } catch {
      return false;
    }
  }, "Expected an IANA timezone such as America/Los_Angeles");
export const AccountTimezoneInputSchema = z.object({ timezone: IanaTimezoneSchema.nullable() });
export const AccountTimezoneViewSchema = z.object({
  override: IanaTimezoneSchema.nullable(),
  effective: IanaTimezoneSchema.nullable(),
  source: z.enum(["manual", "ipwho.is", "ipapi.is", "unknown"]),
  checkedAt: z.number().nullable(),
});
export type AccountTimezoneView = z.infer<typeof AccountTimezoneViewSchema>;
