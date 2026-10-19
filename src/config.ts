/**
 * The monitors file: the single source of truth for what Kuma should contain.
 */

import { readFileSync } from "node:fs";

/** Kuma monitor fields this tool may set. Anything else stays out of the payload. */
export const KUMA_FIELDS = [
    "type", "name", "parent", "description", "url", "method", "active",
    "interval", "retryInterval", "resendInterval", "maxretries", "timeout",
    "accepted_statuscodes", "maxredirects", "ignoreTls", "upsideDown",
    "expiryNotification", "keyword", "invertKeyword", "jsonPath", "expectedValue",
    "saveResponse", "saveErrorResponse", "responseMaxLength",
    "httpBodyEncoding", "body", "headers", "conditions", "proxyId", "notificationIDList",
] as const;

export type KumaField = (typeof KUMA_FIELDS)[number];
export type MonitorFields = Partial<Record<KumaField, unknown>>;

export type Environment = {
    /** Key of the notification that receives this environment's alerts. */
    notification?: string;
    /** Applied on top of `defaults` for every monitor of this environment. */
    overrides?: MonitorFields;
};

export type NotificationDef = {
    key: string;
    name: string;
    type: "discord";
    /** Name of the env variable holding the webhook URL (never the URL itself). */
    webhookEnv: string;
    /** Name of the env variable holding comma-separated Discord user IDs to ping. */
    mentionsEnv?: string;
};

export type MonitorDef = MonitorFields & {
    name: string;
    url: string;
    env: string;
};

export type Group = {
    name: string;
    description?: string;
    monitors: MonitorDef[];
};

export type Config = {
    defaults: MonitorFields;
    environments: Record<string, Environment>;
    notifications: NotificationDef[];
    groups: Group[];
};

/** Name shown in Kuma, and the key used to find a monitor again on the next run. */
export const monitorName = (group: Group, monitor: MonitorDef) => `${group.name} - ${monitor.name}`;

export function loadConfig(path: string): Config {
    const config = JSON.parse(readFileSync(path, "utf8")) as Config;
    const errors: string[] = [];
    const seen = new Set<string>();
    const notificationKeys = new Set(config.notifications.map((n) => n.key));

    for (const [env, def] of Object.entries(config.environments)) {
        if (def.notification && !notificationKeys.has(def.notification)) {
            errors.push(`environment "${env}" routes to unknown notification "${def.notification}"`);
        }
    }

    for (const group of config.groups) {
        if (seen.has(group.name)) errors.push(`duplicate group "${group.name}"`);
        seen.add(group.name);
        for (const monitor of group.monitors) {
            const name = monitorName(group, monitor);
            if (seen.has(name)) errors.push(`duplicate monitor "${name}"`);
            seen.add(name);
            if (!config.environments[monitor.env]) errors.push(`"${name}": unknown env "${monitor.env}"`);
            try {
                new URL(monitor.url);
            } catch {
                errors.push(`"${name}": invalid url "${monitor.url}"`);
            }
        }
    }

    if (errors.length) throw new Error(`${path} is invalid:\n  - ${errors.join("\n  - ")}`);
    return config;
}
