---
"manifest": patch
---

Stop storing Google load-balancer headers (`Forwarded`, `Via`, trace context) in recorded request headers. `Forwarded` carries the caller's IP.
