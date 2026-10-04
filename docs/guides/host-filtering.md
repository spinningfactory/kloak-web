# Host Filtering

Host filtering is Kloak's mechanism for restricting which TLS destinations can receive a secret's real value. Even if an attacker gains code execution inside your container, they cannot exfiltrate secrets to unauthorized hosts -- the eBPF program will refuse to perform the rewrite.

## Why Host Filtering Matters

Without host filtering, any outbound TLS connection from a Kloak-enabled pod could receive the real secret value. Consider this scenario:

1. Your application sends an API key to `api.stripe.com` in the `Authorization` header
2. An attacker exploits an SSRF vulnerability and makes your app send the same header to `evil.attacker.com`
3. Without host filtering, the eBPF program rewrites the `kl::` placeholder for **both** destinations

With host filtering enabled, the eBPF program checks the TLS connection's destination hostname. If it does not match the allowed host, the placeholder is **not** rewritten -- the remote server receives the harmless `kl::…` placeholder instead of your real secret.

::: danger
Without host filtering, Kloak protects secrets from being visible in application memory, but does not prevent network-level exfiltration. Always configure `getkloak.io/hosts` for production secrets.
:::

## Configuring Host Filtering

Add the `getkloak.io/hosts` **annotation** to your Secret with a single allowed hostname or IP. The `getkloak.io/enabled` key stays a label:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: stripe-api-key
  labels:
    getkloak.io/enabled: "true"
  annotations:
    getkloak.io/hosts: "api.stripe.com"
type: Opaque
data:
  api-key: c2stbGl2ZS1rZXktMTIzNDU2Nzg5MA==  # sk-live-key-1234567890
```

Or using `kubectl`:

```bash
kubectl create secret generic stripe-api-key \
    --from-literal=api-key="sk-live-key-1234567890" \
    -n payments --dry-run=client -o yaml | \
    kubectl label -f - getkloak.io/enabled="true" --local -o yaml | \
    kubectl annotate -f - getkloak.io/hosts="api.stripe.com" --local -o yaml | \
    kubectl apply -f -
```

::: warning
`getkloak.io/hosts` and `getkloak.io/port` must be **annotations**. Set as labels, they are rejected by the validating webhook ("must be set as an annotation, not a label"); if the webhook is not installed, the secret is skipped and never rewritten.
:::

The value accepts one lowercase DNS name (RFC 1123, max 63 bytes), one IPv4 or IPv6 address, or `*`. An IP address is matched against the connection's destination IP directly, without DNS verification.

### Multiple Allowed Hosts

::: warning
Multiple hosts per secret are **not supported yet**. `getkloak.io/hosts` accepts a
single hostname, a single IP, or `*` (any). A comma-separated value is **rejected**
by the validating webhook; if the webhook is not installed, the whole string is
treated as one (invalid) hostname that never matches, so the secret is never
rewritten. To restrict a secret to more than one destination today, create a
separate secret per host. Multi-host support is tracked in
[spinningfactory/kloak#102](https://github.com/spinningfactory/kloak/issues/102).

To filter by port instead of (or in addition to) host, use the separate
`getkloak.io/port` annotation (`PORT` or `PORT/PROTO` with `tcp` or `udp`,
default `tcp`; e.g. `"443"` or `"443/tcp"`) — a port cannot be
appended to the hostname.
:::

### No Host Filter (Wildcard)

If the `getkloak.io/hosts` annotation is omitted, empty, or set to `*`, the secret is allowed for **all** hosts:

```yaml
metadata:
  labels:
    getkloak.io/enabled: "true"
  # No getkloak.io/hosts annotation = rewrite for any destination
```

## How Host Resolution Works

Kloak uses **DNS-verified host filtering** — a language-agnostic approach that works identically for all supported TLS runtimes (Go, Python, Node.js, BoringSSL, etc.) without depending on SNI or HTTP headers.

### DNS-Verified Trust Chain

The eBPF program builds a chain of trust from DNS resolution to TLS write:

1. **DNS Capture** — A kprobe on the kernel's `udp_recvmsg` function intercepts DNS responses on the node. Only responses from **trusted DNS servers** are accepted: the kube-dns ClusterIP (auto-discovered) plus any servers set in `controller.dns.trustedServers` (the `--trusted-dns-servers` flag). For hostnames listed in `getkloak.io/hosts` annotations (the `watched_hosts` set), the resolved A/AAAA record IPs are stored in `dns_ip_map` with their TTL.

2. **Connection Tracking** — Tracepoints on `sys_enter_connect` and `sys_exit_connect` record every connection's file descriptor → destination IP and port in `conn_ip_map`. If the destination IP exists in `dns_ip_map`, the fd is recorded in `last_verified_fd` for that process.

3. **Host Resolution at TLS Write Time** — When the TLS write function is called, `resolve_host()` finds the connection's fd (for OpenSSL/BoringSSL, read from the SSL object's write BIO and cached per SSL object; otherwise from `last_verified_fd`), then maps fd → `conn_ip_map` → `dns_ip_map` to get the verified hostname.

4. **Secret Filtering** — The resolved hostname is compared exactly against the secret's allowed host (and the destination IP and port against any IP or port filter). Match → secret is rewritten. Mismatch → placeholder sent as-is.

5. **TTL Enforcement** — DNS entries include a TTL from the original DNS response. Expired entries are skipped on lookup, forcing re-verification through fresh DNS responses.

6. **Connection Cleanup** — A tracepoint on `sys_enter_close` removes `conn_ip_map` entries when file descriptors are closed, preventing stale mappings from being used after fd reuse.

::: tip
This approach is **language-agnostic** — it works the same way for Go, Python, Node.js, and any OpenSSL/BoringSSL-based runtime. No SNI capture or HTTP header parsing is needed.
:::

### Host Resolution Flow

| Runtime | TLS Hook | Host Resolution Method |
|---|---|---|
| Python (OpenSSL) | `SSL_write` uprobe | DNS-verified via `udp_recvmsg` kprobe |
| Node.js (bundled OpenSSL) | `SSL_write` uprobe | DNS-verified via `udp_recvmsg` kprobe |
| C/C++ (BoringSSL) | `SSL_write` uprobe | DNS-verified via `udp_recvmsg` kprobe |
| Bun (BoringSSL) | `SSL_write` uprobe (file offset) | DNS-verified via `udp_recvmsg` kprobe |
| Go (crypto/tls) | `crypto/tls.(*Conn).Write` uprobe | DNS-verified via `udp_recvmsg` kprobe |
| Rust, Ruby, PHP, curl | `SSL_write` / `SSL_write_ex` uprobe | DNS-verified via `udp_recvmsg` kprobe |

## Practical Examples

### Example 1: Stripe API Key (Single Host)

Only allow the secret to be sent to Stripe's API:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: stripe-key
  labels:
    getkloak.io/enabled: "true"
  annotations:
    getkloak.io/hosts: "api.stripe.com"
type: Opaque
data:
  key: c2stbGl2ZS1rZXktMTIzNDU2Nzg5MA==  # sk-live-key-1234567890
```

