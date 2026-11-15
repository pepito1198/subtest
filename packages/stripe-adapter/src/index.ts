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
  async checkoutSessionState(sessionId: string): Promise<{ id: string; livemode: boolean; mode: string | null; status: string | null; paymentStatus: string | null; customerId?: string; subscriptionId?: string; priceIds: string[]; paymentIntent?: { id: string; status: string; errorCode?: string; declineCode?: string; errorMessage?: string; errorParam?: string } }> {
    const session = await this.client.checkout.sessions.retrieve(sessionId, { expand: ["customer", "subscription", "payment_intent"] });
    if (session.livemode) throw new Error("STRIPE_LIVE_OBJECT: Checkout Session " + session.id + " is a live-mode object.");
    const priceIds: string[] = [];
    let startingAfter: string | undefined;
    while (true) {
      const page = await this.client.checkout.sessions.listLineItems(session.id, {
        limit: 100,
        expand: ["data.price"],
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      for (const item of page.data) {
        if (typeof item.price === "string") priceIds.push(item.price);
        else if (item.price) priceIds.push(item.price.id);
      }
      if (!page.has_more || page.data.length === 0) break;
      startingAfter = page.data[page.data.length - 1]!.id;
    }
    const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
    const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
    const paymentIntent = typeof session.payment_intent === "string"
      ? await this.client.paymentIntents.retrieve(session.payment_intent)
      : session.payment_intent;
    const lastError = paymentIntent?.last_payment_error;
    return {
      id: session.id,
      livemode: session.livemode,
      mode: session.mode,
      status: session.status,
      paymentStatus: session.payment_status,
      ...(customerId ? { customerId } : {}),
      ...(subscriptionId ? { subscriptionId } : {}),
      priceIds,
      ...(paymentIntent ? { paymentIntent: {
        id: paymentIntent.id,
        status: paymentIntent.status,
        ...(lastError?.code ? { errorCode: lastError.code } : {}),
        ...(lastError?.decline_code ? { declineCode: lastError.decline_code } : {}),
        ...(lastError?.message ? { errorMessage: lastError.message } : {}),
        ...(lastError?.param ? { errorParam: lastError.param } : {}),
      } } : {}),
    };
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
  async subscriptionState(customerId: string, priceId: string, expectedSubscriptionId?: string): Promise<{ subscriptionId?: string; status?: string; interval?: string; invoices: number; latestInvoiceStatus?: string }> {
    const subscriptions = await this.client.subscriptions.list({ customer: customerId, limit: 100, status: "all", expand: ["data.items.data.price"] });
    const subscription = subscriptions.data.find((candidate) => (!expectedSubscriptionId || candidate.id === expectedSubscriptionId) && candidate.items.data.some((item) => {
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
