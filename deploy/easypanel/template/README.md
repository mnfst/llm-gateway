# Easypanel Template

This directory contains the Manifest template files intended for the upstream
[`easypanel-io/templates`](https://github.com/easypanel-io/templates)
repository.

To submit upstream, copy these files into:

```text
templates/manifest/index.ts
templates/manifest/meta.yaml
```

The template provisions:

- Manifest app service from `manifestdotbuild/manifest:6`.
- PostgreSQL 16 service.
- Persistent app volume for compressed request recordings.
- Generated database password, Better Auth secret, and Manifest encryption key.
- HTTPS domain proxy on port `2099`.
