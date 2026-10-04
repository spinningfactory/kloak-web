# Protecting Secrets with Kloak

This guide walks you through protecting your first Kubernetes Secret with Kloak. By the end, your application will never see actual secret values -- it will only see harmless `kl::…` placeholders. The real values are patched into the encrypted TLS traffic in-kernel by eBPF, after your application has handed the data to its TLS library.

## How It Works

When you label a Secret with `getkloak.io/enabled=true`, Kloak's SecretReconciler automatically:

1. Creates a **shadow secret** named `<original>-kloak` containing `kl::` placeholder values (`kl::` followed by random characters)
2. Generates each placeholder at exactly the original value's byte length and HPACK Huffman bit length, so HTTP/1.1 and HTTP/2 rewrites keep the wire format valid

Every 5 seconds the controller joins each enabled Secret with its shadow and syncs the placeholder-to-real-value pairs into the eBPF `secret_map`.

Your application mounts and reads the shadow secret -- it only ever sees the placeholders. When the application writes data over TLS, an eBPF uprobe on the TLS write function scans for the `kl::` prefix and records the patch; after the TLS library encrypts the data, a tc program patches the real value into the ciphertext before the packet leaves the node.

## Step 1: Label Your Secret

Start with a standard Kubernetes Secret:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: api-credentials
  labels:
    getkloak.io/enabled: "true"        # Enable Kloak protection (must be a label)
  annotations:
    getkloak.io/hosts: "api.stripe.com" # Optional: restrict to one host (must be an annotation)
type: Opaque
data:
  api-key: c2stbGl2ZS1rZXktMTIzNDU2Nzg5MA==  # sk-live-key-1234567890
```

Apply it:

```bash
kubectl apply -f secret.yaml -n my-app
```

Within seconds, Kloak creates a shadow secret:

```bash
$ kubectl get secrets -n my-app
NAME                   TYPE     DATA   AGE
api-credentials        Opaque   1      5s
api-credentials-kloak  Opaque   1      5s
```

Inspect the shadow secret to see the placeholder:

```bash
$ kubectl get secret api-credentials-kloak -n my-app -o jsonpath='{.data.api-key}' | base64 -d
kl::Os;&Xuie02icasosoi
```

The placeholder has the same length (22 bytes) as `sk-live-key-1234567890`. Yours will contain different random characters.

::: tip
The shadow secret has an `OwnerReference` pointing to the original and is labeled `getkloak.io/managed=true`. If you delete the original secret, Kubernetes garbage collection automatically cleans up the shadow.
:::

::: warning
Each secret value must be 8 -- 128 bytes long (`kl::` plus at least 4 characters for the eBPF lookup key), and its HPACK Huffman density must be matchable by a same-length placeholder. The validating webhook rejects values that fail either check at `kubectl apply` time.
:::

## Step 2: Enable Kloak on Your Pod

Kloak needs to know which pods should be mutated and have eBPF uprobes attached. You have two options:

### Option A: Pod Label

Add the label to the pod template. If the pod has the label, its value decides: `"false"` opts a pod out even in an enabled namespace.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
spec:
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
        getkloak.io/enabled: "true"
    spec:
      containers:
        - name: app
          image: my-app:latest
          volumeMounts:
            - name: api-creds
              mountPath: /etc/secrets/api
              readOnly: true
      volumes:
        - name: api-creds
          secret:
            secretName: api-credentials  # Reference the ORIGINAL secret name
```

::: warning
Only the pod **label** enables Kloak. A `getkloak.io/enabled` pod annotation does not, and there is no inheritance from Deployments or other workloads -- set the label on the pod template.
:::

### Option B: Namespace Label (Enables All Pods in Namespace)

```bash
kubectl label namespace my-app getkloak.io/enabled=true
```

When a namespace is labeled, every pod created in that namespace is automatically processed by Kloak -- no per-pod labels needed, unless a pod opts out with `getkloak.io/enabled: "false"`.

::: tip
Always reference the **original** secret name in your pod spec, not the shadow. The webhook automatically rewrites the reference to the shadow secret instead.
:::

## Step 3: How the Webhook Mutates Your Pod

When a pod with the `getkloak.io/enabled=true` label (or in a labeled namespace) is created, the Kloak mutating webhook intercepts the admission request and:

1. Checks if Kloak is enabled (pod label, otherwise namespace label)
2. Finds every reference to a Secret labeled `getkloak.io/enabled=true` in `volumes[].secret`, `env[].valueFrom.secretKeyRef`, and `envFrom[].secretRef` (containers, init containers, and ephemeral containers)
3. Rewrites each reference from `api-credentials` to `api-credentials-kloak`
4. **Rejects** the pod if a shadow secret is missing or is not a Kloak-managed shadow (fail-closed -- prevents real secrets from being mounted)
5. Adds the `getkloak.io/enabled: "true"` annotation to the pod (so the controller can detect it)

::: warning
Secrets referenced through `projected` volume sources are **not** rewritten. Don't reference protected secrets through projected volumes.
:::

You can verify the mutation worked:

