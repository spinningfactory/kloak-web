# Release Notes: v0.1.1

Released April 22, 2026. [Full changelog on GitHub](https://github.com/spinningfactory/kloak/releases/tag/v0.1.1)

v0.1.1 validates kloak-enabled Secrets when they are created or updated, so problems show up at `kubectl apply` instead of at runtime.

## Highlights

### Validating webhook for Secrets

A new `ValidatingWebhookConfiguration` (`kloak-validating-webhook`, `failurePolicy: Fail`) checks Secrets labeled `getkloak.io/enabled=true` on create and update. It rejects a Secret when:

- the `getkloak.io/hosts` label is not a lowercase DNS name of at most 63 bytes
- the `getkloak.io/port` label is not a valid port
- the Secret has no data
- a value is shorter than 8 or longer than 128 bytes

Before, a value shorter than 8 bytes only showed up as a "shadow secret not found" error on the pod, and a value longer than 128 bytes was truncated, so the rewrite was wrong. A host too long for the eBPF filter is now skipped by the controller instead of disabling host filtering for that secret. The webhook reuses the certificate and CA bundle of the mutating webhook. ([#152](https://github.com/spinningfactory/kloak/pull/152))

See [Labels and Annotations](/reference/labels-annotations#validation).

## Fixes

- Go TLS struct offsets are tracked per executable instead of per container, so a container that runs several Go binaries gets the right offsets for each. ([#157](https://github.com/spinningfactory/kloak/pull/157))

## Upgrade Notes

- Existing Secrets that break the rules above are rejected on their next update. Check them before upgrading.

## Known Issues

These are fixed in later releases. See [Supported Runtimes](/guides/supported-runtimes#known-issues).

- `getkloak.io/hosts` and `getkloak.io/port` are labels, so a secret can't be restricted to an IP address or a UDP port (v0.1.2).
- Guaranteed QoS pods on nodes with the `cgroupfs` driver send placeholders unchanged (v0.1.2).
- OpenSSL 3.0 and 3.1 are not rewritten, nor OpenSSL 3.1+ on x86 CPUs with AVX-512 and VAES (v0.2.0).
- Rewrites inside HTTP/2 headers are usually invalid (v0.2.0).
- Only `secret` volumes are rewritten: a pod that reads a protected secret through an environment variable gets the real value (v0.2.0).
- Patching happens inside the pod's network namespace, and needs Linux 6.6+ (v0.2.0).

## Supported Versions

| Component | Versions |
|---|---|
| Linux kernel | 6.6+ |
| Kubernetes | 1.28+ |
| OpenSSL | 3.2 -- 3.5 (3.0 and 3.1 have offsets but a known issue) |
| Go `crypto/tls` | 1.25 -- 1.26 |

See [Supported Runtimes](/guides/supported-runtimes) and [Requirements](/reference/requirements).
