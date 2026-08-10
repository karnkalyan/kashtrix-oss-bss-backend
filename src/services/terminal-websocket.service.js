const { Client } = require("ssh2");
const { randomUUID } = require("crypto");
const {
  loadCredentials
} = require("./device-management/device-credential.service");

class TerminalWebSocketService {
  constructor(manager, prisma) {
    this.manager = manager;
    this.prisma = prisma;

    /*
     * clientId => {
     *   sessionId,
     *   sshClient,
     *   sshStream,
     *   connecting,
     *   connected,
     *   closing,
     *   host,
     *   port,
     *   username,
     *   deviceType,
     *   terminalType,
     *   cols,
     *   rows
     * }
     */
    this.terminalSessions = new Map();
  }

  async handle(clientId, message = {}) {
    const type = String(message.type || "");
    const shouldLogMessage =
      type !== "terminal:input" &&
      type !== "input" &&
      type !== "terminal:resize" &&
      type !== "resize";

    if (shouldLogMessage) console.log(
      `🖥️ [Terminal] Handling "${type}" for client ${clientId}`
    );

    try {
      switch (type) {
        case "terminal:connect":
        case "connect":
          await this.connectTerminal(clientId, message);
          break;

        case "terminal:input":
        case "input":
          this.sendInput(clientId, message);
          break;

        case "terminal:resize":
        case "resize":
          this.resizeTerminal(clientId, message);
          break;

        case "terminal:disconnect":
        case "disconnect":
          this.disconnectTerminal(clientId, {
            sendStatus: true,
            message: "Terminal disconnected."
          });
          break;

        default:
          console.warn(
            `🖥️ [Terminal] Unsupported message type: ${type}`
          );
      }
    } catch (error) {
      console.error(
        `🖥️ [Terminal] Handler error for ${clientId}:`,
        error
      );

      this.sendError(
        clientId,
        `Terminal error: ${error.message}`
      );
    }
  }

  getPayload(message = {}) {
    if (
      message.data &&
      typeof message.data === "object" &&
      !Array.isArray(message.data)
    ) {
      return message.data;
    }

    return message;
  }

  sendStatus(clientId, status, message) {
    try {
      this.manager.sendToClient(
        clientId,
        "terminal:status",
        {
          status,
          message
        }
      );
    } catch (error) {
      console.error(
        "Could not send terminal status:",
        error.message
      );
    }
  }

  sendOutput(clientId, data) {
    if (data === null || data === undefined) {
      return;
    }

    try {
      this.manager.sendToClient(
        clientId,
        "terminal:output",
        {
          data: String(data)
        }
      );
    } catch (error) {
      console.error(
        "Could not send terminal output:",
        error.message
      );
    }
  }

  sendError(clientId, message) {
    this.sendStatus(
      clientId,
      "error",
      message
    );

    try {
      this.manager.sendToClient(
        clientId,
        "error",
        {
          message
        }
      );
    } catch (error) {
      console.error(
        "Could not send terminal error:",
        error.message
      );
    }
  }

  getOltModel() {
    return (
      this.prisma?.oLT ||
      this.prisma?.olt ||
      null
    );
  }

  getDeviceModel() {
    return (
      this.prisma?.managedDevice ||
      this.prisma?.device ||
      null
    );
  }

  async hydrateDeviceCredentials(device) {
    if (!device?.id || !this.prisma) {
      return device;
    }

    try {
      const credentials =
        await loadCredentials(
          this.prisma,
          device.id
        );

      return {
        ...device,
        ...credentials
      };
    } catch (error) {
      console.error(
        "[Terminal DB] Managed device credentials could not be loaded:",
        error.message
      );

      throw error;
    }
  }

  normalizeResourceType(value) {
    const resourceType =
      String(value || "")
        .trim()
        .toLowerCase();

    if (
      [
        "managed-device",
        "managed_device",
        "device",
        "network-device"
      ].includes(resourceType)
    ) {
      return "managed-device";
    }

    if (
      [
        "olt",
        "legacy-olt",
        "fiber-olt"
      ].includes(resourceType)
    ) {
      return "olt";
    }

    return "";
  }

  recordMatchesHost(record, host, type) {
    const expected =
      String(host || "").trim();

    if (!record || !expected) {
      return false;
    }

    const values =
      type === "olt"
        ? [
          record.sshHost,
          record.ipAddress,
          record.host
        ]
        : [
          record.sshHost,
          record.host,
          record.ipAddress
        ];

    return values.some(
      (value) =>
        String(value || "").trim() ===
        expected
    );
  }

