# Labels and Annotations Reference

Kloak uses Kubernetes labels and annotations to control which secrets are protected, which pods are intercepted, and which hosts are allowed for secret transmission.

## Overview

| Name | Type | Applies To | Description |
|---|---|---|---|
| `getkloak.io/enabled` | Label | Secret | Enables Kloak protection for this secret. Triggers shadow secret creation. Must be a label (see below). |
| `getkloak.io/enabled` | Label | Pod | Enables Kloak for this pod. The webhook's `objectSelector` matches pods with this label. A value other than `"true"` opts the pod out. |
| `getkloak.io/enabled` | Annotation | Pod | Injected by the webhook on mutated pods. Read by the controller to attach eBPF uprobes. Do not set manually. |
| `getkloak.io/enabled` | Label | Namespace | Enables Kloak for all pods in this namespace. The webhook's `namespaceSelector` matches namespaces with this label. |
| `getkloak.io/hosts` | Label | Secret | A single allowed TLS destination hostname. Multiple hosts are not supported yet ([#102](https://github.com/spinningfactory/kloak/issues/102)). |
| `getkloak.io/port` | Label | Secret | Allowed destination TCP port for secret transmission (e.g., `443`). If omitted, all ports are allowed. |
| `getkloak.io/managed` | Label | Secret (shadow) | Automatically set by Kloak on shadow secrets. Do not set manually. |
| `getkloak.io/owner` | Label | Secret (shadow) | Name of the original secret. Automatically set by Kloak. Do not set manually. |

## Detailed Reference

### `getkloak.io/enabled`

Controls whether Kloak processes a resource. The value must be exactly `"true"` (string).

#### On Secrets (Label)

When set as a label on a Secret, the SecretReconciler:

1. Creates a shadow secret named `<secret-name>-kloak` whose values are `kloak:` placeholders: `kloak:` followed by random uppercase letters and digits, with exactly the same byte length as each real value
2. Labels the shadow `getkloak.io/managed=true` and sets an `OwnerReference` so the shadow is garbage collected when the original is deleted

Every 5 seconds the controller joins each enabled Secret with its shadow (from its informer cache) and syncs the shadow-prefix → real-value mapping into the eBPF `secret_map` on each node. There is no separate secret store.

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

::: warning
On Secrets, `getkloak.io/enabled` must be a **label**. The annotation form is not sufficient: the data plane only loads Secrets that carry the label, and the validating webhook only checks labeled Secrets. A Secret enabled only by annotation is never rewritten, so the application sends the placeholder.
:::

Placeholders are kept when a secret is rotated if the new value has the same byte length; otherwise a new placeholder is generated.

To disable protection, remove the label:

```bash
kubectl label secret my-api-key getkloak.io/enabled- -n my-namespace
```

The shadow secret will be automatically deleted and the mapping removed from the eBPF map on the next sync.

#### Validation

The validating webhook (`kloak-validating-webhook`, `failurePolicy: Fail`) checks Secrets carrying the `getkloak.io/enabled=true` label on CREATE and UPDATE. It rejects the Secret if:

- the `getkloak.io/hosts` label is not a lowercase DNS name
- the `getkloak.io/port` label is not a valid port
- the Secret has no data entries
- any value is shorter than 8 bytes or longer than 128 bytes

It does not check annotations, so `getkloak.io/hosts` or `getkloak.io/port` set as annotations pass, and are ignored.

#### On Pods (Label)

When set as a **label** on a Pod (typically via the pod template in a Deployment/StatefulSet/DaemonSet), the webhook's `objectSelector` matches the pod and processes it:

1. Rewrites `volumes[].secret` of Kloak-enabled Secrets to point to their shadow secrets (`<name>-kloak`). Environment variable references (`env[].valueFrom.secretKeyRef`, `envFrom[].secretRef`) and projected volume sources are not rewritten, so a pod that uses them gets the real value.
2. Injects the `getkloak.io/enabled` annotation (read by the controller)
3. Rejects the pod if any shadow secret is missing or is not Kloak-managed (fail-closed)

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
2. **Enablement inheritance:** Pods in this namespace without their own `getkloak.io/enabled` label are treated as Kloak-enabled. A pod labeled `getkloak.io/enabled: "false"` opts out.

The namespace Kloak is installed in is never mutated.

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
**Format:** A single lowercase hostname (RFC 1123, max 63 bytes, the label value limit). No ports (use `getkloak.io/port`). IP addresses are not supported in this release: an address is treated as a hostname and never matches.

```yaml
metadata:
  labels:
    getkloak.io/enabled: "true"
    getkloak.io/hosts: "api.stripe.com"
```

**Behavior:**
- If the label is **present**: only connections to the specified host receive the real value. All other destinations see the `kloak:` placeholder.
- If the label is **absent** or empty: the secret is allowed for all destinations (wildcard). `*` is not a valid label value.

::: danger
In this release `getkloak.io/hosts` must be a **label**. A `getkloak.io/hosts` annotation is ignored and not rejected: the secret has no host restriction and is rewritten for any destination. (It became an annotation in v0.1.2.)
:::

::: warning
Multiple hosts per secret are **not supported yet**, and label values can't contain
commas. Use one secret per host for now. Tracked in
[spinningfactory/kloak#102](https://github.com/spinningfactory/kloak/issues/102).
:::

::: tip
Hostnames are matched exactly (no wildcards). Use the exact hostname your application connects to. For example, use `api.stripe.com`, not `*.stripe.com` or `stripe.com`.
:::

**Hostname length limit:** 63 characters, the longest label value Kubernetes accepts.

### `getkloak.io/port`

Restricts which destination port is allowed to receive the real secret value. Applied as a **label** on Secrets.

**Type:** Label
**Applies to:** Secret
**Format:** `PORT`, a TCP port, e.g. `"443"`. The `PORT/PROTO` form the controller understands can't be used, because label values can't contain `/`.

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

::: warning
An invalid port value is rejected by the validating webhook. If the webhook is not installed, an invalid value is treated as "any port". Like `getkloak.io/hosts`, a `getkloak.io/port` annotation is ignored: the secret has no port restriction.
:::

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
Do not manually create or modify secrets with `getkloak.io/managed=true`. They are fully managed by the SecretReconciler and will be overwritten the next time the original secret is reconciled.
:::

### `getkloak.io/owner`

Automatically applied by Kloak to shadow secrets. Contains the name of the original secret that this shadow was created from.

**Type:** Label
**Applies to:** Secret (shadow)
**Value:** Name of the original secret

This label is informational and used for operational visibility (e.g., listing which shadow secrets exist for a given original).

## Enablement Precedence

The webhook decides whether a pod is enabled as follows:

1. **Pod label** `getkloak.io/enabled` -- if present, its value decides: `"true"` enables, any other value opts the pod out (even in an enabled namespace)
2. **Namespace label** `getkloak.io/enabled: "true"` -- applies to pods without their own label
3. If neither matches, the pod is **not** processed by Kloak

```
Pod has label?   ──yes──▶  Enabled only if value is "true"
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