```bash
# Check the pod annotation (injected by webhook on mutation)
$ kubectl get pod -l app=my-app -n my-app -o jsonpath='{.items[0].metadata.annotations.getkloak\.io/enabled}'
true

# Check which secret is actually mounted
$ kubectl get pod -l app=my-app -n my-app -o jsonpath='{.items[0].spec.volumes[0].secret.secretName}'
api-credentials-kloak
```

## Step 4: Verify the eBPF Rewrite

The best way to verify Kloak is working is to send a request to an echo service like [httpbin.org](https://httpbin.org) that reflects your headers back:

### Create the Secret

```bash
kubectl create secret generic api-credentials \
    --from-literal=api-key="sk-live-key-1234567890" \
    -n my-app --dry-run=client -o yaml | \
    kubectl label -f - getkloak.io/enabled="true" --local -o yaml | \
    kubectl annotate -f - getkloak.io/hosts="httpbin.org" --local -o yaml | \
    kubectl apply -f -
```

### Deploy a Test App

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: curl-test
  namespace: my-app
spec:
  replicas: 1
  selector:
    matchLabels:
      app: curl-test
  template:
    metadata:
      labels:
        app: curl-test
        getkloak.io/enabled: "true"
    spec:
      containers:
        - name: curl
          image: curlimages/curl:latest
          command: ["sh", "-c"]
          args:
            - |
              while true; do
                SECRET=$(cat /etc/secrets/api/api-key)
                echo "App sees: $SECRET"
                echo "---"
                curl -s https://httpbin.org/headers \
                  -H "X-Api-Key: $SECRET"
                echo "---"
                sleep 10
              done
          volumeMounts:
            - name: api-creds
              mountPath: /etc/secrets/api
              readOnly: true
      volumes:
        - name: api-creds
          secret:
            secretName: api-credentials
```

### Check the Logs

```bash
kubectl logs -l app=curl-test -n my-app
```

You should see output like:

```
App sees: kl::Os;&Xuie02icasosoi
---
{
  "headers": {
    "Host": "httpbin.org",
    "X-Api-Key": "sk-live-key-1234567890"
  }
}
---
```

The application reads `kl::Os;&Xuie02icasosoi` from the mounted secret, but httpbin.org receives `sk-live-key-1234567890` -- the real value was patched into the encrypted traffic in-kernel.

::: danger
If you see the `kl::` placeholder in the httpbin response, the eBPF rewrite did not trigger. Common causes:
- The controller pod is not running or not ready on the node
- The eBPF map has not synced yet (wait 10-15 seconds after pod startup)
- The connection negotiated a non-AES-GCM cipher suite (e.g. ChaCha20-Poly1305)
- The application's TLS library or version is not supported (see [Supported Runtimes](/guides/supported-runtimes))
- The DNS resolution for the target host was not captured (check controller logs for DNS debug counters)
:::

## What Happens Under the Hood

Here is the complete lifecycle of a protected secret:

```
1. You create Secret with label getkloak.io/enabled=true
   │
2. SecretReconciler creates shadow secret (api-credentials-kloak)
   │  Each value: "kl::" + random characters, same byte length and
   │  HPACK Huffman bit length as the original
   │
3. Controller syncs placeholder → real value + host/IP/port filter
   │  into the eBPF secret_map (every 5 seconds)
   │
4. Pod is created referencing the original secret
   │
5. Webhook intercepts admission, rewrites reference: api-credentials → api-credentials-kloak
   │
6. Pod starts, reads shadow secret → sees "kl::Os;&Xuie02icasosoi"
   │
7. Controller detects pod, finds PID via cgroup, attaches eBPF uprobes
   │
8. App calls SSL_write() / tls.Conn.Write() with data containing "kl::..."
   │
9. eBPF uprobe fires (plaintext buffer is never modified):
   ├─ Phase 1: Scans the write buffer for "kl::" (or its HPACK Huffman form)
   │           and records the 8-byte lookup keys
   └─ Phase 2 (tail call): Looks up each key, checks the host/IP/port filter,
              computes an XOR delta (placeholder XOR real value)
   │
10. TLS library encrypts the placeholder; a tc program on the host side of
    the pod's veth XORs the delta into the AES-GCM ciphertext and recomputes
    the GCM tag
    └─ The application process never had access to the real value
```

## Updating Secrets

When you update the original secret, Kloak automatically:

1. Detects the change via the SecretReconciler watch
2. Keeps the existing placeholder when the new value has the same byte length and the same HPACK Huffman bit length
3. Generates new placeholders for new keys or values whose length or Huffman bit length changed
4. Updates the shadow secret
5. Syncs the new mappings to the eBPF map (within 5 seconds)

No pod restart is required -- the eBPF map is updated live.

::: tip
Your application does not see a "change" in the mounted file unless a key is added or removed, or a value's byte length or Huffman bit length changes.
:::

## Cleaning Up

To stop protecting a secret, remove the label:

```bash
kubectl label secret api-credentials getkloak.io/enabled- -n my-app
```

The SecretReconciler will automatically delete the shadow secret, and the next sync removes its entries from the eBPF map. Running pods will continue to see the old placeholder values (which are no longer rewritten) until restarted.
