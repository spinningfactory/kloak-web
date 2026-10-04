# System Requirements

Kloak uses eBPF uprobes, kprobes, and tc programs that require specific kernel and Kubernetes versions. This page details the minimum requirements and tested configurations.

## Kernel Requirements

### Minimum: Linux 6.6+

Kloak requires Linux kernel **6.6 or later**. There are two hard dependencies:

- The `bpf_loop` helper (kernel 5.17+), used to scan the TLS write buffer for `kl::` placeholders.
- **TCX** tc links (kernel 6.6+). The program that patches ciphertext is attached with TCX on the host-side veth peer of each pod's egress interface. There is no fallback to legacy tc attachment.

::: danger
On kernels older than 6.6, the tc program cannot be attached. Uprobes may still attach, but the controller logs `Failed to attach tc egress ... secrets will not be rewritten` and applications send the placeholder. On kernels older than 5.17, the eBPF programs fail to load.
:::

### Required Kernel Features

The following kernel configuration options must be enabled (they are enabled by default on major distributions):

| Config Option | Purpose |
|---|---|
| `CONFIG_BPF` | Base BPF support |
| `CONFIG_BPF_SYSCALL` | BPF system call |
| `CONFIG_BPF_JIT` | JIT compilation for BPF programs |
| `CONFIG_UPROBES` | User-space probes (uprobes/uretprobes on TLS libraries) |
| `CONFIG_KPROBES` | Kernel probes (`udp_recvmsg` for DNS capture, `tcp_sendmsg` for patch handoff) |
| `CONFIG_TRACEPOINTS` | Tracepoints (connect/close, process exec/exit tracking) |
| `CONFIG_BPF_EVENTS` | BPF-based event tracing |
| `CONFIG_NET_XGRESS` | TCX tc attachment (ciphertext patching) |
| `CONFIG_DEBUG_INFO_BTF` | BTF type information for CO-RE |

Verify BTF availability on a node:

```bash
ls /sys/kernel/btf/vmlinux
```

If the file exists, BTF is available and Kloak can use CO-RE (Compile Once, Run Everywhere) to adapt to the running kernel.

### cgroup v2

Nodes must use the **cgroup v2** (unified) hierarchy. The controller locates pod containers under the `kubepods` cgroup in `/sys/fs/cgroup`.

```bash
stat -fc %T /sys/fs/cgroup   # must print cgroup2fs
```

## Kubernetes Requirements

### Minimum: Kubernetes 1.28+

Kloak requires Kubernetes **1.28 or later** and **Helm 3** to install the chart.

### RBAC Requirements

The `kloak-controller` ServiceAccount, used by both the controller DaemonSet and the webhook Deployment, is granted the following cluster-level permissions:

```yaml
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["get", "list", "watch"]
- apiGroups: [""]
  resources: ["secrets"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
- apiGroups: [""]
  resources: ["namespaces"]
  verbs: ["get", "list", "watch"]
- apiGroups: ["apps"]
  resources: ["replicasets", "deployments", "daemonsets", "statefulsets"]
  verbs: ["get", "list", "watch"]
- apiGroups: [""]
  resources: ["services"]
  verbs: ["get"]
- apiGroups: [""]
  resources: ["events"]
  verbs: ["create", "patch"]
```

### Privileges

The controller DaemonSet needs host-level access:

- `privileged: true`, `runAsUser: 0`, AppArmor profile `Unconfined`
- `hostPID: true`
- Capabilities `BPF`, `NET_ADMIN`, `SYS_ADMIN`, `SYS_RESOURCE`
- A privileged init container that mounts tracefs at `/sys/kernel/tracing` (Bidirectional mount propagation)
- hostPath mounts: `/sys/fs/cgroup`, `/sys/fs/bpf`, `/sys/kernel/btf` (read-only), `/sys/kernel/tracing`

Clusters that forbid privileged pods (for example, GKE Autopilot or namespaces enforcing the `restricted`/`baseline` Pod Security Standard) cannot run the controller.

### Architectures

Images and eBPF programs are built for **amd64** and **arm64**.

### Certificate Modes

The webhook needs a TLS certificate. Set `certificates.mode` in the chart values:

| Mode | Behavior |
|---|---|
| `auto` (default) | Helm generates a self-signed certificate, stores it in the `kloak-webhook-certs` Secret, and sets the webhook `caBundle`. An existing certificate is reused on upgrade. |
| `certManager` | Requires cert-manager. The chart creates a self-signed Issuer and a Certificate (stored in `kloak-webhook-certs`); cert-manager injects the CA bundle. |
| `provided` | Use your own TLS Secret (`certificates.provided.secretName`, `certKey`, `keyKey`). The chart does not set `caBundle` in this mode, so the webhook configurations must be made to trust your CA separately. |

