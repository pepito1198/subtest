import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "@subtest/core";
import { runBrowserScenario } from "./index.js";

let server: Server | undefined;
let baseUrl = "";

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  server = undefined;
});

describe("Checkout contract browser flow", () => {
  it("captures the test Session and stops before opening hosted Checkout by default", async () => {
    server = createServer((request, response) => {
      if (request.url === "/") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end('<a href="/api/checkout">Choose monthly</a>');
        return;
      }
      if (request.url === "/api/checkout") {
        response.writeHead(303, { location: "https://checkout.stripe.com/c/pay/cs_test_smokesession123" });
        response.end();
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Could not bind browser test server.");
    baseUrl = `http://127.0.0.1:${address.port}`;

    const config = ConfigSchema.parse({
      version: 1,
      project: "browser-contract-test",
      baseUrl,
      scenarios: [{
        id: "monthly",
        name: "Monthly Checkout",
        customer: { email: "qa@example.invalid" },
        product: { priceId: "price_test_monthly" },
        checkout: { path: "/", steps: [{ click: { role: "link", name: "Choose monthly" } }] },
      }],
    });

    const result = await runBrowserScenario(config, config.scenarios[0]!, false, false);
    expect(result).toMatchObject({
      checkoutSessionId: "cs_test_smokesession123",
      checkoutStatus: "not_attempted",
    });
  }, 30_000);
});
