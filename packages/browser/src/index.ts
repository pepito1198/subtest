import { chromium, type Page, type Locator } from "playwright";
import type { Scenario, SubtestConfig } from "@subtest/core";

type Selector = { role?: string | undefined; name?: string | undefined; label?: string | undefined; placeholder?: string | undefined; text?: string | undefined; css?: string | undefined };
export interface BrowserScenarioResult {
  checkoutSessionId: string;
  checkoutStatus: "completed" | "not_attempted" | "blocked";
  pageUrl: string;
  title: string;
  warning?: string;
  visibleError?: string;
}

function stripeCheckoutSession(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "checkout.stripe.com") return undefined;
    return /\b(cs_test_[A-Za-z0-9]+)\b/.exec(parsed.href)?.[1];
  } catch {
    return undefined;
  }
}

function safePageUrl(page: Page, fallbackUrl: string): string {
  try {
    const current = new URL(page.url());
    if (current.protocol === "http:" || current.protocol === "https:") return current.origin + current.pathname;
  } catch {
    // Return the last known application URL for opaque browser error pages.
  }
  const fallback = new URL(fallbackUrl);
  return fallback.origin + fallback.pathname;
}

async function visibleCheckoutError(page: Page): Promise<string | undefined> {
  try {
    const raw = await page.locator('[role="alert"], [aria-live="assertive"]').allTextContents();
    const safe = raw.map((value) => value.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
      .replace(/\b\d{12,19}\b/g, "[number]")
      .replace(/\b(?:sk|rk)_(?:test|live)_[A-Za-z0-9]+\b/g, "[Stripe key]")
      .replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 3).join(" · ").slice(0, 300);
    return safe || undefined;
  } catch {
    return undefined;
  }
}

function locate(page: Page, selector: Selector): Locator {
  if (selector.role) return page.getByRole(selector.role as Parameters<Page["getByRole"]>[0], selector.name ? { name: selector.name } : undefined);
  if (selector.label) return page.getByLabel(selector.label);
  if (selector.placeholder) return page.getByPlaceholder(selector.placeholder);
  if (selector.text) return page.getByText(selector.text, { exact: true });
  if (selector.css) return page.locator(selector.css);
  throw new Error("A browser action needs role/name, label, text, or css selector.");
}

