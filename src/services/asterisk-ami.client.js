const net = require('net');
const { EventEmitter } = require('events');

/**
 * AsteriskAmiClient
 * Persistent, robust Asterisk Manager Interface (AMI) TCP client.
 * Features:
 *  - Persistent TCP socket with automatic reconnect & exponential backoff
 *  - Login with Actions: Login, Username, Secret, Events: on
 *  - Unique ActionID correlation with Map<ActionID, { resolve, reject, multiEvent, events, timer }>
 *  - Ping heartbeat & idle connection keepalive
 *  - Full \r\n\r\n delimiter RFC-compliant AMI block parser
 *  - Emits normalized raw events ('event', 'response', 'connected', 'disconnected', 'error')
 */
class AsteriskAmiClient extends EventEmitter {
  #host = null;
  #port = 5038;
  #username = null;
  #password = null;

  #socket = null;
  #buffer = '';
  #isConnected = false;
  #isAuthenticated = false;
  #reconnectTimer = null;
  #reconnectDelay = 2000;
  #pingInterval = null;
  #actionCounter = 0;
  #pendingActions = new Map();
  #stopped = false;
  #connectPromise = null;
  #connectPromiseResolver = null;

  constructor(config = {}) {
    super();
    this.#host = config.host || config.amiHost;
    this.#port = Number(config.port || config.amiPort) || 5038;
    this.#username = config.username || config.amiUsername;
    this.#password = config.password || config.amiPassword;
    this.setMaxListeners(50);
  }

  get isConnected() {
    return this.#isConnected;
  }

  get isAuthenticated() {
    return this.#isAuthenticated;
  }

  get host() {
    return this.#host;
  }

  get port() {
    return this.#port;
  }

