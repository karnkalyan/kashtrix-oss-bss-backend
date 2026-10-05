import { connect } from "node:tls";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { importSPKI, jwtVerify } from "jose";
import { generateHwid } from "./hwid.js";
export { generateHwid, generateBaseHardwareFingerprint, loadOrCreateClientId, loadOrCreateScopedClientId, } from "./hwid.js";
export class LicenseClient {
    options;
    socket;
    heartbeat;
    watchdog;
    buffer = "";
    lastSequence = 0;
    lastAckAt = 0;
    intentionalClose = false;
    state = "DISCONNECTED";
    snapshot;
    publicKey;
    licenseKey;
    pendingEntitlements = new Map();
    constructor(options) {
        this.options = options;
        this.licenseKey = options.licenseKey;
    }
    getState() {
        return this.state;
    }
    isLicensed() {
        return this.state === "LICENSED" && !!this.snapshot;
    }
    getEntitlements() {
        return this.snapshot
            ? {
                ...this.snapshot,
                validFrom: new Date(this.snapshot.validFrom),
                expiresAt: this.snapshot.expiresAt
                    ? new Date(this.snapshot.expiresAt)
                    : undefined,
                modules: [...this.snapshot.modules],
                entitlements: { ...this.snapshot.entitlements },
            }
            : undefined;
    }
    getModules() {
        return this.snapshot ? [...this.snapshot.modules] : [];
    }
    hasModule(code) {
        return (this.isLicensed() &&
            this.snapshot.modules.includes(code.trim().toUpperCase()));
    }
    requireModule(code) {
        if (!this.hasModule(code))
            throw new Error(`Module not licensed: ${code}`);
    }
    getEntitlement(code) {
        return this.isLicensed()
            ? this.snapshot.entitlements[code.trim().toUpperCase()]
            : undefined;
    }
    getLimit(code) {
        const value = this.getEntitlement(code);
        return typeof value === "number" ? value : 0;
    }
    requireEntitlement(code) {
        const value = this.getEntitlement(code);
        if (value !== true && !(typeof value === "number" && value > 0))
            throw new Error(`Entitlement not licensed: ${code}`);
        return value;
    }
    setLicenseKey(reissuedKey) {
        if (!reissuedKey || reissuedKey.length < 50)
            throw new Error("Invalid replacement license key");
        this.licenseKey = reissuedKey;
    }
    async connect() {
        this.close();
        this.intentionalClose = false;
        this.state = "CONNECTING";
        this.buffer = "";
        this.lastSequence = 0;
        this.snapshot = undefined;
        const [ca, cert, key, publicPem] = await Promise.all([
            readFile(this.options.caPath),
            this.options.certPath ? readFile(this.options.certPath) : undefined,
            this.options.keyPath ? readFile(this.options.keyPath) : undefined,
            readFile(this.options.publicLicenseKeyPath, "utf8"),
        ]);
        this.publicKey = await importSPKI(publicPem, "EdDSA");
        const tlsOptions = {
            host: this.options.host,
            port: this.options.port ?? 7443,
            ca: [ca],
            cert,
            key,
            minVersion: "TLSv1.3",
            rejectUnauthorized: true,
            servername: this.options.servername ?? this.options.host,
        };
        const hwid = this.options.hwid ??
            (await generateHwid({
                tenantId: this.options.tenantId,
                applicationId: this.options.applicationId,
            }));
        await new Promise((resolve, reject) => {
            let settled = false;
            const finish = (fn) => {
                if (!settled) {
                    settled = true;
                    clearTimeout(handshakeTimer);
                    fn();
                }
            };
            const fail = (error) => finish(() => reject(error));
            const ready = () => finish(resolve);
            const handshakeTimer = setTimeout(() => {
                fail(new Error("License handshake timed out"));
                socket.destroy();
            }, 15_000);
            const socket = connect(tlsOptions, () => {
                if (!socket.authorized) {
                    fail(new Error(socket.authorizationError?.message ?? "TLS authorization failed"));
                    socket.destroy();
                    return;
                }
                this.socket = socket;
                socket.write(JSON.stringify({
                    type: "HELLO",
                    protocol: 2,
                    clientId: this.options.clientId,
                    licenseKey: this.licenseKey,
                    tenantId: this.options.tenantId,
                    applicationId: this.options.applicationId,
                    hwid,
                    appVersion: this.options.appVersion,
                    platform: this.options.platform,
                }) + "\n");
            });
            socket.once("error", (error) => {
                if (!settled)
                    fail(error);
                else {
                    this.state = "DENIED";
                    this.connectionLost(error);
                    this.close(false);
                }
            });
            socket.on("data", (chunk) => {
                socket.pause();
                void this.consume(chunk.toString("utf8"), ready, fail).finally(() => {
                    if (!socket.destroyed)
                        socket.resume();
                });
            });
            socket.on("close", () => {
                if (!settled)
                    fail(new Error("License connection closed during handshake"));
                else if (!this.intentionalClose) {
                    const error = new Error("License connection closed");
                    this.state = "DENIED";
                    this.connectionLost(error);
                    this.close(false);
                }
            });
        });
        if (!this.snapshot)
            throw new Error("Server did not provide entitlements");
        return this.getEntitlements();
    }
    async refreshEntitlements(timeoutMs = 10_000) {
        if (!this.socket || !this.isLicensed())
            throw new Error("License client is not connected");
        const nonce = randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingEntitlements.delete(nonce);
                reject(new Error("Entitlement refresh timed out"));
            }, timeoutMs);
            this.pendingEntitlements.set(nonce, { resolve, reject, timer });
            this.socket.write(JSON.stringify({ type: "ENTITLEMENTS_REQUEST", nonce }) + "\n");
        });
    }
    async consume(chunk, ready, fail) {
        try {
            this.buffer += chunk;
            if (this.buffer.length > 64 * 1024)
                throw new Error("License server frame too large");
            let i;
            while ((i = this.buffer.indexOf("\n")) >= 0) {
                const line = this.buffer.slice(0, i).trim();
                this.buffer = this.buffer.slice(i + 1);
                if (!line)
                    continue;
                const msg = JSON.parse(line);
                if (msg.type === "WELCOME") {
                    if (msg.tenantId !== this.options.tenantId ||
                        msg.applicationId !== this.options.applicationId)
                        throw new Error("Server returned the wrong application namespace");
                    this.lastSequence = 0;
                    this.lastAckAt = Date.now();
                    this.state = "LICENSED";
                    this.applySnapshot(msg.licenseId, msg.modules, msg.entitlements, msg.entitlementVersion, {
                        licenseSerial: msg.licenseSerial,
                        customerName: msg.customerName,
                        customerEmail: msg.customerEmail,
                        validFrom: msg.validFrom,
                        expiresAt: msg.expiresAt,
                        maxActivations: msg.maxActivations,
                        appVersion: msg.appVersion,
                        platform: msg.platform,
                    });
                    this.startHeartbeat(msg.heartbeatSeconds ?? 30);
                    ready?.();
                }
                else if (msg.type === "HEARTBEAT_ACK") {
                    this.lastAckAt = Date.now();
                    if (this.snapshot &&
                        Number.isInteger(msg.entitlementVersion) &&
                        msg.entitlementVersion !== this.snapshot.entitlementVersion)
                        void this.refreshEntitlements().catch((error) => this.connectionLost(error));
                }
                else if (msg.type === "ENTITLEMENTS") {
                    await this.verifyEntitlementSnapshot(msg);
                }
                else if (msg.type === "LICENSE_EVENT") {
                    await this.verifyAndApply(msg.event, msg.signedEvent);
                }
                else if (msg.type === "LICENSE_READY") {
                    if (typeof msg.licenseKey !== "string" || msg.licenseKey.length < 50)
                        throw new Error("Invalid remotely delivered license");
                    this.options.onLicenseReady?.(msg.licenseKey);
                }
                else if (msg.type === "ERROR" && msg.fatal) {
                    const error = new Error(msg.message ?? "License protocol error");
                    this.state = "DENIED";
                    fail?.(error);
                    this.connectionLost(error);
                    this.close(false);
                }
            }
        }
        catch (error) {
            const err = error instanceof Error
                ? error
                : new Error("Invalid license server message");
            this.state = "DENIED";
            fail?.(err);
            this.connectionLost(err);
            this.close(false);
        }
    }
    applySnapshot(licenseId, modules, entitlements, entitlementVersion, details) {
        if (!Array.isArray(modules) ||
            modules.some((x) => typeof x !== "string") ||
            !entitlements ||
            typeof entitlements !== "object" ||
            Array.isArray(entitlements) ||
            Object.values(entitlements).some((value) => typeof value !== "boolean" &&
                !(typeof value === "number" && Number.isInteger(value) && value >= 0)) ||
            !Number.isInteger(entitlementVersion))
            throw new Error("Invalid entitlement snapshot");
        const current = this.snapshot;
        const licenseSerial = details?.licenseSerial ?? current?.licenseSerial;
        const validFromValue = details?.validFrom ?? current?.validFrom;
        const expiresAtValue = details?.expiresAt ?? current?.expiresAt;
        const maxActivations = details?.maxActivations ?? current?.maxActivations;
        const validFrom = validFromValue instanceof Date
            ? new Date(validFromValue)
            : new Date(String(validFromValue ?? ""));
        const expiresAt = expiresAtValue
            ? expiresAtValue instanceof Date
                ? new Date(expiresAtValue)
                : new Date(String(expiresAtValue))
            : undefined;
        if (typeof licenseSerial !== "string" ||
            !licenseSerial.trim() ||
            Number.isNaN(validFrom.getTime()) ||
            (expiresAt && Number.isNaN(expiresAt.getTime())) ||
            !Number.isInteger(maxActivations) ||
            Number(maxActivations) < 1)
            throw new Error("Invalid license information snapshot");
        const snapshot = {
            tenantId: this.options.tenantId,
            applicationId: this.options.applicationId,
            clientId: this.options.clientId,
            licenseId,
            licenseSerial: licenseSerial.trim(),
            customerName: typeof details?.customerName === "string"
                ? details.customerName
                : current?.customerName,
            customerEmail: typeof details?.customerEmail === "string"
                ? details.customerEmail
                : current?.customerEmail,
            validFrom,
            expiresAt,
            maxActivations: Number(maxActivations),
            appVersion: typeof details?.appVersion === "string"
                ? details.appVersion
                : current?.appVersion,
            platform: typeof details?.platform === "string"
                ? details.platform
                : current?.platform,
            modules: [...new Set(modules.map((x) => x.toUpperCase()))].sort(),
            entitlements: Object.fromEntries(Object.entries(entitlements)
                .map(([code, value]) => [code.toUpperCase(), value])
                .sort(([a], [b]) => a.localeCompare(b))),
            entitlementVersion: Number(entitlementVersion),
            validatedAt: new Date(),
        };
        this.snapshot = snapshot;
        this.options.onEntitlementsChanged?.(this.getEntitlements());
    }
    async verifySignedEvent(event, signedEvent) {
        if (!this.publicKey)
            throw new Error("License public key not loaded");
        const { payload } = await jwtVerify(signedEvent, this.publicKey, {
            algorithms: ["EdDSA"],
            issuer: this.options.expectedIssuer ?? "secure-license-manager",
            audience: this.options.expectedAudience ?? "licensed-app",
        });
        if (payload.typ !== "license-state" ||
            payload.cid !== this.options.clientId ||
            payload.ten !== this.options.tenantId ||
            payload.app !== this.options.applicationId ||
            payload.evt !== event)
            throw new Error("Invalid signed license event");
        if (this.snapshot && payload.lid !== this.snapshot.licenseId)
            throw new Error("Signed event belongs to another license");
        const seq = Number(payload.seq);
        if (!Number.isInteger(seq) || seq <= this.lastSequence)
            throw new Error("Replayed/out-of-order state event");
        this.lastSequence = seq;
        return payload;
    }
    async verifyEntitlementSnapshot(msg) {
        const payload = await this.verifySignedEvent("ENTITLEMENTS_SNAPSHOT", msg.signedEvent);
        if (!Array.isArray(payload.mod) ||
            payload.mod.some((x) => typeof x !== "string") ||
            !payload.ent ||
            typeof payload.ent !== "object" ||
            Array.isArray(payload.ent) ||
            typeof payload.ev !== "number" ||
            !Number.isInteger(payload.ev))
            throw new Error("Signed entitlement claims are invalid");
        const wireModules = [...msg.modules]
            .map((x) => x.toUpperCase())
            .sort();
        const signedModules = [...payload.mod]
            .map((x) => String(x).toUpperCase())
            .sort();
        const wireEntitlements = Object.fromEntries(Object.entries(msg.entitlements || {}).sort(([a], [b]) => a.localeCompare(b)));
        const signedEntitlements = Object.fromEntries(Object.entries(payload.ent).sort(([a], [b]) => a.localeCompare(b)));
        if (JSON.stringify(wireModules) !== JSON.stringify(signedModules) ||
            JSON.stringify(wireEntitlements) !== JSON.stringify(signedEntitlements) ||
            Number(msg.entitlementVersion) !== Number(payload.ev))
            throw new Error("Entitlement response does not match signed snapshot");
        this.applySnapshot(String(payload.lid), wireModules, wireEntitlements, Number(payload.ev));
        const pending = this.pendingEntitlements.get(msg.nonce);
        if (pending) {
            clearTimeout(pending.timer);
            this.pendingEntitlements.delete(msg.nonce);
            pending.resolve(this.getEntitlements());
        }
    }
    startHeartbeat(seconds) {
        clearInterval(this.heartbeat);
        clearInterval(this.watchdog);
        const intervalMs = Math.max(10, seconds) * 1000;
        const validationTimeout = Math.max(intervalMs * 2, this.options.validationTimeoutMs ?? 75_000);
        this.heartbeat = setInterval(() => {
            this.socket?.write(JSON.stringify({
                type: "HEARTBEAT",
                ts: Date.now(),
                nonce: randomUUID(),
            }) + "\n");
        }, intervalMs);
        this.watchdog = setInterval(() => {
            if (Date.now() - this.lastAckAt > validationTimeout) {
                const error = new Error("Online license validation timed out");
                this.state = "DENIED";
                this.connectionLost(error);
                this.close(false);
            }
        }, Math.min(5_000, intervalMs));
    }
    async verifyAndApply(event, signedEvent) {
        const payload = await this.verifySignedEvent(event, signedEvent);
        const isTerminal = event === "LICENSE_REVOKED" ||
            event === "LICENSE_SUSPENDED" ||
            event === "LICENSE_EXPIRED" ||
            event === "CLIENT_BANNED" ||
            event === "TENANT_SUSPENDED";
        if (!isTerminal &&
            Array.isArray(payload.mod) &&
            payload.ent &&
            typeof payload.ent === "object" &&
            Number.isInteger(payload.ev)) {
            const licId = String(payload.lid || this.snapshot?.licenseId || "");
            if (licId) {
                this.applySnapshot(licId, payload.mod, payload.ent, Number(payload.ev));
            }
        }
        if (isTerminal) {
            this.snapshot = undefined;
            this.state = "DENIED";
        }
        else if (event === "LICENSE_RESTORED") {
            this.state = "LICENSED";
        }
        this.options.onStateChange(event, typeof payload.reason === "string" ? payload.reason : undefined);
        if (event === "REVALIDATE_NOW") {
            void this.refreshEntitlements().catch((error) => this.connectionLost(error));
            return;
        }
        if (event === "LICENSE_KEY_REISSUED")
            return;
        if (isTerminal) {
            this.close(false);
        }
    }
    connectionLost(error) {
        clearInterval(this.heartbeat);
        clearInterval(this.watchdog);
        this.options.onConnectionLost?.(error);
    }
    close(intentional = true) {
        this.intentionalClose = intentional;
        clearInterval(this.heartbeat);
        clearInterval(this.watchdog);
        for (const pending of this.pendingEntitlements.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error("License connection closed"));
        }
        this.pendingEntitlements.clear();
        const socket = this.socket;
        this.socket = undefined;
        if (intentional && this.state !== "DENIED")
            this.state = "DISCONNECTED";
        if (socket) {
            socket.removeAllListeners();
            socket.destroy();
        }
    }
}
export class LicenseProvisioningClient {
    options;
    socket;
    heartbeat;
    buffer = "";
    intentionalClose = false;
    constructor(options) {
        this.options = options;
    }
    async connect() {
        this.close();
        this.intentionalClose = false;
        this.buffer = "";
        const [ca, cert, key] = await Promise.all([
            readFile(this.options.caPath),
            this.options.certPath ? readFile(this.options.certPath) : undefined,
            this.options.keyPath ? readFile(this.options.keyPath) : undefined,
        ]);
        await new Promise((resolve, reject) => {
            let settled = false;
            const finish = (fn) => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    fn();
                }
            };
            const fail = (error) => finish(() => reject(error));
            const ready = () => finish(resolve);
            const timer = setTimeout(() => {
                fail(new Error("Provisioning handshake timed out"));
                socket.destroy();
            }, 15_000);
            const socket = connect({
                host: this.options.host,
                port: this.options.port ?? 7443,
                ca: [ca],
                cert,
                key,
                minVersion: "TLSv1.3",
                rejectUnauthorized: true,
                servername: this.options.servername ?? this.options.host,
            }, () => {
                if (!socket.authorized) {
                    fail(new Error(socket.authorizationError?.message ??
                        "TLS authorization failed"));
                    socket.destroy();
                    return;
                }
                this.socket = socket;
                socket.write(JSON.stringify({
                    type: "PROVISION",
                    protocol: 2,
                    clientId: this.options.clientId,
                    tenantId: this.options.tenantId,
                    applicationId: this.options.applicationId,
                    hwid: this.options.hwid,
                    provisioningId: this.options.provisioningId,
                }) + "\n");
            });
            socket.on("data", (chunk) => {
                try {
                    this.buffer += chunk.toString("utf8");
                    if (this.buffer.length > 64 * 1024)
                        throw new Error("Provisioning server frame too large");
                    let index;
                    while ((index = this.buffer.indexOf("\n")) >= 0) {
                        const line = this.buffer.slice(0, index).trim();
                        this.buffer = this.buffer.slice(index + 1);
                        if (!line)
                            continue;
                        const message = JSON.parse(line);
                        if (message.type === "PROVISIONING_WAIT") {
                            this.startHeartbeat();
                            ready();
                        }
                        else if (message.type === "LICENSE_READY") {
                            if (typeof message.licenseKey !== "string" ||
                                message.licenseKey.length < 50)
                                throw new Error("Invalid remotely delivered license");
                            const delivered = message.licenseKey;
                            this.close();
                            this.options.onLicenseReady(delivered);
                        }
                        else if (message.type === "ERROR" && message.fatal)
                            throw new Error(message.message || "Provisioning rejected");
                    }
                }
                catch (error) {
                    const failure = error instanceof Error
                        ? error
                        : new Error("Invalid provisioning response");
                    fail(failure);
                    this.connectionLost(failure);
                    this.close(false);
                }
            });
            socket.once("error", (error) => {
                if (!settled)
                    fail(error);
                else
                    this.connectionLost(error);
            });
            socket.on("close", () => {
                if (!settled)
                    fail(new Error("Provisioning connection closed during handshake"));
                else if (!this.intentionalClose)
                    this.connectionLost(new Error("Provisioning connection closed"));
            });
        });
    }
    startHeartbeat() {
        clearInterval(this.heartbeat);
        this.heartbeat = setInterval(() => this.socket?.write(JSON.stringify({ type: "PROVISION_HEARTBEAT", ts: Date.now() }) +
            "\n"), 30_000);
    }
    connectionLost(error) {
        clearInterval(this.heartbeat);
        if (!this.intentionalClose)
            this.options.onConnectionLost?.(error);
    }
    close(intentional = true) {
        this.intentionalClose = intentional;
        clearInterval(this.heartbeat);
        const socket = this.socket;
        this.socket = undefined;
        if (socket) {
            socket.removeAllListeners();
            socket.destroy();
        }
    }
}
/** Semantic alias for integrations that prefer a system/service naming style. */
export class LicenseSystem extends LicenseClient {
}