  async findDeviceById(
    deviceId,
    options = {}
  ) {
    const numericId = Number(deviceId);
    const resourceType =
      this.normalizeResourceType(
        options.resourceType
      );

    if (!Number.isInteger(numericId)) {
      return {
        olt: null,
        device: null
      };
    }

    const oltModel = this.getOltModel();
    const deviceModel = this.getDeviceModel();

    let olt = null;
    let device = null;

    if (
      oltModel &&
      resourceType !== "managed-device"
    ) {
      olt = await oltModel
        .findFirst({
          where: {
            id: numericId,
            isDeleted: false
          }
        })
        .catch((error) => {
          console.error(
            "[Terminal DB] OLT ID lookup failed:",
            error.message
          );

          return null;
        });
    }

    if (
      deviceModel &&
      resourceType !== "olt"
    ) {
      device = await deviceModel
        .findFirst({
          where: {
            id: numericId,
            isDeleted: false
          }
        })
        .catch((error) => {
          console.error(
            "[Terminal DB] Device ID lookup failed:",
            error.message
          );

          return null;
        });

    }

    /*
     * IDs from ManagedDevice and the legacy OLT table are independent.
     * Never choose one merely because it was queried first. Older clients
     * that do not send a resource type may only proceed when the supplied
     * host selects exactly one of the colliding records.
     */
    if (
      !resourceType &&
      olt &&
      device
    ) {
      const oltMatches =
        this.recordMatchesHost(
          olt,
          options.host,
          "olt"
        );

      const deviceMatches =
        this.recordMatchesHost(
          device,
          options.host,
          "managed-device"
        );

      if (
        deviceMatches &&
        !oltMatches
      ) {
        olt = null;
      } else if (
        oltMatches &&
        !deviceMatches
      ) {
        device = null;
      } else {
        console.error(
          "[Terminal DB] Ambiguous terminal ID rejected:",
          {
            id: numericId,
            requestedHost:
              options.host || null
          }
        );

        return {
          olt: null,
          device: null,
          ambiguous: true
        };
      }
    }

    if (device) {
      device =
        await this.hydrateDeviceCredentials(
          device
        );
    }

    return {
      olt,
      device
    };
  }

  async findDeviceByHost(
    host,
    options = {}
  ) {
    if (!host) {
      return {
        olt: null,
        device: null
      };
    }

    const oltModel = this.getOltModel();
    const deviceModel = this.getDeviceModel();
    const resourceType =
      this.normalizeResourceType(
        options.resourceType
      );

    let olt = null;
    let device = null;

    if (
      oltModel &&
      resourceType !== "managed-device"
    ) {
      olt = await oltModel
        .findFirst({
          where: {
            isDeleted: false,
            OR: [
              {
                ipAddress: host
              },
              {
                sshHost: host
              }
            ]
          }
        })
        .catch((error) => {
          console.error(
            "[Terminal DB] OLT host lookup failed:",
            error.message
          );

          return null;
        });
    }

    if (
      deviceModel &&
      resourceType !== "olt"
    ) {
      /*
       * Remove fields from this OR array if they do not exist
       * in your Prisma Device model.
       */
      device = await deviceModel
        .findFirst({
          where: {
            isDeleted: false,
            OR: [
              {
                ipAddress: host
              },
              {
                host
              }
            ]
          }
        })
        .catch((error) => {
          console.error(
            "[Terminal DB] Device host lookup failed:",
            error.message
          );

          return null;
        });

    }

    if (
      !resourceType &&
      olt &&
      device
    ) {
      console.error(
        "[Terminal DB] Ambiguous terminal host rejected:",
        {
          host
        }
      );

      return {
        olt: null,
        device: null,
        ambiguous: true
      };
    }

    if (device) {
      device =
        await this.hydrateDeviceCredentials(
          device
        );
    }

    return {
      olt,
      device
    };
  }

  extractCredential(record, fieldNames) {
    for (const fieldName of fieldNames) {
      const value = record?.[fieldName];

      if (
        value !== null &&
        value !== undefined
      ) {
        return String(value);
      }
    }

    return "";
  }

