# Security policy

SubTest is intended for local development and CI using Stripe test mode. Do not use it with production credentials or production customer data. Report suspected vulnerabilities privately to the repository maintainers using the security contact configured on the eventual public repository; do not file exploit details in a public issue.

Never commit API keys, webhook signing secrets, local databases, browser traces, screenshots containing sensitive data, or `.env` files. The project has no hosted service and should make no telemetry requests.
