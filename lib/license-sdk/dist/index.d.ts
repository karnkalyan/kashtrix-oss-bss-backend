export { generateHwid, generateBaseHardwareFingerprint, loadOrCreateClientId, loadOrCreateScopedClientId, } from "./hwid.js";
export type LicenseStateEvent = "LICENSE_REVOKED" | "LICENSE_SUSPENDED" | "LICENSE_EXPIRED" | "LICENSE_RESTORED" | "CLIENT_BANNED" | "TENANT_SUSPENDED" | "REVALIDATE_NOW" | "LICENSE_KEY_REISSUED";
export type LicenseSessionState = "DISCONNECTED" | "CONNECTING" | "LICENSED" | "DENIED";
export interface EntitlementSnapshot {
    tenantId: string;
    applicationId: string;
    clientId: string;
    licenseId: string;
    licenseSerial: string;
    customerName?: string;
    customerEmail?: string;
    validFrom: Date;
    expiresAt?: Date;
    maxActivations: number;
    appVersion?: string;
    platform?: string;
    modules: readonly string[];
    entitlements: Readonly<Record<string, boolean | number>>;
    entitlementVersion: number;
    validatedAt: Date;
}
export interface LicenseClientOptions {
    host: string;
    port?: number;
    licenseKey: string;
    clientId: string;
    tenantId: string;
    applicationId: string;
    appVersion?: string;
    platform?: string;
    hwid?: string;
    caPath: string;
    certPath?: string;
    keyPath?: string;
    publicLicenseKeyPath: string;
    servername?: string;
    expectedIssuer?: string;
    expectedAudience?: string;
    validationTimeoutMs?: number;
    onStateChange: (event: LicenseStateEvent, reason?: string) => void;
    onEntitlementsChanged?: (snapshot: EntitlementSnapshot) => void;
    onLicenseReady?: (licenseKey: string) => void;
    onConnectionLost?: (error: Error) => void;
}
export interface LicenseProvisioningClientOptions {
    host: string;
    port?: number;
    clientId: string;
    tenantId: string;
    applicationId: string;
    hwid: string;
    provisioningId: string;
    caPath: string;
    certPath?: string;
    keyPath?: string;
    servername?: string;
    onLicenseReady: (licenseKey: string) => void;
    onConnectionLost?: (error: Error) => void;
}
export declare class LicenseClient {
    private readonly options;
    private socket?;
    private heartbeat?;
    private watchdog?;
    private buffer;
    private lastSequence;
    private lastAckAt;
    private intentionalClose;
    private state;
    private snapshot?;
    private publicKey?;
    private licenseKey;
    private pendingEntitlements;
    constructor(options: LicenseClientOptions);
    getState(): LicenseSessionState;
    isLicensed(): boolean;
    getEntitlements(): EntitlementSnapshot | undefined;
    getModules(): readonly string[];
    hasModule(code: string): boolean;
    requireModule(code: string): void;
    getEntitlement(code: string): boolean | number | undefined;
    getLimit(code: string): number;
    requireEntitlement(code: string): boolean | number;
    setLicenseKey(reissuedKey: string): void;
    connect(): Promise<EntitlementSnapshot>;
    refreshEntitlements(timeoutMs?: number): Promise<EntitlementSnapshot>;
    private consume;
    private applySnapshot;
    private verifySignedEvent;
    private verifyEntitlementSnapshot;
    private startHeartbeat;
    private verifyAndApply;
    private connectionLost;
    close(intentional?: boolean): void;
}
export declare class LicenseProvisioningClient {
    private readonly options;
    private socket?;
    private heartbeat?;
    private buffer;
    private intentionalClose;
    constructor(options: LicenseProvisioningClientOptions);
    connect(): Promise<void>;
    private startHeartbeat;
    private connectionLost;
    close(intentional?: boolean): void;
}
/** Semantic alias for integrations that prefer a system/service naming style. */
export declare class LicenseSystem extends LicenseClient {
}
