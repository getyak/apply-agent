# Local infrastructure

## Optional local limits

`compose.local-limits.example.yml` is an explicit opt-in example for a shared development host. Image digests, service environments and persistent volumes come from `docker-compose.yml`; the example adds these budgets:

| Service | CPUs | Memory | PIDs |
| --- | ---: | ---: | ---: |
| postgres | 1 | 768m | 256 |
| redis | 0.5 | 384m | 128 |
| minio | 1 | 1g | 256 |
| minio-init | 0.5 | 256m | 128 |

Published ports bind to `127.0.0.1`, preserving `POSTGRES_PORT` and `REDIS_PORT`. All four services use Docker's `local` log driver with `max-size: 10m` and `max-file: 5`.

Requires Docker Compose **2.24.4+**. The `ports: !override` lists replace the base publications, including wildcard bindings; see the [official merge reference](https://docs.docker.com/reference/compose-file/merge/#replace-value).

From the repository root, validate the combined configuration with your private development environment:

```sh
docker compose --env-file .env \
  -f infra/docker-compose.yml \
  -f infra/compose.local-limits.example.yml \
  config --quiet
```

Include both `-f` arguments when intentionally choosing these limits for local Compose operations. This example filename is not automatically loaded; existing default commands continue to select the base configuration. Validation renders configuration only; it does not start or change services.
