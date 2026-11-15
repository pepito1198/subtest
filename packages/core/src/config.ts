import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

const selector = z.object({ role: z.string().optional(), name: z.string().optional(), label: z.string().optional(), placeholder: z.string().optional(), text: z.string().optional(), css: z.string().optional() }).strict();
const action = z.union([
  z.object({ navigate: z.string() }).strict(),
  z.object({ click: selector }).strict(),
  z.object({ fill: selector.extend({ value: z.string() }) }).strict(),
  z.object({ waitFor: z.object({ urlIncludes: z.string().optional(), text: z.string().optional() }).strict() }).strict(),
  z.object({ expect: z.object({ urlIncludes: z.string().optional(), text: z.string().optional() }).strict() }).strict(),
  z.object({ stripeCheckout: z.object({ paymentMethod: z.enum(["4242424242424242"]).optional() }).strict() }).strict(),
]);
const assertion = z.union([
  z.object({ "checkout.session.mode": z.string() }).strict(),
  z.object({ "checkout.session.status": z.string() }).strict(),
  z.object({ "checkout.session.payment_status": z.string() }).strict(),
  z.object({ "checkout.session.price": z.string() }).strict(),
  z.object({ "subscription.status": z.string() }).strict(),
  z.object({ "subscription.interval": z.string() }).strict(),
  z.object({ "invoice.count": z.number().int().nonnegative() }).strict(),
  z.object({ "invoice.latest.status": z.string() }).strict(),
]);

export const ConfigSchema = z.object({
  version: z.literal(1),
  project: z.string().min(1),
  baseUrl: z.string().url(),
  allowRemoteTestUrl: z.boolean().optional(),
  stripe: z.object({
    clock: z.object({ enabled: z.boolean().default(false), advanceTimeoutMs: z.number().int().positive().default(30000) }).default({}),
    webhook: z.object({ endpoint: z.string().url().optional(), waitForEvents: z.boolean().default(false), timeoutMs: z.number().int().positive().default(20000) }).default({}),
  }).default({}),
  browser: z.object({ engine: z.literal("chromium").default("chromium"), headless: z.boolean().default(true), actionTimeoutMs: z.number().int().positive().default(10000), navigationTimeoutMs: z.number().int().positive().default(30000) }).default({}),
  history: z.object({ database: z.string().default(".subtest/history.sqlite"), retainDays: z.number().int().positive().default(30) }).default({}),
  scenarios: z.array(z.object({
    id: z.string().max(64).regex(/^[a-z0-9][a-z0-9_-]*$/),
    name: z.string().min(1),
    customer: z.object({ email: z.string().email() }).optional(),
    product: z.object({ priceId: z.string().startsWith("price_") }),
    checkout: z.object({ path: z.string(), steps: z.array(action).default([]), expect: z.object({ urlIncludes: z.string().optional() }).default({}) }).optional(),
    clock: z.object({ advanceBy: z.string().regex(/^\d+[smhd]$/) }).optional(),
    assertions: z.array(assertion).default([]),
  }).strict()).min(1),
}).strict().superRefine((config, context) => {
  const ids = new Set<string>();
  config.scenarios.forEach((scenario, index) => {
    if (ids.has(scenario.id)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["scenarios", index, "id"], message: "Scenario IDs must be unique." });
    ids.add(scenario.id);
  });
});

export type SubtestConfig = z.infer<typeof ConfigSchema>;
export type Scenario = SubtestConfig["scenarios"][number];

export async function loadConfig(path = "subtest.yml"): Promise<{ config: SubtestConfig; path: string }> {
  const absolutePath = resolve(path);
  const source = await readFile(absolutePath, "utf8");
  const parsed: unknown = parse(source, { uniqueKeys: true });
  return { config: ConfigSchema.parse(parsed), path: absolutePath };
}

export function isLocalUrl(url: string): boolean {
  const host = new URL(url).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

export function redact(value: string): string {
  return value.replace(/sk_(?:test|live)_[A-Za-z0-9]+/g, "[REDACTED_STRIPE_KEY]").replace(/whsec_[A-Za-z0-9]+/g, "[REDACTED_WEBHOOK_SECRET]");
}
