import Stripe from "stripe";

export class StripeAdapter {
  readonly client: Stripe;
  constructor(secretKey: string) {
    if (!secretKey.startsWith("sk_test_")) throw new Error("STRIPE_KEY_NOT_TEST: SubTest accepts only Stripe test keys.");
    this.client = new Stripe(secretKey, { maxNetworkRetries: 2, timeout: 20_000 });
  }
  async preflight(): Promise<{ accountId: string; apiVersion: string }> {
    const account = await this.client.accounts.retrieve(null);
    const balance = await this.client.balance.retrieve();
    if (balance.livemode) throw new Error("STRIPE_LIVE_MODE: Stripe reports live-mode data for this key.");
    return { accountId: account.id, apiVersion: Stripe.API_VERSION };
  }
  async validatePrice(priceId: string): Promise<{ id: string; active: boolean; interval: string | null }> {
    const price = await this.client.prices.retrieve(priceId);
    if (price.livemode) throw new Error("STRIPE_LIVE_OBJECT: " + priceId + " is a live-mode object.");
    if (!price.active) throw new Error("STRIPE_PRICE_INACTIVE: " + priceId + " is inactive.");
    if (!price.recurring) throw new Error("STRIPE_PRICE_NOT_RECURRING: " + priceId + " is not recurring.");
    return { id: price.id, active: price.active, interval: price.recurring.interval };
  }
  async createClock(name: string, idempotencyKey: string): Promise<string> {
    const clock = await this.client.testHelpers.testClocks.create(
      { frozen_time: Math.floor(Date.now() / 1000), name },
      { idempotencyKey },
    );
    return clock.id;
  }
  async createCustomer(email: string, idempotencyKey: string, clockId?: string): Promise<string> {
    const customer = await this.client.customers.create({
      email, ...(clockId ? { test_clock: clockId } : {}), metadata: { subtest_managed: "true" },
    }, { idempotencyKey });
    return customer.id;
  }
  async createSubscription(customerId: string, priceId: string, idempotencyKey: string): Promise<string> {
    const paymentMethod = await this.client.paymentMethods.attach("pm_card_visa", { customer: customerId }, { idempotencyKey: idempotencyKey + "-payment-method" });
    await this.client.customers.update(customerId, { invoice_settings: { default_payment_method: paymentMethod.id } });
    const subscription = await this.client.subscriptions.create({
      customer: customerId, items: [{ price: priceId }], metadata: { subtest_managed: "true" },
      expand: ["latest_invoice"],
    }, { idempotencyKey });
    return subscription.id;
  }
  async advanceClock(clockId: string, seconds: number, timeoutMs: number): Promise<void> {
    const clock = await this.client.testHelpers.testClocks.retrieve(clockId);
    if (clock.status !== "ready") throw new Error("CLOCK_NOT_READY: " + clockId + " is " + clock.status + ".");
    await this.client.testHelpers.testClocks.advance(clockId, { frozen_time: clock.frozen_time + seconds });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const current = await this.client.testHelpers.testClocks.retrieve(clockId);
      if (current.status === "ready") return;
      if (current.status === "internal_failure") throw new Error("CLOCK_FAILED: Stripe failed to advance " + clockId + ".");
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error("CLOCK_TIMEOUT: Stripe clock " + clockId + " did not become ready within " + timeoutMs + "ms.");
  }
  async customerByEmail(email: string, createdAfter: number): Promise<string | undefined> {
    const result = await this.client.customers.list({ email, limit: 100 });
    const customer = result.data.find((candidate) => candidate.created >= createdAfter && !("deleted" in candidate && candidate.deleted));
    return customer?.id;
  }
  async subscriptionState(customerId: string, priceId: string): Promise<{ subscriptionId?: string; status?: string; interval?: string; invoices: number; latestInvoiceStatus?: string }> {
    const subscriptions = await this.client.subscriptions.list({ customer: customerId, limit: 100, status: "all", expand: ["data.items.data.price"] });
    const subscription = subscriptions.data.find((candidate) => candidate.items.data.some((item) => {
      const price = typeof item.price === "string" ? undefined : item.price;
      return price?.id === priceId;
    }));
    const invoices = await this.client.invoices.list({ customer: customerId, limit: 100 });
    const relevant = subscription ? invoices.data.filter((invoice) => {
      const relation = invoice.parent?.subscription_details?.subscription;
      return (typeof relation === "string" ? relation : relation?.id) === subscription.id;
    }) : [];
    const firstPrice = subscription?.items.data[0]?.price;
    const recurring = firstPrice && typeof firstPrice !== "string" ? firstPrice.recurring : null;
    return {
      ...(subscription ? { subscriptionId: subscription.id } : {}),
      ...(subscription ? { status: subscription.status } : {}),
      ...(recurring ? { interval: recurring.interval } : {}),
      invoices: relevant.length,
      ...(relevant[0]?.status ? { latestInvoiceStatus: relevant[0].status } : {}),
    };
  }
  async eventsForCustomer(customerId: string, since: number): Promise<Array<{ id: string; type: string; created: number }>> {
    const events = await this.client.events.list({ created: { gte: since }, limit: 100 });
    return events.data.filter((event) => {
      const object = event.data.object as { customer?: string; id?: string };
      return object.customer === customerId || object.id === customerId;
    }).map(({ id, type, created }) => ({ id, type, created }));
  }
}
