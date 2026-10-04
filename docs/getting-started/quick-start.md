# Quick Start

Protect your first Kubernetes secret with Kloak in under five minutes. By the end of this guide, your application will read harmless placeholder values from its mounted secrets, while the real credentials are injected transparently at the kernel level during TLS transmission.

## What You Will Build

```
                    Your App                         Network
               +--------------+               +----------------+
  Reads from   |              |   TLS write   |                |
  mounted vol  | kl::5Gyh7..  | ------------> | REAL-API-KEY   |
               | (shadow)     |   eBPF patches in-kernel       |
               +--------------+               +----------------+
```

Your application sees `kl::5Gyh7ae*...` in its secret files. When it sends that value over a TLS connection, Kloak's eBPF programs patch the real secret into the encrypted TLS record as it leaves the pod. The application never handles the actual credential.

## Prerequisites

- A running Kubernetes cluster with [Kloak installed](./installation.md)
- `kubectl` configured and pointed at your cluster

## Step 1: Create a Namespace

Create a namespace for this guide:

```bash
kubectl create namespace kloak-quickstart
```

::: tip Enablement model
Kloak uses a layered opt-in model. The webhook only processes pods that are explicitly enabled via pod labels or namespace labels. In this guide, we use a pod label in Step 3 to enable Kloak.

This guide uses its own namespace, `kloak-quickstart`, so it doesn't clash with the chart's optional demo (`--set demo.enabled=true`), which uses `kloak-demo`.
:::

## Step 2: Create a Secret

Create a standard Kubernetes secret, label it for Kloak, and annotate it with the host it may be sent to:

```yaml{7,9}
# secret.yaml
apiVersion: v1
kind: Secret
metadata:
  name: my-api-credentials
  labels:
    getkloak.io/enabled: "true"
  annotations:
    getkloak.io/hosts: "httpbin.org"
type: Opaque
stringData:
  api-key: "sk-live-REAL-SECRET-KEY-12345"
```

```bash
kubectl apply -f secret.yaml -n kloak-quickstart
```

::: tip Label vs annotation
`getkloak.io/enabled` must be a **label**. `getkloak.io/hosts` must be an **annotation**: Kloak's validating webhook rejects a Secret that sets it as a label. Each value must also be 8–128 bytes long.
:::

Two things happen when you apply this:

1. Kloak's validating webhook checks the Secret, and the `SecretReconciler` detects the `getkloak.io/enabled=true` label.
2. It creates a shadow secret called `my-api-credentials-kloak` containing a random `kl::` placeholder with exactly the same byte length as the original value.

Verify the shadow secret was created:

```bash
kubectl get secrets -n kloak-quickstart
```

```
NAME                          TYPE     DATA   AGE
my-api-credentials            Opaque   1      10s
my-api-credentials-kloak      Opaque   1      8s
```

Inspect the shadow value:

```bash
kubectl get secret my-api-credentials-kloak -n kloak-quickstart \
  -o jsonpath='{.data.api-key}' | base64 -d
```

You will see something like `kl::5Gyh7ae*XwH2f2WZoZ351e3sk` -- a harmless random placeholder with the same byte length as your real secret (29 bytes).

## Step 3: Deploy an Application

Create a simple deployment that mounts the secret and sends it in an HTTP header:

```yaml{17,43}
# app.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: demo-app
  labels:
    app: demo-app
spec:
  replicas: 1
  selector:
    matchLabels:
      app: demo-app
  template:
    metadata:
      labels:
        app: demo-app
        getkloak.io/enabled: "true"
    spec:
      containers:
        - name: app
          image: curlimages/curl:latest
          command:
            - sh
            - -c
            - |
              while true; do
                SECRET=$(cat /etc/secrets/api-key)
                echo "Secret value seen by app: $SECRET"
                echo "---"
                echo "Making HTTPS request to httpbin.org..."
                curl -sk -H "Authorization: Bearer $SECRET" \
                  https://httpbin.org/headers
                echo ""
                sleep 10
              done
          volumeMounts:
            - name: api-secret
              mountPath: /etc/secrets
              readOnly: true
      volumes:
        - name: api-secret
          secret:
            secretName: my-api-credentials
```

```bash
kubectl apply -f app.yaml -n kloak-quickstart
```

::: warning Note the volume reference
The deployment references `secretName: my-api-credentials` (the **original** secret). Kloak's webhook automatically rewrites this to `my-api-credentials-kloak` (the shadow secret) when the pod is created. You never need to change your manifests.
:::

## Step 4: Verify It Works

Wait for the pod to start:

```bash
kubectl rollout status deployment/demo-app -n kloak-quickstart --timeout=60s
```

Now check the application logs:

```bash
kubectl logs -l app=demo-app -n kloak-quickstart --tail=30
```

You should see two key things:

**1. The app reads the shadow value (not the real secret):**
```
Secret value seen by app: kl::5Gyh7ae*XwH2f2WZoZ351e3sk
```

**2. The HTTPS response from httpbin.org shows the real secret was sent:**
```json
{
  "headers": {
    "Authorization": "Bearer sk-live-REAL-SECRET-KEY-12345",
    "Host": "httpbin.org"
  }
}
```

The application never saw the real secret, but the TLS-encrypted request carried it. Kloak's uprobe saw the placeholder when curl wrote it to TLS. curl's TLS library then encrypted the placeholder, and a Kloak tc program on the host side of the pod's network interface patched the real value into the AES-GCM ciphertext and fixed up the authentication tag. The real value never exists in the pod's memory.

## Step 5: Verify Webhook Mutation

Confirm that the pod was mutated to use the shadow secret:

```bash
kubectl get pod -l app=demo-app -n kloak-quickstart -o jsonpath='{.items[0].spec.volumes}' | jq .
```

```json
[
  {
    "name": "api-secret",
    "secret": {
      "secretName": "my-api-credentials-kloak"
    }
  }
]
```

Notice the `secretName` was changed from `my-api-credentials` to `my-api-credentials-kloak` by the webhook.

## How Host Filtering Works

In Step 2, you added the annotation `getkloak.io/hosts: "httpbin.org"`. This tells Kloak to only replace the placeholder when the TLS connection is headed to `httpbin.org`.

If the application tries to send the same placeholder to a different host, Kloak will **not** substitute the real value -- the destination receives the harmless `kl::...` placeholder instead. This prevents secrets from being exfiltrated to unauthorized endpoints.

`getkloak.io/hosts` takes a single hostname (or a single IP, or `*` for any).
Multiple hosts per secret are not supported yet — a comma-separated value is
rejected by the validating webhook. Use one secret per host for now
([spinningfactory/kloak#102](https://github.com/spinningfactory/kloak/issues/102)).

To allow a secret to be sent to any host, omit the `getkloak.io/hosts` annotation entirely (or set it to `*`). To also restrict the destination port, add the `getkloak.io/port` annotation (for example `"443"` or `"443/tcp"`).

## Clean Up

```bash
kubectl delete namespace kloak-quickstart
```

## Next Steps

- Learn about all available flags and tuning options in the [Configuration](./configuration.md) guide.
- Read about the [architecture](/architecture/overview) to understand how eBPF uprobes intercept TLS writes.
