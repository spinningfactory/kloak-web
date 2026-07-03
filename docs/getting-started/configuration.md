# Configuration

This page covers all configuration options for the Kloak controller and webhook, namespace and workload enablement, and production resource tuning.

## Controller Flags

The controller runs as a DaemonSet on every node. It manages secret reconciliation and eBPF uprobe attachment.

| Flag | Default | Description |
|---|---|---|
| `--health-probe-bind-address` | `:8081` | Address for health (`/healthz`) and readiness (`/readyz`) probe endpoints. |
| `--cgroup-path` | `/sys/fs/cgroup` | Path to the cgroup v2 filesystem. When running in a container with a host mount, this is typically `/host/sys/fs/cgroup`. |
| `--trusted-dns-servers` | *(empty)* | Comma-separated list of trusted DNS server IPs. Only DNS responses from these IPs are used for host filtering. If empty, auto-discovers `kube-dns` cluster IP at startup. |

### Environment Variables

The controller also reads these environment variables (set automatically by the DaemonSet manifest):

| Variable | Description |
|---|---|
| `NODE_NAME` | The Kubernetes node name. Used to filter pod watches so each controller instance only manages pods on its own node. Populated from `spec.nodeName` via the downward API. |
| `POD_NAMESPACE` | The namespace where the controller is running (typically `kloak-system`). Used for locating the webhook certificate secret. Populated from `metadata.namespace` via the downward API. |

## Webhook Flags

The webhook runs as a Deployment and serves the mutating admission endpoint.

| Flag | Default | Description |
|---|---|---|
| `--health-probe-bind-address` | `:8081` | Address for health and readiness probe endpoints. |
| `--cert-dir` | `/certs` | Directory containing the TLS certificate and key files (`tls.crt`, `tls.key`). Mounted from the `kloak-webhook-certs` secret. |

The webhook listens on port `9443` for admission requests. The `Service` fronting the webhook maps port `443` to this target port.

## Webhook Certificates

Kubernetes requires all admission webhooks to serve TLS. When the API server intercepts a pod creation and forwards it to Kloak's mutating webhook, the connection must be encrypted. The API server also needs a trusted CA bundle to verify the webhook's certificate -- this is set in the `caBundle` field of the `MutatingWebhookConfiguration`.

Kloak needs a TLS certificate and key pair for the webhook service, and the corresponding CA certificate must be registered with the API server so it trusts the webhook endpoint.

Certificate management is configured via the Helm value `certificates.mode`:

### `auto` (default)

Helm generates a self-signed TLS certificate at install time, stores it in the `kloak-webhook-certs` secret, and sets the `caBundle` on the `MutatingWebhookConfiguration`. This is the recommended mode for most deployments -- no additional setup required.

### `certManager`