export async function runBrowserScenario(config: SubtestConfig, scenario: Scenario, headed: boolean, browserSmoke: boolean): Promise<BrowserScenarioResult> {
  if (!scenario.checkout) throw new Error("This scenario does not define a browser checkout flow.");
  const browser = await chromium.launch({
    headless: !headed && config.browser.headless,
    ...(process.env.SUBTEST_CHROMIUM_CHANNEL === "chrome" ? { channel: "chrome" as const } : {}),
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  let checkoutSessionId: string | undefined;
  page.setDefaultTimeout(config.browser.actionTimeoutMs);
  page.setDefaultNavigationTimeout(config.browser.navigationTimeoutMs);
  try {
    const appOrigin = new URL(config.baseUrl).origin;
    const fallbackPageUrl = new URL(scenario.checkout.path, config.baseUrl).toString();
    await context.route("**/*", async (route) => {
      const request = route.request();
      const requestUrl = new URL(request.url());
      if (requestUrl.hostname === "checkout.stripe.com") {
        checkoutSessionId ??= stripeCheckoutSession(request.url());
        if (!browserSmoke || !checkoutSessionId) {
          await route.abort();
          return;
        }
        await route.continue();
        return;
      }

      // Chromium may follow a 3xx Checkout redirect without invoking a route
      // for the redirected document. Inspect app navigations before Chromium
      // follows them so the default contract check never opens hosted Checkout.
      if (request.isNavigationRequest() && requestUrl.origin === appOrigin) {
        const response = await route.fetch({ maxRedirects: 0 });
        const location = response.headers()["location"];
        if (location && response.status() >= 300 && response.status() < 400) {
          const destination = new URL(location, request.url());
          if (destination.hostname === "checkout.stripe.com") {
            checkoutSessionId ??= stripeCheckoutSession(destination.href);
            if (!browserSmoke) {
              await route.fulfill({
                status: 200,
                contentType: "text/plain; charset=utf-8",
                body: "SubTest captured the Stripe Checkout Session.",
              });
              return;
            }
          }
        }
        await route.fulfill({ response });
        return;
      }

      await route.continue();
    });
    await page.goto(new URL(scenario.checkout.path, config.baseUrl).toString(), { waitUntil: "domcontentloaded" });
    for (const step of scenario.checkout.steps) {
      if (!browserSmoke && checkoutSessionId) continue;
      if ("navigate" in step) {
        await page.goto(new URL(step.navigate, config.baseUrl).toString(), { waitUntil: "domcontentloaded" });
      } else if ("click" in step) {
        await locate(page, step.click).click();
      } else if ("fill" in step) {
        await locate(page, step.fill).fill(step.fill.value.replace("${scenario.customer.email}", scenario.customer?.email ?? ""));
      } else if ("waitFor" in step) {
        if (step.waitFor.urlIncludes) await page.waitForURL((url) => url.href.includes(step.waitFor.urlIncludes!), { waitUntil: "domcontentloaded" });
        if (step.waitFor.text) await page.getByText(step.waitFor.text).waitFor({ state: "visible" });
      } else if ("expect" in step) {
        if (step.expect.urlIncludes && !page.url().includes(step.expect.urlIncludes)) throw new Error(`Expected URL to include ${step.expect.urlIncludes}; current URL was ${new URL(page.url()).origin}${new URL(page.url()).pathname}.`);
        if (step.expect.text && !(await page.getByText(step.expect.text).isVisible())) throw new Error(`Expected text "${step.expect.text}" to be visible.`);
      } else if ("stripeCheckout" in step) {
        if (!browserSmoke) continue;
        const payment = step.stripeCheckout.paymentMethod;
        if (payment) {
          const card = page.getByLabel(/card number/i).first();
          await card.fill(payment);
          const expiry = page.getByLabel(/expiration date|expiry/i).first();
          if (await expiry.count()) await expiry.fill("12 / 34");
          const cvc = page.getByLabel(/security code|cvc/i).first();
          if (await cvc.count()) await cvc.fill("123");
          const postal = page.getByLabel(/postal|zip/i).first();
          if (await postal.count()) await postal.fill("94107");
          const submit = page.getByRole("button", { name: /subscribe|pay|start trial/i }).last();
          await submit.click();
        }
      }
    }
    if (!checkoutSessionId) throw new Error("CHECKOUT_SESSION_NOT_FOUND: The app flow did not redirect to a Stripe test Checkout Session.");
    if (browserSmoke) {
      const expectedUrl = scenario.checkout.expect.urlIncludes;
      if (expectedUrl && !page.url().includes(expectedUrl)) throw new Error(`Checkout completed at an unexpected URL. Expected a URL containing "${expectedUrl}".`);
      return { checkoutSessionId, checkoutStatus: "completed", pageUrl: safePageUrl(page, fallbackPageUrl), title: await page.title() };
    }
    return { checkoutSessionId, checkoutStatus: "not_attempted", pageUrl: safePageUrl(page, fallbackPageUrl), title: await page.title(), warning: "Browser payment entry was skipped; the Checkout Session was inspected through the Stripe API." };
  } catch (error) {
    if (!checkoutSessionId) throw error;
    const visibleError = browserSmoke ? await visibleCheckoutError(page) : undefined;
    return {
      checkoutSessionId,
      checkoutStatus: browserSmoke ? "blocked" : "not_attempted",
      pageUrl: safePageUrl(page, new URL(scenario.checkout.path, config.baseUrl).toString()),
      title: await page.title().catch(() => ""),
      warning: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      ...(visibleError ? { visibleError } : {}),
    };
  } finally {
    await context.close();
    await browser.close();
  }
}
