# Host Filtering

Host filtering is Kloak's mechanism for restricting which TLS destinations can receive a secret's real value. Even if an attacker gains code execution inside your container, they cannot exfiltrate secrets to unauthorized hosts -- the eBPF program will refuse to perform the rewrite.

## Why Host Filtering Matters

Without host filtering, any outbound TLS connection from a Kloak-enabled pod could receive the real secret value. Consider this scenario:

1. Your application sends an API key to `api.stripe.com` in the `Authorization` header
2. An attacker exploits an SSRF vulnerability and makes your app send the same header to `evil.attacker.com`
3. Without host filtering, the eBPF program rewrites the `kl::` placeholder for **both** destinations

With host filtering enabled, Kloak checks which host the TLS connection is for. If it is not the allowed host, the placeholder is **not** rewritten -- the remote server receives the harmless `kl::…` placeholder instead of your real secret.

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

The value accepts one lowercase DNS name (RFC 1123, max 63 bytes), one IPv4 or IPv6 address, or `*`. Use the name your application connects to: it must also be the name the application sends as its TLS SNI (see [SNI check](#sni-check)). An IP address is matched against the address the connection was made to, with no DNS involved.

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

Kloak decides which host a connection is for with **virtual IPs**. It does not depend on the TLS library, the protocol (HTTP/1.1, HTTP/2, or raw TLS), or which addresses a host shares with others, such as a CDN or a shared ingress.

### Virtual IPs

1. **A virtual IP per host** — The controller gives every hostname in a `getkloak.io/hosts` annotation a stable virtual IP from each range of `controller.ebpf.virtualIPRange`: an IPv4 address from `198.18.0.0/15` and an IPv6 address from `2001:2::/48` by default. They are kept in BPF maps pinned on the node, so a controller restart keeps them.

2. **DNS rewrite** — In the network namespace of each pod that references a secret restricted to the host, a tc program rewrites DNS answers from trusted resolvers: the host's A records become its virtual IPv4, and its AAAA records its virtual IPv6. It records the real addresses, each for the TTL of its record. Other pods get the real answers. Trusted resolvers are kube-dns (its ClusterIPs and the addresses of its endpoints, kept current by the controller) and any servers in `controller.dns.trustedServers`.

3. **Connect redirect** — `cgroup/connect4` and `cgroup/connect6` programs on the pods' cgroups send a connection to a virtual IP to one of the host's real addresses, and record the host the socket is for. The application still sees the virtual IP as its peer (`getpeername`). A connection to a virtual IP whose host has no known address is refused.

4. **Secret filtering** — When the encrypted record is sent, the `tcp_sendmsg` kprobe compares the host the socket is for with the secret's allowed host, and the address and port the socket connected to with the secret's IP or port restriction. Match → the patch goes on to the tc program. Mismatch → the patch is dropped and the placeholder is sent as-is.

5. **SNI check** — A secret restricted to a hostname is only rewritten on a connection whose TLS SNI is that host (see below).

A connection that did not go through a virtual IP gets no host-restricted secret. That covers an application that connects to a hardcoded address, resolves names over DNS-over-HTTPS, or queries a resolver that is not trusted.

::: tip
With NRI (containerd 2.0+ or CRI-O 1.30+), the DNS rewrite is in place before any container of the pod starts. Without NRI, a lookup made in the first moments of the pod can get the real addresses; a connection made with them gets no host-restricted secret until the application resolves the name again. See [Container Runtime Hook (NRI)](/getting-started/configuration#container-runtime-hook-nri).
:::

### SNI Check

The host the socket is for is not enough on its own. CDNs and cloud load balancers serve many customers on the same IPs and route each TLS connection by its SNI, so a compromised app could connect to the virtual IP of `api.stripe.com` while naming another tenant's domain in its ClientHello.

A second `tcp_sendmsg` kprobe records the SNI of each connection's first ClientHello, and a secret restricted to a hostname is only rewritten on a connection whose SNI is that host:

- The comparison is exact and case-insensitive. A client that connects to a short in-cluster name (`my-svc`) does not match an annotation with the full name (`my-svc.ns.svc.cluster.local`), so use the same name in both.
- Connections without SNI, with an encrypted ClientHello (ECH), or whose ClientHello could not be read are refused.
- Secrets restricted to an IP address, or to `*`, are not SNI-checked.

Refusals are logged by the controller as an `SNI check violation`. To find clients whose SNI differs from the annotation before enforcing, set `controller.ebpf.sniCheck: audit`: the rewrite goes ahead and each violation is still logged.

### Host Resolution Flow

| Runtime | TLS Hook | Host Resolution Method |
|---|---|---|
| Python (OpenSSL) | `SSL_write` uprobe | Virtual IP + SNI |
| Node.js (bundled OpenSSL) | `SSL_write` uprobe | Virtual IP + SNI |
| C/C++ (BoringSSL) | `SSL_write` uprobe | Virtual IP + SNI |
| Bun (BoringSSL) | `SSL_write` uprobe (file offset) | Virtual IP + SNI |
| Go (crypto/tls) | `crypto/tls.(*Conn).Write` uprobe | Virtual IP + SNI |
| Rust, Ruby, PHP, curl | `SSL_write` / `SSL_write_ex` uprobe | Virtual IP + SNI |

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

Host filtering works for non-HTTP TLS protocols too. The application resolves the hostname, gets its virtual IP, and connects to it; no HTTP headers are involved:

```python
import ssl
import socket

ctx = ssl.create_default_context()
# "api.stripe.com" resolves to its virtual IP in this pod, and the connect
# is redirected to one of Stripe's addresses. server_hostname sets the SNI.
with socket.create_connection(("api.stripe.com", 443)) as sock:
    with ctx.wrap_socket(sock, server_hostname="api.stripe.com") as tls:
        tls.sendall(b"secret data containing a kl:: placeholder here")
```

## Verifying Host Filtering

### Check the Virtual IP

In a pod that references a secret restricted to a host, the host resolves to its virtual IP:

```bash
kubectl exec -n payments deploy/my-app -- getent hosts api.stripe.com
```

```
198.18.0.4      api.stripe.com
```

If you see the host's real addresses instead, the pod does not reference a secret restricted to that host, it queried a resolver that is not trusted, or it started before the DNS rewrite was attached (restart it).

### Check Controller Logs

Refused rewrites are logged as warnings:

```bash
kubectl logs -n kloak-system -l app.kubernetes.io/component=controller | grep -E "SNI check violation|secret binding violation"
```

With trace-level logging enabled (`--set log.level=trace`), the controller also logs each secret it syncs into the eBPF map, including the host restriction:

```bash
kubectl logs -n kloak-system -l app.kubernetes.io/component=controller | grep "synced secret into eBPF map"
```

Each line carries the fields `owner`, `key`, `hostLen`, `port`, and `protocol`.

A `hostLen` greater than 0 confirms a hostname filter is active. A `hostLen` of 0 means there is no hostname filter (either wildcard or an IP filter).

### Test with httpbin

The chart's optional demo sends two secrets to `https://httpbin.org/headers`: one allowed for `httpbin.org`, one allowed only for `example.com`. Enable it and check the responses it logs:

```bash
helm upgrade kloak kloak/kloak -n kloak-system --reuse-values --set demo.enabled=true
kubectl logs -n kloak-demo -l app.kubernetes.io/component=demo -c demo
```

You should see the allowed secret replaced with the real value and the blocked secret still showing the `kl::` placeholder.

## Security Considerations

- **Host attribution comes from the connection.** A secret restricted to a hostname is only rewritten on a socket that connected to that host's virtual IP and whose SNI names the host. Connections to hardcoded addresses get no host-restricted secret.
- **The real addresses come from trusted DNS answers.** Only answers from kube-dns and `controller.dns.trustedServers` are rewritten. A compromised or spoofed trusted resolver could still point a virtual IP at an attacker's address.
- **Addresses expire with their DNS TTL.** A connection to a virtual IP goes to one of the host's unexpired addresses, or, when all have expired, to the one that expired last, as a resolver serving a stale answer would.
- **Hostnames are limited to 63 bytes.** Longer values are rejected by the validating webhook; if the webhook is bypassed, the secret is never rewritten. This covers the vast majority of real-world API endpoints.
- **Wildcard matching is not supported.** You must specify exact hostnames. `*.stripe.com` will not work -- use `api.stripe.com` explicitly.
- **Host filtering is enforced in-kernel by eBPF.** Application code cannot bypass it, even with arbitrary code execution in the container. Exception: pods without a veth peer (e.g. `hostNetwork` pods) are patched inside the pod network namespace, where a container with `CAP_NET_RAW` could capture the patched ciphertext -- drop `NET_RAW` for such workloads.
- **The controller must be running.** While it is down, the data plane is detached: connections to virtual IPs fail and no placeholder is rewritten.