  resolveOltRecord(olt, current) {
    const host =
      this.extractCredential(
        olt,
        [
          "sshHost",
          "ipAddress",
          "host"
        ]
      ) || current.host;

    const rawPort =
      olt?.sshPort ??
      olt?.port ??
      current.port ??
      22;

    const port =
      Number(rawPort) || 22;

    const username =
      this.extractCredential(
        olt,
        [
          "sshUsername",
          "username",
          "loginUsername",
          "userName"
        ]
      ) || current.username;

    let password = current.password;

    const databasePassword =
      this.extractCredential(
        olt,
        [
          "sshPassword",
          "password",
          "loginPassword"
        ]
      );

    if (databasePassword !== "") {
      password = databasePassword;
    }

    const deviceType =
      this.extractCredential(
        olt,
        [
          "vendor",
          "manufacturer",
          "brand",
          "deviceType",
          "type"
        ]
      ) ||
      current.deviceType ||
      "huawei";

    const requestedTerm =
      this.extractCredential(
        olt,
        [
          "terminalType",
          "sshTerminalType"
        ]
      ) || current.requestedTerm;

    return {
      ...current,
      host,
      port,
      username,
      password,
      deviceType: deviceType.toLowerCase(),
      requestedTerm
    };
  }

  resolveDeviceRecord(device, current) {
    const host =
      this.extractCredential(
        device,
        [
          "sshHost",
          "host",
          "ipAddress"
        ]
      ) || current.host;

    const rawPort =
      device?.sshPort ??
      device?.port ??
      current.port ??
      22;

    const port =
      Number(rawPort) || 22;

    const username =
      this.extractCredential(
        device,
        [
          "sshUsername",
          "username",
          "loginUsername",
          "userName"
        ]
      ) || current.username;

    let password = current.password;

    const databasePassword =
      this.extractCredential(
        device,
        [
          "sshPassword",
          "password",
          "loginPassword"
        ]
      );

    if (databasePassword !== "") {
      password = databasePassword;
    }

    const deviceType =
      this.extractCredential(
        device,
        [
          "vendor",
          "manufacturer",
          "brand",
          "deviceType",
          "type"
        ]
      ) ||
      current.deviceType ||
      "other";

    const requestedTerm =
      this.extractCredential(
        device,
        [
          "terminalType",
          "sshTerminalType"
        ]
      ) || current.requestedTerm;

    return {
      ...current,
      host,
      port,
      username,
      password,
      deviceType: deviceType.toLowerCase(),
      requestedTerm
    };
  }

  async resolveConnectionDetails(message) {
    const payload = this.getPayload(message);

    let connection = {
      deviceId:
        payload.deviceId ??
        message.deviceId ??
        null,

      resourceType:
        this.normalizeResourceType(
          payload.resourceType ??
          message.resourceType ??
          payload.resourceKind ??
          message.resourceKind
        ),

      host: String(
        payload.host ??
        message.host ??
        ""
      ).trim(),

      port:
        Number(
          payload.port ??
          message.port ??
          22
        ) || 22,

      username: String(
        payload.username ??
        message.username ??
        ""
      ).trim(),

      password:
        payload.password !== undefined
          ? String(payload.password)
          : message.password !== undefined
            ? String(message.password)
            : "",

      deviceType: String(
        payload.deviceType ??
        message.deviceType ??
        payload.vendor ??
        message.vendor ??
        ""
      ).toLowerCase(),

      requestedTerm: String(
        payload.term ??
        message.term ??
        ""
      ).trim()
    };

    if (!this.prisma) {
      return connection;
    }

    let olt = null;
    let device = null;

    if (
      connection.deviceId !== null &&
      connection.deviceId !== undefined &&
      String(connection.deviceId).trim() !== ""
    ) {
      const result =
        await this.findDeviceById(
          connection.deviceId,
          {
            resourceType:
              connection.resourceType,
            host:
              connection.host
          }
        );

      olt = result.olt;
      device = result.device;
    }

    if (
      !olt &&
      !device &&
      connection.host
    ) {
      const result =
        await this.findDeviceByHost(
          connection.host,
          {
            resourceType:
              connection.resourceType
          }
        );

      olt = result.olt;
      device = result.device;
    }

    if (olt) {
      connection =
        this.resolveOltRecord(
          olt,
          connection
        );

      console.log(
        "[Terminal DB] OLT resolved:",
        {
          id: olt.id,
          name: olt.name || null,
          host: connection.host,
          port: connection.port,
          usernameFound:
            Boolean(connection.username),
          passwordFound:
            connection.password.length > 0,
          deviceType:
            connection.deviceType
        }
      );
    } else if (device) {
      connection =
        this.resolveDeviceRecord(
          device,
          connection
        );

      console.log(
        "[Terminal DB] Device resolved:",
        {
          id: device.id,
          name:
            device.name || null,
          host: connection.host,
          port: connection.port,
          usernameFound:
            Boolean(connection.username),
          passwordFound:
            connection.password.length > 0,
          deviceType:
            connection.deviceType
        }
      );
    } else {
      console.warn(
        "[Terminal DB] No matching OLT or device found:",
        {
          deviceId:
            connection.deviceId,
          host:
            connection.host || null
        }
      );
    }

    return connection;
  }

