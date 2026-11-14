import { chromium, type Page, type Locator } from "playwright";
import type { Scenario, SubtestConfig } from "@subtest/core";

type Selector = { role?: string | undefined; name?: string | undefined; label?: string | undefined; text?: string | undefined; css?: string | undefined };

function locate(page: Page, selector: Selector): Locator {
  if (selector.role) return page.getByRole(selector.role as Parameters<Page["getByRole"]>[0], selector.name ? { name: selector.name } : undefined);
  if (selector.label) return page.getByLabel(selector.label);
  if (selector.text) return page.getByText(selector.text, { exact: true });
  if (selector.css) return page.locator(selector.css);
  throw new Error("A browser action needs role/name, label, text, or css selector.");
}

export async function runBrowserScenario(config: SubtestConfig, scenario: Scenario, headed: boolean): Promise<{ url: string; title: string }> {
  if (!scenario.checkout) throw new Error("This scenario does not define a browser checkout flow.");
  const browser = await chromium.launch({ headless: !headed && config.browser.headless });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(config.browser.actionTimeoutMs);
  page.setDefaultNavigationTimeout(config.browser.navigationTimeoutMs);
  try {
    await page.goto(new URL(scenario.checkout.path, config.baseUrl).toString(), { waitUntil: "domcontentloaded" });
    for (const step of scenario.checkout.steps) {
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
    const expectedUrl = scenario.checkout.expect.urlIncludes;
    if (expectedUrl && !page.url().includes(expectedUrl)) throw new Error(`Checkout completed at an unexpected URL. Expected a URL containing "${expectedUrl}".`);
    return { url: new URL(page.url()).origin + new URL(page.url()).pathname, title: await page.title() };
  } finally {
    await context.close();
    await browser.close();
  }
}