  /**
   * Connect and authenticate to Asterisk AMI
   */
  async connect(timeoutMs = 8000) {
    if (this.#isConnected && this.#isAuthenticated) {
      return { success: true, message: 'Already connected and authenticated' };
    }

    this.#stopped = false;

    if (this.#connectPromise) {
      return this.#connectPromise;
    }

    this.#connectPromise = new Promise((resolve, reject) => {
      let resolved = false;
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.#connectPromise = null;
          reject(new Error(`AMI connection timeout after ${timeoutMs}ms to ${this.#host}:${this.#port}`));
        }
      }, timeoutMs);

      this.#connectPromiseResolver = (err, result) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          this.#connectPromise = null;
          if (err) reject(err);
          else resolve(result);
        }
      };

      this.#createSocket();
    });

    return this.#connectPromise;
  }

  #createSocket() {
    if (this.#socket) {
      try {
        this.#socket.removeAllListeners();
        this.#socket.destroy();
      } catch (e) {}
      this.#socket = null;
    }

    this.#buffer = '';
    this.#isConnected = false;
    this.#isAuthenticated = false;

    const socket = new net.Socket();
    this.#socket = socket;
    socket.setKeepAlive(true, 10000);
    socket.setNoDelay(true);

    socket.connect(this.#port, this.#host, () => {
      this.#isConnected = true;
      this.emit('connected', { host: this.#host, port: this.#port });
    });

    socket.on('data', (chunk) => {
      this.#handleData(chunk);
    });

    socket.on('error', (err) => {
      this.#isConnected = false;
      this.#isAuthenticated = false;
      if (this.listenerCount('error') > 0) {
        this.emit('error', err);
      }
      if (this.#connectPromiseResolver) {
        this.#connectPromiseResolver(err, null);
        this.#connectPromiseResolver = null;
      }
    });

    socket.on('close', (hadError) => {
      this.#isConnected = false;
      this.#isAuthenticated = false;
      this.#stopPing();
      this.#rejectAllPending(new Error('AMI connection closed'));
      this.emit('disconnected', { hadError });

      if (!this.#stopped) {
        this.#scheduleReconnect();
      }
    });
  }

  #scheduleReconnect() {
    if (this.#reconnectTimer || this.#stopped) return;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      if (!this.#stopped && (!this.#isConnected || !this.#isAuthenticated)) {
        this.#reconnectDelay = Math.min(this.#reconnectDelay * 1.5, 20000);
        this.#createSocket();
      }
    }, this.#reconnectDelay);
  }

  #startPing() {
    this.#stopPing();
    this.#pingInterval = setInterval(async () => {
      if (this.#isConnected && this.#isAuthenticated) {
        try {
          await this.sendAction({ Action: 'Ping' }, 4000);
        } catch (err) {
          // Socket may have stalled
          if (this.#socket) {
            try { this.#socket.destroy(); } catch (e) {}
          }
        }
      }
    }, 25000);
  }

  #stopPing() {
    if (this.#pingInterval) {
      clearInterval(this.#pingInterval);
      this.#pingInterval = null;
    }
  }

  disconnect() {
    this.#stopped = true;
    this.#stopPing();
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.#rejectAllPending(new Error('AMI client disconnected intentionally'));
    if (this.#socket) {
      try {
        if (this.#isAuthenticated) {
          this.#socket.write('Action: Logoff\r\n\r\n');
        }
        this.#socket.destroy();
      } catch (e) {}
      this.#socket = null;
    }
    this.#isConnected = false;
    this.#isAuthenticated = false;
  }

  #handleData(chunk) {
    this.#buffer += chunk.toString('utf8');

    // Handle Asterisk banner if present at start of buffer (which terminates with single \r\n)
    if (this.#buffer.startsWith('Asterisk Call Manager')) {
      const bannerEnd = this.#buffer.indexOf('\n');
      if (bannerEnd !== -1) {
        const banner = this.#buffer.slice(0, bannerEnd).trim();
        this.#buffer = this.#buffer.slice(bannerEnd + 1);
        this.emit('banner', banner);
        this.#sendLogin();
      }
    }

    // Process blocks in buffer
    while (this.#buffer.length > 0) {
      // Check if current buffer starts with or contains a Command "Response: Follows"
      const lowerBuf = this.#buffer.toLowerCase();
      const followsIdx = lowerBuf.indexOf('response: follows');

      if (followsIdx !== -1 && followsIdx < 100) {
        // Must wait until --END COMMAND-- is present
        const endCmdIdx = this.#buffer.indexOf('--END COMMAND--');
        if (endCmdIdx === -1) {
          // Incomplete command output; wait for next TCP chunk
          break;
        }

        // Find boundary after --END COMMAND--
        let delimLen = 4;
        let boundary = this.#buffer.indexOf('\r\n\r\n', endCmdIdx);
        if (boundary === -1) {
          delimLen = 2;
          boundary = this.#buffer.indexOf('\n\n', endCmdIdx);
        }
        if (boundary === -1) {
          delimLen = 2;
          boundary = this.#buffer.indexOf('\r\n', endCmdIdx);
        }
        if (boundary === -1) {
          delimLen = 1;
          boundary = this.#buffer.indexOf('\n', endCmdIdx);
        }

        if (boundary !== -1) {
          const block = this.#buffer.slice(0, boundary).trim();
          this.#buffer = this.#buffer.slice(boundary + delimLen);
          if (block) {
            this.#processBlock(block);
          }
          continue;
        } else {
          break;
        }
      }

      // Standard AMI block delimited by \r\n\r\n or \n\n
      let boundary = this.#buffer.indexOf('\r\n\r\n');
      let delimLen = 4;
      if (boundary === -1) {
        boundary = this.#buffer.indexOf('\n\n');
        delimLen = 2;
      }

      if (boundary === -1) {
        break; // Incomplete block, wait for more data
      }

      const block = this.#buffer.slice(0, boundary).trim();
      this.#buffer = this.#buffer.slice(boundary + delimLen);

      if (block) {
        this.#processBlock(block);
      }
    }
  }

  #processBlock(block) {
    // Check Asterisk banner: Asterisk Call Manager/x.x.x
    if (block.startsWith('Asterisk Call Manager')) {
      const banner = block.split(/\r?\n/)[0];
      this.emit('banner', banner);
      this.#sendLogin();
      return;
    }

    const lines = block.split(/\r?\n/);
    const parsed = {};
    let isCommandFollows = false;
    const commandOutputLines = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith('--END COMMAND--')) {
        continue;
      }

      if (isCommandFollows) {
        commandOutputLines.push(line);
        continue;
      }

      const colonIdx = line.indexOf(':');
      if (colonIdx > 0) {
        const key = line.slice(0, colonIdx).trim();
        const value = line.slice(colonIdx + 1).trim();
        parsed[key] = value;

        if (key.toLowerCase() === 'response' && value.toLowerCase() === 'follows') {
          isCommandFollows = true;
        }
      } else if (parsed.ActionID) {
        // Line without colon after header - command output line
        commandOutputLines.push(line);
      }
    }

    if (isCommandFollows || commandOutputLines.length > 0) {
      const fullOutput = commandOutputLines.join('\n').trim();
      parsed.output = fullOutput;
      if (!parsed.Message) {
        parsed.Message = fullOutput;
      }
    }

    const actionId = parsed.ActionID;

    // Check if this block resolves a pending action
    if (actionId && this.#pendingActions.has(actionId)) {
      const pending = this.#pendingActions.get(actionId);

      // Handle multi-event actions (like Status, CoreShowChannels, QueueStatus, ListCommands, etc.)
      if (pending.multiEvent) {
        if (parsed.Event) {
          pending.events.push(parsed);
          // Check if completion event received
          const eventName = parsed.Event.toLowerCase();
          if (
            eventName === pending.completeEvent.toLowerCase() ||
            eventName === 'statuscomplete' ||
            eventName === 'coreshowchannelscomplete' ||
            eventName === 'queuestatuscomplete' ||
            eventName === 'peerlistcomplete' ||
            eventName === 'registrationscomplete' ||
            eventName === 'endpointlistcomplete' ||
            eventName === 'commandcomplete'
          ) {
            clearTimeout(pending.timer);
            this.#pendingActions.delete(actionId);
            pending.resolve({
              success: true,
              response: pending.initialResponse,
              events: pending.events
            });
            return;
          }
        } else if (parsed.Response) {
          pending.initialResponse = parsed;
          if (parsed.Response.toLowerCase() === 'error') {
            clearTimeout(pending.timer);
            this.#pendingActions.delete(actionId);
            pending.reject(new Error(parsed.Message || 'AMI Action returned Error'));
            return;
          }
        }
        return;
      }

      // Single response action
      clearTimeout(pending.timer);
      this.#pendingActions.delete(actionId);

      if (parsed.Response && parsed.Response.toLowerCase() === 'error') {
        pending.reject(new Error(parsed.Message || 'AMI Action returned Error'));
      } else {
        pending.resolve(parsed);
      }
      return;
    }

    // Handle Login Response
    if (parsed.Response && (parsed.ActionID === '__login__' || !parsed.ActionID)) {
      if (
        parsed.Response.toLowerCase() === 'success' ||
        String(parsed.Message || '').toLowerCase().includes('authentication accepted')
      ) {
        this.#isAuthenticated = true;
        this.#reconnectDelay = 2000;
        this.#startPing();
        this.emit('authenticated', parsed);
        if (this.#connectPromiseResolver) {
          this.#connectPromiseResolver(null, { success: true, message: 'AMI Connected and Authenticated' });
          this.#connectPromiseResolver = null;
        }
        return;
      } else if (parsed.Response.toLowerCase() === 'error') {
        this.#isAuthenticated = false;
        const err = new Error(`AMI Authentication Failed: ${parsed.Message || 'Bad Secret or User'}`);
        if (this.listenerCount('error') > 0) {
          this.emit('error', err);
        }
        if (this.#connectPromiseResolver) {
          this.#connectPromiseResolver(err, null);
          this.#connectPromiseResolver = null;
        }
        return;
      }
    }

    // Generic Event emission
    if (parsed.Event) {
      this.emit('event', parsed);
      this.emit(`event:${parsed.Event.toLowerCase()}`, parsed);
    }
  }

  #sendLogin() {
    const loginPacket =
      `Action: Login\r\n` +
      `Username: ${this.#username}\r\n` +
      `Secret: ${this.#password}\r\n` +
      `Events: on\r\n` +
      `ActionID: __login__\r\n\r\n`;

    try {
      this.#socket.write(loginPacket);
    } catch (err) {
      if (this.#connectPromiseResolver) {
        this.#connectPromiseResolver(err, null);
        this.#connectPromiseResolver = null;
      }
    }
  }

  #rejectAllPending(error) {
    for (const [actionId, pending] of this.#pendingActions.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pendingActions.clear();
  }

  /**
   * Send single-response AMI action
   */
  async sendAction(actionObj, timeoutMs = 8000) {
    if (!this.#isConnected || !this.#isAuthenticated) {
      await this.connect();
    }

    const actionId = actionObj.ActionID || `act_${Date.now()}_${++this.#actionCounter}`;
    const payload = { ...actionObj, ActionID: actionId };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#pendingActions.has(actionId)) {
          this.#pendingActions.delete(actionId);
          reject(new Error(`AMI action ${payload.Action} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      this.#pendingActions.set(actionId, {
        resolve,
        reject,
        timer,
        multiEvent: false
      });

      let rawCmd = '';
      for (const [key, value] of Object.entries(payload)) {
        if (value !== undefined && value !== null) {
          rawCmd += `${key}: ${value}\r\n`;
        }
      }
      rawCmd += '\r\n';

      try {
        this.#socket.write(rawCmd);
      } catch (err) {
        clearTimeout(timer);
        this.#pendingActions.delete(actionId);
        reject(err);
      }
    });
  }

  /**
   * Send multi-event AMI action (e.g. Status, CoreShowChannels, QueueStatus)
   */
  async sendMultiEventAction(actionObj, completeEvent, timeoutMs = 12000) {
    if (!this.#isConnected || !this.#isAuthenticated) {
      await this.connect();
    }

    const actionId = actionObj.ActionID || `multi_${Date.now()}_${++this.#actionCounter}`;
    const payload = { ...actionObj, ActionID: actionId };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#pendingActions.has(actionId)) {
          const pending = this.#pendingActions.get(actionId);
          this.#pendingActions.delete(actionId);
          // If we received some events before timeout, resolve with what we have
          if (pending && pending.events.length > 0) {
            resolve({
              success: true,
              response: pending.initialResponse || {},
              events: pending.events,
              partial: true
            });
          } else {
            reject(new Error(`AMI multi-event action ${payload.Action} timed out after ${timeoutMs}ms`));
          }
        }
      }, timeoutMs);

      this.#pendingActions.set(actionId, {
        resolve,
        reject,
        timer,
        multiEvent: true,
        completeEvent: completeEvent || `${payload.Action}Complete`,
        events: [],
        initialResponse: null
      });

      let rawCmd = '';
      for (const [key, value] of Object.entries(payload)) {
        if (value !== undefined && value !== null) {
          rawCmd += `${key}: ${value}\r\n`;
        }
      }
      rawCmd += '\r\n';

      try {
        this.#socket.write(rawCmd);
      } catch (err) {
        clearTimeout(timer);
        this.#pendingActions.delete(actionId);
        reject(err);
      }
    });
  }

  #commandQueue = Promise.resolve();

  /**
   * Execute CLI command via AMI Action: Command
   */
  async executeCommand(command, timeoutMs = 8000) {
    return (this.#commandQueue = this.#commandQueue.catch(() => {}).then(async () => {
      try {
        const res = await this.sendAction({ Action: 'Command', Command: command }, timeoutMs);
        const out = typeof res.output === 'string' ? res.output : (res.Message || '');
        return {
          success: true,
          output: out
        };
      } catch (err) {
        return {
          success: false,
          error: err.message,
          output: ''
        };
      }
    }));
  }
}

module.exports = AsteriskAmiClient;
