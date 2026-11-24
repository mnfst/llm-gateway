import {
  Output,
  randomPassword,
  randomString,
  Services,
} from "~templates-utils";
import { Input } from "./meta";

export function generate(input: Input): Output {
  const services: Services = [];
  const databasePassword = randomPassword();
  const authSecret = randomString(64);
  const encryptionKey = randomString(64);

  services.push({
    type: "app",
    data: {
      serviceName: input.appServiceName,
      source: {
        type: "image",
        image: input.appServiceImage,
      },
      domains: [
        {
          host: "$(EASYPANEL_DOMAIN)",
          port: 2099,
        },
      ],
      env: [
        "PORT=2099",
        "BIND_ADDRESS=0.0.0.0",
        `DATABASE_URL=postgresql://postgres:${databasePassword}@$(PROJECT_NAME)_${input.databaseServiceName}:5432/$(PROJECT_NAME)`,
        `BETTER_AUTH_SECRET=${authSecret}`,
        `MANIFEST_ENCRYPTION_KEY=${encryptionKey}`,
        "BETTER_AUTH_URL=https://$(PRIMARY_DOMAIN)",
        "MANIFEST_MODE=selfhosted",
        "NODE_ENV=production",
        "SEED_DATA=false",
        "DB_POOL_MAX=10",
        "AUTH_DB_POOL_MAX=5",
        "REQUEST_RECORDING_STORAGE=filesystem",
        "REQUEST_RECORDING_FILESYSTEM_PATH=/data/request-recordings",
        `MANIFEST_TELEMETRY_DISABLED=${input.telemetryDisabled || "0"}`,
      ].join("\n"),
      mounts: [
        {
          type: "volume",
          name: "recordings",
          mountPath: "/data/request-recordings",
        },
      ],
    },
  });

  services.push({
    type: "postgres",
    data: {
      serviceName: input.databaseServiceName,
      image: "postgres:16",
      password: databasePassword,
    },
  });

  return { services };
}