## Supported Linux Distributions

### Tested in CI

| Distribution | Status | Notes |
|---|---|---|
| Ubuntu (GitHub `ubuntu-latest` runners) + k3s | Tested | Used in CI and nightly e2e |

### Expected to Work

Any distribution is expected to work when the node kernel is **6.6+** with BTF and cgroup v2 enabled. For example:

| Distribution | Status | Notes |
|---|---|---|
| Ubuntu 24.04 LTS | Expected | Ships kernel 6.8 |
| Ubuntu 22.04 LTS | Expected with HWE kernel | Default kernel 5.15 is too old; the HWE kernel is 6.6+ |
| Amazon Linux 2023 | Expected with a 6.6+ kernel | The original 6.1 kernel is too old; use a 6.12 kernel |
| Debian 12 (Bookworm) | Not supported with default kernel | Default kernel 6.1 is too old |
| Amazon Linux 2 | Not supported | Kernel too old |
| RHEL / Rocky 9.x | Verify | Kernel reports 5.14 with backports; confirm TCX and `bpf_loop` work before use |

::: warning
**Ubuntu 22.04 default kernel (5.15) is NOT compatible.** Install the HWE (Hardware Enablement) kernel and confirm `uname -r` reports 6.6 or later:
```bash
sudo apt install linux-generic-hwe-22.04
```
:::

## Cloud Provider Notes

Kloak has not been tested on managed Kubernetes services. It is expected to work on any managed node image whose kernel is **6.6+**, with BTF and cgroup v2. Check the kernel version on your nodes:

```bash
kubectl get nodes -o wide  # Check KERNEL-VERSION column
```

### Amazon EKS

- Use node AMIs with a 6.6+ kernel (for example Amazon Linux 2023 with a 6.12 kernel, or Ubuntu 24.04). Amazon Linux 2 is too old.
- The webhook Service listens on port 443 and forwards to the webhook pods on **TCP 9443**. The control plane must be able to reach the pods on 9443 (check node security groups).

### Google GKE

- GKE Autopilot does **not** allow privileged DaemonSets, which Kloak requires. Use GKE Standard.
- Verify that the node image kernel is 6.6+.

### Azure AKS

- Verify that the node image kernel is 6.6+. Ubuntu 22.04 node images with the 5.15 kernel are too old.
- AKS with Kata Containers / confidential nodes: not supported.

## Resource Requirements

### Controller DaemonSet (per node)

| Resource | Request | Limit | Notes |
|---|---|---|---|
| CPU | 10m | 500m | eBPF attachment is CPU-light; reconciliation is the main consumer |
| Memory | 64Mi | 512Mi | BPF maps + informer cache |

### Webhook Deployment

| Resource | Request | Limit | Notes |
|---|---|---|---|
| CPU | 10m | 500m | Admission requests are fast (JSON patch generation) |
| Memory | 64Mi | 128Mi | Stateless; only caches Kubernetes client objects |

### Kernel Resources

| Resource | Size | Notes |
|---|---|---|
| BPF map: `secret_map` | Scales with number of secrets | ~280 bytes per entry (8B key + 272B value), max 4096 entries; each secret value uses 2 entries |
| BPF map: `dns_ip_map` | Scales with resolved DNS entries | LRU, max 8192 entries |
| BPF map: `conn_ip_map` | Scales with active TCP connections | LRU, max 16384 entries |
| BPF map: `watched_hosts` | Scales with unique host filters | ~65 bytes per entry (64B key), max 1024 entries |
| Ring buffer: `tls_events` | Fixed size (compile-time) | 256KB; currently unused |
| Ring buffer: `proc_events` | Fixed size (compile-time) | 64KB |
| eBPF programs | 16 programs | TLS uprobes (OpenSSL/BoringSSL `SSL_write`, Go `crypto/tls`, cipher-init hooks, rewrite tail call), DNS kprobe/kretprobe, `tcp_sendmsg` kprobe, connect/close and exec/exit tracepoints, tc patch programs |

## Verification Checklist

Run these checks on a node to verify Kloak compatibility:

```bash
# 1. Kernel version (must be 6.6+)
uname -r

# 2. BTF availability
ls -la /sys/kernel/btf/vmlinux

# 3. cgroup v2
stat -fc %T /sys/fs/cgroup   # must print cgroup2fs

# 4. Uprobe support
ls /sys/kernel/tracing/uprobe_events 2>/dev/null && \
  echo "Uprobes available" || echo "Uprobes not available (check CONFIG_UPROBES and tracefs)"
```

::: tip
The simplest check is the kernel version: a 6.6+ kernel from a major distribution with BTF and cgroup v2 enabled has all required features.
:::
