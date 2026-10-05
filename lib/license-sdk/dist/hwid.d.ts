/** Internal privacy-preserving machine fingerprint. Do not transmit this value. */
export declare function generateBaseHardwareFingerprint(): Promise<string>;
/**
 * Public application-scoped HWID sent to the licensing server.
 * Same hardware + different tenant/application => deliberately different HWID.
 */
export declare function generateHwid(scope: {
    tenantId: string;
    applicationId: string;
}): Promise<string>;
export declare function loadOrCreateClientId(filePath: string): Promise<string>;
/** Makes it hard to accidentally reuse one installation id across applications. */
export declare function loadOrCreateScopedClientId(storageDir: string, tenantId: string, applicationId: string): Promise<string>;