**Result:**
- Request to `https://api.stripe.com/v1/charges` -- secret is rewritten with real value
- Request to `https://evil.example.com/steal` -- secret remains as the `kl::…` placeholder

### Example 2: Two Secrets, Different Hosts

A common pattern: one secret for an allowed API, another restricted to a different host:

```bash
# Secret allowed for httpbin.org
kubectl create secret generic secret-allowed \
    --from-literal=api-key="sk-live-key-1234567890" \
    -n demo --dry-run=client -o yaml | \
    kubectl label -f - getkloak.io/enabled="true" --local -o yaml | \
    kubectl annotate -f - getkloak.io/hosts="httpbin.org" --local -o yaml | \
    kubectl apply -f -

# Secret only allowed for example.com
kubectl create secret generic secret-blocked \
    --from-literal=api-key="sk-live-REAL-SECRET-KEY-12345" \
    -n demo --dry-run=client -o yaml | \
    kubectl label -f - getkloak.io/enabled="true" --local -o yaml | \
    kubectl annotate -f - getkloak.io/hosts="example.com" --local -o yaml | \
    kubectl apply -f -
```

When the application sends both secrets to `httpbin.org`:

```
X-Secret-Allowed: sk-live-key-1234567890          # Replaced -- host matches
X-Secret-Blocked: kl::5Gyh7ae*XwH2f2WZoZ351e3sk   # NOT replaced -- host mismatch
```

### Example 3: Raw TLS Filtering (Non-HTTP)

Host filtering works even for non-HTTP TLS protocols. The DNS resolution of the hostname is what enables host verification — no HTTP headers or SNI capture required:

```python
import ssl
import socket

ctx = ssl.create_default_context()
# DNS resolution of "api.stripe.com" is captured by the kprobe
# and stored in dns_ip_map for host verification
with socket.create_connection(("api.stripe.com", 443)) as sock:
    with ctx.wrap_socket(sock, server_hostname="api.stripe.com") as tls:
        tls.sendall(b"secret data containing a kl:: placeholder here")
```

## Verifying Host Filtering

### Check Controller Logs

With trace-level logging enabled (`--set log.level=trace`), the controller logs each secret it syncs into the eBPF map, including the host restriction:

```bash
kubectl logs -n kloak-system -l app.kubernetes.io/component=controller | grep "synced secret into eBPF map"
```

Each line carries the fields `owner`, `key`, `hostLen`, `port`, and `protocol`.

A `hostLen` greater than 0 confirms a hostname filter is active. A `hostLen` of 0 means there is no hostname filter (either wildcard or an IP filter).

### Test with httpbin

Deploy the demo application and check the response:

```bash
kubectl logs -l app=demo-python -n kloak-demo -c demo-app | grep -A5 "headers"
```

You should see the allowed secret replaced with the real value and the blocked secret still showing the `kl::` placeholder.

## Security Considerations

- **Host verification is DNS-based.** The trust chain depends on the integrity of DNS responses. Only responses from trusted DNS servers (kube-dns, auto-discovered, plus `controller.dns.trustedServers`) are accepted, but a compromised or spoofed trusted resolver could still mislead the host filter.
- **DNS entries have TTL enforcement.** Expired entries are skipped, forcing re-verification through fresh DNS responses. This limits the window for stale IP → hostname mappings.
- **Hostnames are limited to 63 bytes.** Longer values are rejected by the validating webhook; if the webhook is bypassed, the secret is never rewritten. This covers the vast majority of real-world API endpoints.
- **Wildcard matching is not supported.** You must specify exact hostnames. `*.stripe.com` will not work -- use `api.stripe.com` explicitly.
- **Host filtering is enforced in-kernel by eBPF.** Application code cannot bypass it, even with arbitrary code execution in the container. Exception: pods without a veth peer (e.g. `hostNetwork` pods) are patched inside the pod network namespace, where a container with `CAP_NET_RAW` could capture the patched ciphertext -- drop `NET_RAW` for such workloads.
- **DNS and connection tracking are global** on the node. All DNS responses and TCP connections are monitored (DNS is filtered by trusted servers and `watched_hosts`). This is necessary for containerized environments where DNS proxies may handle resolution in a different process context.
