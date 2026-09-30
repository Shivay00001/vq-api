# Quickstart — VisionQuantech API

## 1. Get a key
Keys are issued from the VisionQuantech dashboard (or via the admin API).
Test keys start with `vq_test_`, live keys with `vq_live_`.

## 2. First call (cURL)
```bash
curl -X POST https://api.visionquantech.com/v1/calc/gst-interest \
  -H "Authorization: Bearer vq_live_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"type":"delayed","amount":100000,"due_date":"2026-08-20","pay_date":"2026-09-19"}'
```

## 3. Python
```python
import requests
API = "https://api.visionquantech.com"
H = {"Authorization": "Bearer vq_live_YOUR_KEY"}

# EMI with schedule
r = requests.post(f"{API}/v1/calc/emi",
    json={"principal": 5000000, "annual_rate_pct": 8.5, "months": 240, "schedule": True},
    headers=H)
print(r.json()["emi"])

# Idempotent POST (safe to retry)
r = requests.post(f"{API}/v1/calc/salary",
    json={"ctc_annual": 1200000, "state": "MH"},
    headers={**H, "Idempotency-Key": "payroll-run-2026-09-01"})
print(r.json()["in_hand_monthly"])

# Async image job: submit -> poll -> download
with open("photo.png", "rb") as f:
    r = requests.post(f"{API}/v1/jobs",
        files={"file": f},
        data={"operation": "image.resize",
              "params": '{"width": 800, "format": "jpeg", "quality": 75}'},
        headers=H)
job = r.json()
import time
while True:
    s = requests.get(f"{API}{job['poll_url']}", headers=H).json()
    if s["status"] == "done": break
    time.sleep(1)
img = requests.get(f"{API}{s['result_url']}", headers=H).content
open("photo-small.jpg", "wb").write(img)
```

## 4. JavaScript (Node 18+)
```js
const H = { Authorization: "Bearer vq_live_YOUR_KEY", "Content-Type": "application/json" };
const r = await fetch("https://api.visionquantech.com/v1/calc/gratuity", {
  method: "POST", headers: H,
  body: JSON.stringify({ monthly_salary: 30000, years: 5 })
});
console.log(await r.json()); // { gratuity: 86538.46, ... }
```

## 5. Check quota
```bash
curl https://api.visionquantech.com/v1/status \
  -H "Authorization: Bearer vq_live_YOUR_KEY"
# → {"tier":"free","usage":{"used":42,"quota":1000,"remaining":958}}
# Watch for x-vq-quota-warning response header at 70%/90%.
```

## 6. Errors
All errors look like: `{"error":{"code":"rate_limited","message":"…","request_id":"…"}}`.
- `401` — missing/invalid key, or key sent in URL (use the header!)
- `402` — monthly quota exhausted → upgrade
- `429` — slow down; honor the `Retry-After` header
