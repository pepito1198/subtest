import type { Metadata } from "next";

export const metadata: Metadata = { title: "SubTest Checkout example", description: "A small Stripe Checkout target for SubTest." };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body style={{ fontFamily: "system-ui, sans-serif", maxWidth: 720, margin: "64px auto", padding: 24 }}>{children}</body></html>;
}