  determineTerminalType(
    deviceType,
    requestedTerm
  ) {
    const type = String(
      deviceType || ""
    ).toLowerCase();

    const isHuawei =
      type.includes("huawei") ||
      type.includes("ma560") ||
      type.includes("ma580") ||
      type.includes("olt");

    /*
     * The browser is an xterm terminal, and Huawei MA56xx/MA58xx line
     * editing works correctly when the SSH PTY advertises the same type.
     * Advertising vt100 while sending xterm key sequences can cause the
     * Huawei CLI to lose spaces and other editing keys.
     */
    if (isHuawei) {
      return "xterm-256color";
    }

    return requestedTerm || "xterm-256color";
  }

  isCurrentSession(
    clientId,
    sessionId
  ) {
    const session =
      this.terminalSessions.get(clientId);

    return Boolean(
      session &&
      session.sessionId === sessionId &&
      !session.closing
    );
  }

  async connectTerminal(
    clientId,
    message
  ) {
    const payload = this.getPayload(message);

    const connection =
      await this.resolveConnectionDetails(
        message
      );

    const {
      host,
      port,
      username,
      password,
      deviceId,
      deviceType,
      requestedTerm
    } = connection;

    /*
     * Validation occurs after Prisma lookup.
     */
    if (!host) {
      this.sendError(
        clientId,
        deviceId
          ? "SSH host was not found in the device record."
          : "Device ID or SSH host is required."
      );

      return;
    }

    if (!username) {
      this.sendError(
        clientId,
        deviceId
          ? "SSH username was not found in the device record."
          : "SSH username is required."
      );

      return;
    }

    if (!password) {
      this.sendError(
        clientId,
        deviceId
          ? "SSH password was not found in the device record."
          : "SSH password is required."
      );

      return;
    }

    this.disconnectTerminal(
      clientId,
      {
        sendStatus: false
      }
    );

    const cols = Math.max(
      40,
      Number(
        payload.cols ??
        message.cols ??
        120
      ) || 120
    );

    const rows = Math.max(
      10,
      Number(
        payload.rows ??
        message.rows ??
        30
      ) || 30
    );

    const terminalType =
      this.determineTerminalType(
        deviceType,
        requestedTerm
      );

    const sessionId = randomUUID();
    const sshClient = new Client();

    const session = {
      sessionId,
      sshClient,
      sshStream: null,
      connecting: true,
      connected: false,
      closing: false,
      host,
      port,
      username,
      deviceType,
      terminalType,
      cols,
      rows,
      secondaryAuthBuffer: "",
      secondaryUsernameSent: false,
      secondaryPasswordSent: false
    };

    this.terminalSessions.set(
      clientId,
      session
    );

    this.sendStatus(
      clientId,
      "connecting",
      `Connecting to ${username}@${host}:${port}...`
    );

    console.log(
      `🖥️ [Terminal] Connecting ${username}@${host}:${port}, term=${terminalType}`
    );

    let keyboardAttempts = 0;

    sshClient.on(
      "keyboard-interactive",
      (
        name,
        instructions,
        language,
        prompts,
        finish
      ) => {
        if (
          !this.isCurrentSession(
            clientId,
            sessionId
          )
        ) {
          finish([]);
          return;
        }

        keyboardAttempts += 1;

        if (keyboardAttempts > 3) {
          finish([]);
          return;
        }

        finish(
          (prompts || []).map(
            () => password
          )
        );
      }
    );

    sshClient.on(
      "banner",
      (banner) => {
        if (
          !this.isCurrentSession(
            clientId,
            sessionId
          )
        ) {
          return;
        }

        this.sendOutput(
          clientId,
          banner.toString("utf8")
        );
      }
    );

    sshClient.on(
      "ready",
      () => {
        if (
          !this.isCurrentSession(
            clientId,
            sessionId
          )
        ) {
          try {
            sshClient.end();
          } catch { }

          return;
        }

        session.connecting = false;

        /*
         * Interactive device shells are latency-sensitive. Disabling Nagle on
         * the underlying socket keeps individual keystrokes responsive.
         */
        try {
          sshClient._sock?.setNoDelay?.(true);
        } catch { }

        sshClient.shell(
          {
            term: terminalType,
            cols,
            rows
          },
          (error, stream) => {
            if (
              !this.isCurrentSession(
                clientId,
                sessionId
              )
            ) {
              try {
                stream?.end();
              } catch { }

              try {
                sshClient.end();
              } catch { }

              return;
            }

            if (error) {
              this.sendError(
                clientId,
                `Could not open terminal: ${error.message}`
              );

              this.disconnectTerminal(
                clientId,
                {
                  sendStatus: false,
                  expectedSessionId:
                    sessionId
                }
              );

              return;
            }

            session.sshStream = stream;
            session.connected = true;

            this.sendStatus(
              clientId,
              "connected",
              `SSH connected to ${host}:${port}`
            );

            stream.on(
              "data",
              (chunk) => {
                if (
                  !this.isCurrentSession(
                    clientId,
                    sessionId
                  )
                ) {
                  return;
                }

                const output =
                  chunk.toString("utf8");

                /*
                 * Some Cisco switches authenticate SSH and then present a
                 * second "User Name" prompt inside the PTY. If that prompt is
                 * left waiting, the device closes the shell after about
                 * 30 seconds. Complete the device-level login with the same
                 * credential selected for this managed device.
                 */
                if (
                  String(deviceType)
                    .toLowerCase()
                    .includes("cisco") &&
                  !session.secondaryPasswordSent
                ) {
                  session.secondaryAuthBuffer =
                    (
                      session.secondaryAuthBuffer +
                      output
                    ).slice(-512);

                  const promptText =
                    session.secondaryAuthBuffer
                      .replace(
                        /\x1b\[[0-?]*[ -/]*[@-~]/g,
                        ""
                      );

                  if (
                    !session.secondaryUsernameSent &&
                    /(?:^|[\r\n])\s*user\s*name\s*:\s*$/i
                      .test(promptText)
                  ) {
                    session.secondaryUsernameSent = true;
                    session.secondaryAuthBuffer = "";
                    stream.write(`${username}\r`);
                  } else if (
                    session.secondaryUsernameSent &&
                    !session.secondaryPasswordSent &&
                    /(?:^|[\r\n])\s*password\s*:\s*$/i
                      .test(promptText)
                  ) {
                    session.secondaryPasswordSent = true;
                    session.secondaryAuthBuffer = "";
                    stream.write(`${password}\r`);
                  }
                }

                this.sendOutput(
                  clientId,
                  output
                );
              }
            );

            if (stream.stderr) {
              stream.stderr.on(
                "data",
                (chunk) => {
                  if (
                    !this.isCurrentSession(
                      clientId,
                      sessionId
                    )
                  ) {
                    return;
                  }

                  this.sendOutput(
                    clientId,
                    chunk.toString("utf8")
                  );
                }
              );
            }

            stream.on(
              "error",
              (streamError) => {
                if (
                  !this.isCurrentSession(
                    clientId,
                    sessionId
                  )
                ) {
                  return;
                }

                this.sendStatus(
                  clientId,
                  "error",
                  `Terminal stream error: ${streamError.message}`
                );
              }
            );

            stream.once(
              "close",
              () => {
                if (
                  !this.isCurrentSession(
                    clientId,
                    sessionId
                  )
                ) {
                  return;
                }

                session.sshStream = null;

                this.disconnectTerminal(
                  clientId,
                  {
                    sendStatus: true,
                    message:
                      "Remote terminal closed.",
                    expectedSessionId:
                      sessionId
                  }
                );
              }
            );
          }
        );
      }
    );

    sshClient.on(
      "error",
      (error) => {
        if (
          !this.isCurrentSession(
            clientId,
            sessionId
          )
        ) {
          return;
        }

        this.sendStatus(
          clientId,
          "error",
          `SSH error: ${error.message}`
        );

        this.disconnectTerminal(
          clientId,
          {
            sendStatus: false,
            expectedSessionId:
              sessionId
          }
        );
      }
    );

    sshClient.once(
      "end",
      () => {
        if (
          !this.isCurrentSession(
            clientId,
            sessionId
          )
        ) {
          return;
        }

        this.disconnectTerminal(
          clientId,
          {
            sendStatus: true,
            message:
              "SSH connection ended.",
            expectedSessionId:
              sessionId
          }
        );
      }
    );

    sshClient.once(
      "close",
      () => {
        if (
          !this.isCurrentSession(
            clientId,
            sessionId
          )
        ) {
          return;
        }

        this.disconnectTerminal(
          clientId,
          {
            sendStatus: true,
            message:
              "SSH connection closed.",
            expectedSessionId:
              sessionId,
            closeClient: false
          }
        );
      }
    );

    try {
      sshClient.connect({
        host,
        port,
        username,
        password,
        tryKeyboard: true,
        readyTimeout: 20000,
        keepaliveInterval: 15000,
        keepaliveCountMax: 12
      });
    } catch (error) {
      this.sendError(
        clientId,
        `Connection error: ${error.message}`
      );

      this.disconnectTerminal(
        clientId,
        {
          sendStatus: false,
          expectedSessionId:
            sessionId
        }
      );
    }
  }

  extractInputData(message = {}) {
    if (
      typeof message.data === "string"
    ) {
      return message.data;
    }

    if (
      message.data &&
      typeof message.data === "object" &&
      !Array.isArray(message.data)
    ) {
      const value =
        message.data.data ??
        message.data.input ??
        "";

      return typeof value === "string"
        ? value
        : String(value ?? "");
    }

    const value =
      message.input ?? "";

    return typeof value === "string"
      ? value
      : String(value ?? "");
  }

  sendInput(clientId, message) {
    const session =
      this.terminalSessions.get(clientId);

    if (
      !session ||
      session.closing ||
      !session.connected ||
      !session.sshStream ||
      session.sshStream.destroyed
    ) {
      return;
    }

    const inputData =
      this.extractInputData(message);

    /*
     * Never trim terminal input.
     * A single space is valid input.
     */
    if (inputData.length === 0) {
      return;
    }

    if (
      process.env.NODE_ENV !== "production" &&
      process.env.DEBUG_TERMINAL_INPUT === "true"
    ) {
      console.log(
        "[Terminal Input]",
        JSON.stringify(inputData),
        Array.from(inputData).map(
          (character) =>
            character.charCodeAt(0)
        )
      );
    }

    try {
      session.sshStream.write(
        inputData
      );
    } catch (error) {
      console.error(
        "Terminal input error:",
        error.message
      );
    }
  }

  resizeTerminal(clientId, message) {
    const payload = this.getPayload(message);

    const cols = Math.max(
      40,
      Number(
        payload.cols ??
        message.cols ??
        120
      ) || 120
    );

    const rows = Math.max(
      10,
      Number(
        payload.rows ??
        message.rows ??
        30
      ) || 30
    );

    const session =
      this.terminalSessions.get(clientId);

    if (
      !session ||
      session.closing ||
      !session.connected ||
      !session.sshStream ||
      session.sshStream.destroyed ||
      typeof session.sshStream
        .setWindow !== "function"
    ) {
      return;
    }

    if (
      session.cols === cols &&
      session.rows === rows
    ) {
      return;
    }

    session.cols = cols;
    session.rows = rows;

    try {
      session.sshStream.setWindow(
        rows,
        cols,
        0,
        0
      );
    } catch (error) {
      console.error(
        "Terminal resize error:",
        error.message
      );
    }
  }

  disconnectTerminal(
    clientId,
    options = {}
  ) {
    const {
      sendStatus = false,
      message = "Terminal disconnected.",
      expectedSessionId,
      closeClient = true
    } = options;

    const session =
      this.terminalSessions.get(clientId);

    if (!session) {
      return;
    }

    if (
      expectedSessionId &&
      session.sessionId !==
      expectedSessionId
    ) {
      return;
    }

    if (session.closing) {
      return;
    }

    session.closing = true;

    this.terminalSessions.delete(clientId);

    const stream =
      session.sshStream;

    const sshClient =
      session.sshClient;

    session.sshStream = null;
    session.sshClient = null;
    session.connected = false;
    session.connecting = false;

    if (
      stream &&
      !stream.destroyed
    ) {
      try {
        stream.end();
      } catch (error) {
        console.error(
          "SSH stream close error:",
          error.message
        );
      }
    }

    if (
      closeClient &&
      sshClient
    ) {
      try {
        sshClient.end();
      } catch (error) {
        console.error(
          "SSH client close error:",
          error.message
        );
      }
    }

    if (sendStatus) {
      this.sendStatus(
        clientId,
        "disconnected",
        message
      );
    }
  }

  handleDisconnect(clientId) {
    this.disconnectTerminal(
      clientId,
      {
        sendStatus: false
      }
    );
  }
}

module.exports = TerminalWebSocketService;