Integrates with [cert-manager](https://cert-manager.io/). Helm creates a `Certificate` and `Issuer` resource. The cert-manager `cainjector` automatically patches the `caBundle` on the `MutatingWebhookConfiguration`. Use this mode if you already run cert-manager and want automated certificate rotation.

```yaml
# values.yaml
certificates:
  mode: certManager
  certManager:
    issuerRef:
      name: kloak-selfsigned
      kind: Issuer
```

### `provided`

Helm skips certificate generation entirely and expects the `kloak-webhook-certs` secret to already exist. Use this mode when managing certificates externally (e.g., through your own PKI or a secrets management tool).

```yaml
# values.yaml
certificates:
  mode: provided
  provided:
    secretName: kloak-webhook-certs
    certKey: tls.crt
    keyKey: tls.key
```

::: tip Using cert-manager with provided mode
If you prefer full control, you can use `provided` mode with a cert-manager `Certificate` resource targeting the `kloak-webhook-certs` secret. You will need to manually set the `caBundle` on the `MutatingWebhookConfiguration`, or use cert-manager's `cainjector`.
:::

## Enablement Model

Kloak uses a strict opt-in model. Nothing is intercepted unless explicitly enabled. For Kloak to protect a secret end-to-end, two things must be enabled independently:

1. **The secret itself** -- tells Kloak *which* secrets to protect. Enabling a secret causes the controller to create a shadow copy with ULID placeholders and store the real-to-shadow mapping. Without this, no shadow secret exists and there is nothing to rewrite.

2. **The workload** -- tells Kloak *which* pods should have their TLS writes intercepted. Enabling a workload causes the webhook to rewrite secret volume references to point to shadow secrets, and the controller to attach eBPF uprobes to the pod's process. Without this, the pod mounts the original secret and no eBPF interception occurs.

Both sides are required. Enabling only the secret creates the shadow copy but no pod uses it. Enabling only the workload has no effect because the webhook only rewrites volume references for secrets that have a shadow copy.

### Secret Enablement

Label any secret to have Kloak create a shadow copy:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: my-secret
  labels:
    getkloak.io/enabled: "true"      # Required: triggers shadow secret creation
    getkloak.io/hosts: "api.example.com"  # Optional: restrict allowed destinations
type: Opaque
stringData:
  token: "my-real-token-value"
```

When the `SecretReconciler` detects this label, it creates `my-secret-kloak` with ULID placeholders length-matched to each key's value. The real secret values are stored in the controller's in-memory store and synced to the eBPF map in the kernel. The original secret is untouched.

### Workload Enablement

Workloads can be enabled at two levels -- pod label or namespace label. The webhook uses two `MutatingWebhookConfiguration` entries with Kubernetes selectors so that only kloak-enabled namespaces and pods are sent to the webhook. Non-kloak workloads are never affected, even if the webhook is down.

#### Pod Label

Label individual pods (via the pod template in a Deployment/StatefulSet/DaemonSet):

```yaml{6-7}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
spec:
  template:
    metadata:
      labels:
        getkloak.io/enabled: "true"
    spec:
      containers:
        - name: app
          # ...
```

When the pod is created, the webhook rewrites any Secret-backed volume references that have a corresponding shadow secret, and adds the `getkloak.io/enabled` annotation so the controller knows to attach eBPF uprobes. If the shadow secret has not been created yet (controller hasn't reconciled), the webhook **rejects** the pod to prevent real secrets from being mounted.

#### Namespace Label

Enables Kloak for all pods in a namespace. Useful when an entire namespace should be protected:

```bash
kubectl label namespace my-namespace getkloak.io/enabled=true
```

Every pod created in this namespace is treated as Kloak-enabled, even without an explicit pod label.

::: warning
Labeling a namespace enables Kloak for **every** pod in that namespace. Make sure all applications are compatible (see [Supported Runtimes](/guides/supported-runtimes)). Pods using unsupported TLS stacks will fail to have uprobes attached, which is logged as an error but does not block the pod.
:::

### Enablement Precedence

The webhook checks enablement in the following order, stopping at the first match:

1. **Pod label** -- `getkloak.io/enabled: "true"` on the pod itself.
2. **Namespace label** -- `getkloak.io/enabled: "true"` on the pod's namespace.

If neither is set to `"true"`, the pod is not processed by Kloak.

::: tip
Workload-level inheritance (Deployment, DaemonSet, StatefulSet labels) is not supported. Use pod template labels or namespace labels instead.
:::

### Host Filtering

The `getkloak.io/hosts` label on a secret controls which TLS destinations receive the real value:

```yaml
labels:
  getkloak.io/hosts: "api.example.com"   # Single host, single IP, or "*" (any)
```

A single value only — a comma-separated list is not supported yet and is rejected by the validating webhook (see [spinningfactory/kloak#102](https://github.com/spinningfactory/kloak/issues/102)).

When a TLS write is intercepted, the eBPF program resolves the destination hostname via the DNS-verified trust chain (DNS capture -> connection tracking -> host resolution). If the resolved hostname does not match the allowed host, the placeholder is **not** replaced -- the remote server receives the harmless `kloak:...` ULID. See the [Host Filtering guide](/guides/host-filtering) for details.

Omitting `getkloak.io/hosts` allows the secret to be sent to any destination.

## Helm Values

### Default Resources

The default Helm values include conservative resource defaults suitable for development and testing:

**Controller (DaemonSet):**
```yaml
resources:
  requests:
    cpu: 10m
    memory: 64Mi
  limits:
    cpu: 500m
    memory: 512Mi
```

**Webhook (Deployment):**
```yaml
resources:
  requests:
    cpu: 10m
    memory: 64Mi
  limits:
    cpu: 500m
    memory: 128Mi
```

::: tip Sizing for your workload
The controller's memory usage scales with the number of secrets being tracked and the number of pods being monitored on each node. For clusters with hundreds of secrets, consider increasing the memory limit to `1Gi`. The eBPF programs themselves have minimal overhead once loaded.
:::

### Custom Resource Overrides

Override resources via Helm values:

```yaml
# my-values.yaml
controller:
  resources:
    requests:
      cpu: 100m
      memory: 128Mi
    limits:
      cpu: "1"
      memory: 1Gi
```

```bash
helm upgrade kloak kloak/kloak -n kloak-system -f my-values.yaml
```

## Ports Reference

| Component | Port | Purpose |
|---|---|---|
| Controller | 8081 | Health and readiness probes |
| Webhook | 8081 | Health and readiness probes |
| Webhook | 9443 | Admission webhook endpoint (TLS) |

## Security Context

The controller requires elevated privileges for eBPF operations. The manifest sets:

```yaml
securityContext:
  privileged: true
  runAsUser: 0
  runAsGroup: 0
  appArmorProfile:
    type: Unconfined
  capabilities:
    add:
      - BPF
      - NET_ADMIN
      - SYS_ADMIN
      - SYS_RESOURCE
```

The controller also requires `hostPID: true` at the pod level to access container process cgroups and attach uprobes via `/proc/<pid>/maps`.

The webhook does **not** require any elevated privileges and runs with default security settings.

## Volume Mounts (Controller)

The controller DaemonSet mounts four host paths:

| Mount Path | Host Path | Access | Purpose |
|---|---|---|---|
| `/host/sys/fs/cgroup` | `/sys/fs/cgroup` | Read-write | Cgroup v2 filesystem for resolving container cgroup IDs |
| `/sys/fs/bpf` | `/sys/fs/bpf` | Read-write | BPF filesystem for pinning eBPF maps and programs |
| `/sys/kernel/btf` | `/sys/kernel/btf` | Read-only | Kernel BTF (BPF Type Format) data for CO-RE (Compile Once, Run Everywhere) |
| `/sys/kernel/tracing` | `/sys/kernel/tracing` | Read-only | Tracefs for eBPF tracepoint and kprobe attachment |
