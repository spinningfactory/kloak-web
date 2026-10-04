# Security Model

This page describes Kloak's trust chain, the threat model it is designed to address, and the known limitations of the system.

## Threat Model

Kloak is designed to protect Kubernetes secrets against the following threats:

### In-Scope Threats

**Application memory compromise** -- An attacker gains the ability to read arbitrary memory in an application container (e.g., via a heap dump, core dump, `/proc/<pid>/mem`, or memory-disclosure vulnerability). Without Kloak, the real secret values are in memory (from mounted secret volumes or environment variables). With Kloak, the application only ever sees `kl::` placeholders -- the real values are never loaded into the pod's memory.

**Container escape to application namespace** -- An attacker who escapes to the node filesystem within the application namespace cannot recover real secrets. The shadow secret files contain only `kl::` placeholders. Outside the API server/etcd (where the original Secret lives), the real values exist only in the controller's informer cache (in `kloak-system`) and in kernel-space BPF maps.

**Secret exfiltration via SSRF** -- An attacker exploits a server-side request forgery vulnerability to make the application send HTTP requests to an attacker-controlled server. Without host filtering, the TLS connection to the attacker's server would carry the real secret. With `getkloak.io/hosts` configured, Kloak's eBPF program checks the destination hostname before rewriting -- connections to unauthorized hosts receive the harmless `kl::` placeholder.

**Accidental secret leakage** -- Secrets accidentally logged, serialized to JSON, sent in error reports, or included in stack traces are harmless `kl::` placeholders. The real value is only present in the kernel-encrypted TLS stream to the intended destination.

### Out-of-Scope Threats

**Node-level compromise with root access** -- An attacker with root access on the worker node can read BPF maps (`bpftool map dump`), attach to the controller process, or modify eBPF programs. Kloak does not protect against a root-level node compromise. The controller itself requires root privileges, so the trust boundary is at the node level.

**Compromise of `kloak-system` namespace** -- An attacker who can create or modify resources in the `kloak-system` namespace can read real secrets (the controller caches all Secrets cluster-wide, and the controller and webhook share the `kloak-controller` ServiceAccount, which has cluster-wide Secret RBAC) or modify the webhook behavior. This namespace must be restricted to cluster administrators only.

**Kubernetes API access to secrets** -- An attacker with `get` or `list` permissions on Secrets in the application namespace can still read the original secret (not the shadow). Kloak does not replace Kubernetes RBAC -- it complements it by protecting secrets in the runtime layer.

**Non-TLS exfiltration** -- If an application sends secrets over plaintext HTTP, raw TCP, or UDP, Kloak cannot intercept or rewrite the data. Kloak operates on TLS write functions (`SSL_write`/`SSL_write_ex`, `crypto/tls.(*Conn).Write`). Network policies should be used to restrict non-TLS egress.

