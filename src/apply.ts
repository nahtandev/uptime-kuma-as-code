/**
 * Reconciles Kuma with the monitors file. Idempotent: running it twice changes
 * nothing the second time. Without --apply it only prints what it would do.
 *
 * Kuma has no external ID, so monitors are matched by name. Rename one in the
 * file and the next run sees a new monitor plus an orphan (removed by --prune).
 */

import { KUMA_FIELDS, monitorName, type Config, type Group, type MonitorDef, type MonitorFields } from "./config.ts";
import { sleep, type KumaMonitor, type KumaSession } from "./kuma.ts";

/** Small pause between writes: each one restarts a monitor on the server. */
const WRITE_DELAY_MS = 100;

/** Fields the server expects even when we have nothing to say about them. */
const REQUIRED: MonitorFields = {
    accepted_statuscodes: ["200-299"],
    conditions: [],
    notificationIDList: {},
    parent: null,
    proxyId: null,
};

type Options = { apply: boolean; prune: boolean };
type Report = { created: string[]; updated: string[]; unchanged: number; orphans: string[] };

/**
 * The server runs `bean.import(monitor)` on whatever it receives: every key
 * becomes a column. So only known Kuma fields leave this tool, never our own
 * keys like `env`.
 */
function pick(fields: MonitorFields): MonitorFields {
    return Object.fromEntries(KUMA_FIELDS.filter((k) => k in fields).map((k) => [k, fields[k]]));
}

function desiredMonitor(config: Config, group: Group, monitor: MonitorDef, parent: number | null, notifications: Map<string, number>) {
    const env = config.environments[monitor.env];
    const notificationId = env.notification ? notifications.get(env.notification) : undefined;
    return pick({
        ...REQUIRED,
        type: "http",
        ...config.defaults,
        ...env.overrides,
        ...monitor,
        name: monitorName(group, monitor),
        parent,
        notificationIDList: notificationId ? { [notificationId]: true } : {},
    });
}

/** True when a field we manage differs from what Kuma has. */
function differs(existing: KumaMonitor, desired: MonitorFields): boolean {
    return Object.entries(desired).some(([key, value]) => {
        // Kuma returns {id: true} for linked notifications; compare the IDs.
        if (key === "notificationIDList") {
            const ids = (o: unknown) => Object.keys((o as object) ?? {}).filter((k) => (o as Record<string, boolean>)[k]).sort().join();
            return ids(existing[key]) !== ids(value);
        }
        return JSON.stringify(existing[key] ?? null) !== JSON.stringify(value ?? null);
    });
}

async function upsert(kuma: KumaSession, desired: MonitorFields, opts: Options, report: Report): Promise<number | null> {
    const name = desired.name as string;
    const existing = Object.values(kuma.monitors()).find((m) => m.name === name);

    if (!existing) {
        report.created.push(name);
        if (!opts.apply) return null;
        const res = await kuma.emit("add", desired);
        if (!res.ok) throw new Error(`add "${name}": ${res.msg}`);
        await sleep(WRITE_DELAY_MS);
        return res.monitorID as number;
    }

    if (!differs(existing, desired)) {
        report.unchanged++;
        return existing.id;
    }

    report.updated.push(name);
    if (opts.apply) {
        // editMonitor overwrites every column with what it receives, so a
        // partial object would blank the fields we don't manage. Send the full
        // monitor with our changes on top.
        const res = await kuma.emit("editMonitor", { ...existing, ...desired, id: existing.id });
        if (!res.ok) throw new Error(`editMonitor "${name}": ${res.msg}`);
        await sleep(WRITE_DELAY_MS);
    }
    return existing.id;
}

async function applyNotifications(kuma: KumaSession, config: Config, opts: Options): Promise<Map<string, number>> {
    const ids = new Map<string, number>();
    for (const def of config.notifications) {
        const existing = kuma.notifications().find((n) => n.name === def.name);
        const webhook = process.env[def.webhookEnv];
        if (!webhook) {
            if (opts.apply) throw new Error(`${def.webhookEnv} is not set (notification "${def.name}")`);
            console.log(`  ! notification  ${def.name}: ${def.webhookEnv} not set`);
        }
        console.log(`  ${existing ? "~" : "+"} notification  ${def.name}`);
        if (existing) ids.set(def.key, existing.id);
        if (!opts.apply) continue;

        // A Discord mention is <@id>, or <@&id> for a role (write "&id" in .env).
        // Without the @, Discord prints the number and pings nobody.
        const mentions = (def.mentionsEnv ? process.env[def.mentionsEnv] ?? "" : "")
            .split(",").map((s) => s.trim()).filter(Boolean)
            .map((id) => `<@${id}>`);

        const res = await kuma.emit("addNotification", {
            type: def.type,
            name: def.name,
            isDefault: false,
            applyExisting: false,
            discordWebhookUrl: webhook,
            // Sent next to the embed. A custom message template would replace
            // the embed (service name, URL, time, ping) with plain text.
            discordPrefixMessage: mentions.join(" "),
            discordMessageFormat: "normal",
            discordChannelType: "channel",
        }, existing?.id ?? null);
        if (!res.ok) throw new Error(`addNotification "${def.name}": ${res.msg}`);
        ids.set(def.key, res.id as number);
        await sleep(WRITE_DELAY_MS);
    }
    return ids;
}

export async function apply(kuma: KumaSession, config: Config, opts: Options) {
    const report: Report = { created: [], updated: [], unchanged: 0, orphans: [] };
    console.log(opts.apply ? "Applying.\n" : "Plan only: nothing is written. Use `apply` to write.\n");

    const notifications = await applyNotifications(kuma, config, opts);

    // Groups first: monitors need their group's ID as `parent`.
    const groupIds = new Map<string, number | null>();
    for (const group of config.groups) {
        if (!group.monitors.length) continue;
        const id = await upsert(kuma, pick({
            ...REQUIRED,
            type: "group",
            name: group.name,
            description: group.description ?? "",
            interval: config.defaults.interval ?? 60,
            retryInterval: config.defaults.retryInterval ?? 60,
            active: true,
        }), opts, report);
        groupIds.set(group.name, id);
    }

    for (const group of config.groups) {
        for (const monitor of group.monitors) {
            const parent = groupIds.get(group.name) ?? null;
            await upsert(kuma, desiredMonitor(config, group, monitor, parent, notifications), opts, report);
        }
    }

    const wanted = new Set(config.groups.flatMap((g) => [g.name, ...g.monitors.map((m) => monitorName(g, m))]));
    const orphans = Object.values(kuma.monitors()).filter((m) => !wanted.has(m.name));
    for (const orphan of orphans) {
        report.orphans.push(orphan.name);
        if (opts.apply && opts.prune) {
            // deleteChildren=false: never take a monitor down with a group.
            const res = await kuma.emit("deleteMonitor", orphan.id, false);
            if (!res.ok) throw new Error(`deleteMonitor "${orphan.name}": ${res.msg}`);
            await sleep(WRITE_DELAY_MS);
        }
    }

    const list = (label: string, names: string[]) =>
        names.length && console.log(`\n${label} (${names.length})\n${names.map((n) => `   ${n}`).join("\n")}`);
    list(opts.apply ? "Created" : "To create", report.created);
    list(opts.apply ? "Updated" : "To update", report.updated);
    list(opts.prune && opts.apply ? "Deleted" : "Not in the file (use `prune` to delete)", report.orphans);
    console.log(`\nUnchanged: ${report.unchanged}`);
}
