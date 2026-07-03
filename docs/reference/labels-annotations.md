# Labels and Annotations Reference

Kloak uses Kubernetes labels and annotations to control which secrets are protected, which pods are intercepted, and which hosts are allowed for secret transmission.

## Overview

| Name | Type | Applies To | Description |
|---|---|---|---|
| `getkloak.io/enabled` | Label | Secret | Enables Kloak protection for this secret. Triggers shadow secret creation. |
| `getkloak.io/enabled` | Annotation | Secret | Alternative to label. Enables Kloak protection for this secret. |
| `getkloak.io/enabled` | Label | Pod | Enables Kloak for this pod. The webhook's `objectSelector` matches pods with this label. |
| `getkloak.io/enabled` | Annotation | Pod | Injected by the webhook on mutated pods. Read by the controller to attach eBPF uprobes. Do not set manually. |
| `getkloak.io/enabled` | Label | Namespace | Enables Kloak for all pods in this namespace. The webhook's `namespaceSelector` matches namespaces with this label. |
| `getkloak.io/hosts` | Label | Secret | A single allowed TLS destination hostname, IP, or `*` (any). Multiple hosts are not supported yet ([#102](https://github.com/spinningfactory/kloak/issues/102)). |
| `getkloak.io/port` | Label | Secret | Allowed destination port for secret transmission (e.g., `443`). If omitted, all ports are allowed. |
| `getkloak.io/managed` | Label | Secret (shadow) | Automatically set by Kloak on shadow secrets. Do not set manually. |
| `getkloak.io/owner` | Label | Secret (shadow) | Name of the original secret. Automatically set by Kloak. Do not set manually. |

## Detailed Reference

### `getkloak.io/enabled`

Controls whether Kloak processes a resource. The value must be exactly `"true"` (string).

#### On Secrets (Label or Annotation)

When set on a Secret, the SecretReconciler:

1. Creates a shadow secret named `<secret-name>-kloak` with `kloak:<ULID>` placeholder values
2. Stores the ULID-to-real-value mapping in the in-memory store
3. Sets up an `OwnerReference` so the shadow is garbage collected when the original is deleted

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: my-api-key
  labels:
    getkloak.io/enabled: "true"
type: Opaque
data:
  key: bXktc2VjcmV0LXZhbHVl
```

::: tip
Both labels and annotations are checked (`secret.Labels["getkloak.io/enabled"] == "true" || secret.Annotations["getkloak.io/enabled"] == "true"`). Use labels for consistency with the other Kloak resources.
:::

To disable protection, remove the label:

```bash
kubectl label secret my-api-key getkloak.io/enabled- -n my-namespace
```

The shadow secret will be automatically deleted and storage mappings cleaned up.

#### On Pods (Label)

When set as a **label** on a Pod (typically via the pod template in a Deployment/StatefulSet/DaemonSet), the webhook's `objectSelector` matches the pod and processes it:

1. Rewrites Secret volume references to point to shadow secrets
2. Injects the `getkloak.io/enabled` annotation (read by the controller)
3. Rejects the pod if any shadow secret is missing (fail-closed)

```yaml
metadata:
  labels:
    getkloak.io/enabled: "true"
```

::: warning
Pod enablement requires a **label**, not an annotation. The webhook uses Kubernetes `objectSelector` to match pods, which only works with labels.
:::

#### On Namespaces (Label)

When set on a Namespace, two things happen:

1. **Webhook scope:** The `MutatingWebhookConfiguration` has a `namespaceSelector` that matches namespaces with this label. All pods created in this namespace are sent to the webhook.
2. **Enablement inheritance:** All pods in this namespace are treated as Kloak-enabled, even without an explicit pod label.

```bash
kubectl label namespace my-app getkloak.io/enabled=true
```

::: danger
Labeling a namespace enables Kloak for **every** pod in that namespace. Make sure all applications in the namespace are compatible (see [Supported Runtimes](../guides/supported-runtimes.md)). Pods using unsupported TLS stacks will fail to have uprobes attached, which is logged as an error but does not block the pod.
:::

### `getkloak.io/hosts`

Restricts which TLS destination hostnames are allowed to receive the real secret value. Applied as a **label** on Secrets.

**Type:** Label
**Applies to:** Secret
**Format:** A single hostname, a single IP, or `*` (any). No ports (use `getkloak.io/port`).

```yaml
metadata:
  labels:
    getkloak.io/enabled: "true"
    getkloak.io/hosts: "api.stripe.com"
```

**Behavior:**
- If the label is **present**: only connections to the specified host receive the real value. All other destinations see the `kloak:<ULID>` placeholder.
- If the label is **absent**, empty, or `*`: the secret is allowed for all destinations (wildcard).

::: warning
Multiple hosts per secret are **not supported yet**. A comma-separated value is
**rejected** by the validating webhook; if the webhook is not installed, the whole
string is treated as one (invalid) hostname that never matches, so the secret is
never rewritten. Use one secret per host for now. Tracked in
[spinningfactory/kloak#102](https://github.com/spinningfactory/kloak/issues/102).
:::

::: tip
Hostnames are matched exactly (case-sensitive, no wildcards). Use the exact hostname your application connects to. For example, use `api.stripe.com`, not `*.stripe.com` or `stripe.com`.
:::

**Hostname length limit:** 64 characters. Hostnames longer than 64 characters are truncated in the BPF map.

### `getkloak.io/port`

Restricts which destination port is allowed to receive the real secret value. Applied as a **label** on Secrets.

**Type:** Label
**Applies to:** Secret
**Format:** Port number as a string (e.g., `"443"`)

```yaml
metadata:
  labels:
    getkloak.io/enabled: "true"
    getkloak.io/hosts: "api.stripe.com"
    getkloak.io/port: "443"
```

**Behavior:**
- If the label is **present**: only connections to the specified port receive the real value.
- If the label is **absent** or empty: the secret is allowed for all ports (wildcard).

### `getkloak.io/managed`

Automatically applied by Kloak to shadow secrets. Indicates that the secret is managed by Kloak and should not be manually edited.

**Type:** Label
**Applies to:** Secret (shadow)
**Value:** `"true"`

```yaml
# Automatically set -- do not create manually
metadata:
  name: my-api-key-kloak
  labels:
    getkloak.io/managed: "true"
    getkloak.io/owner: "my-api-key"
```

::: danger
Do not manually create or modify secrets with `getkloak.io/managed=true`. They are fully managed by the SecretReconciler and will be overwritten on the next reconciliation cycle.
:::

### `getkloak.io/owner`

Automatically applied by Kloak to shadow secrets. Contains the name of the original secret that this shadow was created from.

**Type:** Label
**Applies to:** Secret (shadow)
**Value:** Name of the original secret

This label is informational and used for operational visibility (e.g., listing which shadow secrets exist for a given original).

## Enablement Precedence

The webhook checks for enablement in the following order. The first match wins:

1. **Pod label** `getkloak.io/enabled: "true"` -- most specific
2. **Namespace label** `getkloak.io/enabled: "true"` -- applies to all pods in namespace
3. If neither matches, the pod is **not** processed by Kloak

```
Pod label?       ──yes──▶  Enabled
       │ no
       ▼
Namespace label? ──yes──▶  Enabled
       │ no
       ▼
                           Not enabled
```

::: tip
Workload-level inheritance (Deployment, DaemonSet, StatefulSet labels) is not supported. Use pod template labels or namespace labels instead.
:::

## Quick Reference

### Enable Kloak for a secret:
```bash
kubectl label secret my-secret getkloak.io/enabled=true -n my-namespace
```

### Enable Kloak for a namespace:
```bash
kubectl label namespace my-namespace getkloak.io/enabled=true
```

### Add host filtering:
```bash
kubectl label secret my-secret getkloak.io/hosts=api.stripe.com -n my-namespace
```

### Disable Kloak for a secret:
```bash
kubectl label secret my-secret getkloak.io/enabled- -n my-namespace
```

### Check if a pod was mutated:
```bash
kubectl get pod <pod-name> -n my-namespace -o jsonpath='{.metadata.annotations.getkloak\.io/enabled}'
```

### List all shadow secrets:
```bash
kubectl get secrets -l getkloak.io/managed=true --all-namespaces
```

### Find the shadow for a specific secret:
```bash
kubectl get secrets -l getkloak.io/owner=my-secret -n my-namespace
```