**Denial of service** -- An attacker who can crash the controller DaemonSet or delete the webhook deployment can stop Kloak from working. If the controller is down, all eBPF programs are detached and running pods send placeholders until it is back (fail closed; persisting programs across restarts is tracked in spinningfactory/kloak#107). If the webhook is down, creation of kloak-enabled pods and create/update of kloak-enabled Secrets is blocked (`failurePolicy: Fail`). Pods never fall back to mounting the original secret.

## Trust Chain

Kloak's security relies on a chain of trust with several links. Each link is described below along with what breaks if that link is compromised.

### 1. Kubernetes API Server

The API server is the root of trust. The SecretReconciler reads secrets via the API, and the webhook receives admission requests from it.

**If compromised:** An attacker could modify secrets, bypass the webhook, or inject pods without mutation. This is equivalent to cluster-level compromise.

### 2. Webhook Admission

The mutating webhook intercepts pod creation and rewrites secret volume references to point to shadow secrets. The API server verifies the webhook's TLS certificate via the `caBundle`.

**If bypassed:** Pods would mount original secrets instead of shadow secrets, so the application would have real secrets in memory. The controller also only attaches to pods carrying the `getkloak.io/enabled` annotation that the webhook adds.

### 3. Controller DaemonSet

The controller creates shadow secrets, joins each enabled Secret with its shadow and syncs the mappings to BPF maps, and attaches uprobes to containers and the tc patch program to their host-side veth peers.

**If compromised:** An attacker could read real secrets from the controller's informer cache, modify BPF maps to inject arbitrary values, or disable uprobe attachment.

### 4. eBPF Programs (Kernel)

The BPF programs are loaded by the controller and run in kernel context. They are verified by the kernel BPF verifier and cannot be modified by user-space processes without `CAP_BPF` + `CAP_SYS_ADMIN`.

**If tampered with:** An attacker could disable rewriting, redirect secrets to unauthorized hosts, or exfiltrate secrets. Requires root on the node.

### 5. DNS Resolution

Host filtering depends on the integrity of DNS responses. Kloak captures DNS responses via a kprobe on `udp_recvmsg` and validates the source IP against a whitelist of trusted DNS servers (auto-discovered from `kube-dns` or user-configured).

**If poisoned:** An attacker who can spoof DNS responses from a trusted server IP could trick Kloak into associating an attacker-controlled IP with an allowed hostname. The eBPF program would then rewrite secrets for connections to that IP.

**Mitigations:**
- Trusted DNS server whitelist limits which source IPs are accepted
- DNS entries include TTL enforcement -- expired entries are rejected (a TTL of 0 never expires)
- In-cluster DNS (CoreDNS/kube-dns) is typically not accessible to application pods for spoofing
- DNSSEC or encrypted DNS (DoH/DoT) at the cluster level further reduces risk

### 6. TLS Library Integrity

Kloak attaches uprobes to specific TLS library functions. If the application's TLS library is replaced or modified, uprobes may not attach correctly or may fire on different functions.

**If tampered with:** A modified TLS library could bypass the uprobe attachment point, causing secrets to not be rewritten. This is fail-secure -- the placeholder is sent instead of the real secret.

## Privileged Access Requirements

The controller DaemonSet requires elevated privileges:

| Capability | Purpose |
|---|---|
| `CAP_BPF` | Load eBPF programs and create BPF maps |
| `CAP_NET_ADMIN` | Attach the tc patch program to host-side veth peers (TCX) |
| `CAP_SYS_ADMIN` | Access `/proc/<pid>/` for uprobe attachment, kprobe/tracepoint attachment |
| `CAP_SYS_RESOURCE` | Increase BPF map memory limits |
| `hostPID: true` | Resolve container PIDs and access `/proc/<pid>/ns/net` and the root netns (`/proc/1/ns/net`) for tc attachment |
| `privileged: true` | Required for eBPF operations on most Kubernetes distributions |
| `runAsUser: 0`, AppArmor `Unconfined` | Run as root without AppArmor restrictions |
| hostPath mounts | `/sys/fs/cgroup`, `/sys/fs/bpf`, `/sys/kernel/btf` (read-only), and tracefs at `/sys/kernel/tracing` |

::: warning
The controller runs as a privileged DaemonSet. Restrict access to the `kloak-system` namespace with tight RBAC policies. Only cluster administrators should be able to modify resources in this namespace.
:::

## How the Pieces Fit Together

```
Kubernetes API (root of trust)
  │
  ├── Webhook (admission control)
  │     └── Rewrites secret volumes → shadow secrets
  │
  ├── SecretReconciler (control plane)
  │     └── Creates shadow secrets with kl:: placeholders
  │
  ├── Controller (per-node)
  │     ├── Joins Secret + shadow, syncs real values to BPF maps every 5s
  │     ├── Attaches uprobes to TLS write functions
  │     ├── Attaches tc patch program to host-side veth peers
  │     └── Discovers trusted DNS servers
  │
  └── eBPF Programs (kernel)
        ├── Uprobe: scan for placeholders, compute XOR delta
        ├── tcp_sendmsg kprobe: bridge patches to the connection
        ├── DNS kprobe: validate responses from trusted servers
        ├── Connect tracepoint: track fd → IP mappings
        └── tc (host-side veth): patch ciphertext, recompute GHASH tag
```

## Fail Modes

Kloak is designed to **fail secure** -- if any component fails, the application sends the harmless `kl::` placeholder instead of the real secret.

| Failure | Impact |
|---|---|
| Controller down | All eBPF programs are detached; running pods send placeholders until the controller is back. New shadow secrets are not created, and the webhook rejects pods referencing kloak-enabled secrets without a shadow (fail-closed). |
| Webhook down | Only affects kloak-enabled namespaces and pods (via selectors). Non-kloak workloads are unaffected. failurePolicy: Fail blocks kloak-enabled pod creation and create/update of kloak-enabled Secrets. |
| Shadow secret missing | Webhook rejects the pod to prevent real secrets from being mounted. Pod creation succeeds once the controller creates the shadow. |
| Uprobe attachment fails | Application sends the `kl::` placeholder to the remote server. Request fails at the API level (invalid credential). |
| H extraction fails | No patch is created; the application sends the placeholder (all runtimes). |
| Non-AES-GCM cipher (e.g. ChaCha20-Poly1305) | Not rewritten; placeholder sent. |
| DNS resolution missing | Host cannot be verified. eBPF program does not rewrite -- placeholder sent. |
| BPF map full | New entries rejected. Existing secrets continue working. New secrets send placeholder. |
| tc program not attached (e.g. kernel older than 6.6) | XOR delta computed but not applied. Ciphertext contains the placeholder. |

## Known Limitations

### Secret Size

The maximum secret value that can be rewritten is **128 bytes** (`SECRET_MAX_LEN`), and the minimum is **8 bytes**. The validating webhook rejects values outside this range. This limit exists to stay within eBPF program memory and verification constraints. It covers most API keys, tokens, and passwords, but not large certificates or multi-line secrets.

### Secrets Per TLS Write

The eBPF program can detect and rewrite up to **4 secrets per `SSL_write` call** (`XOR_MAX_MATCHES`). If a single TLS write buffer contains more than 4 `kl::` placeholders, only the first 4 are rewritten; the rest are sent unmodified. This limit exists to stay within eBPF program complexity and verification constraints.

### Hostname Length

Hostnames for host filtering are limited to **63 bytes** (`MAX_HOST_LEN` is 64 including the terminator). The validating webhook rejects longer hostnames; if the webhook is bypassed, the controller skips the secret, so it is never rewritten. This limit exists to keep BPF map entries within eBPF memory constraints. It covers the vast majority of real-world API endpoints.

### OpenSSL Version Coverage

The XOR-patch path requires version-specific struct offsets for extracting the GHASH key. Currently supported: **OpenSSL 3.0 -- 3.6** (3.0/3.1 use a 3-hop chain, 3.2+ a 4-hop chain). OpenSSL 4.0 offsets are tracked but not yet covered by nightly e2e. OpenSSL 1.1.x and older are not supported. See [Supported Runtimes](/guides/supported-runtimes) for details.

### Cipher Suites and Protocols

Only AES-128-GCM and AES-256-GCM cipher suites (TLS 1.2 and 1.3) are rewritten. ChaCha20-Poly1305 connections send the placeholder. Only IPv4 destinations are supported.

### Kernel Version

The tc patch program attaches via TCX, which requires **Linux 6.6+**. On older kernels uprobes may attach but nothing is rewritten.

### Same-Pod and hostNetwork Traffic

Loopback traffic is never patched, so same-pod destinations receive the placeholder. Interfaces with no veth peer (e.g. `hostNetwork` pods) are patched inside the pod netns, where a container with `CAP_NET_RAW` could capture the patched ciphertext and decrypt it with its own TLS session keys. Drop `NET_RAW` for such workloads.
