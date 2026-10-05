const net = require('net');
const EventEmitter = require('events');

class AsteriskAmiClient extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.socket = null;
    this.connected = false;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.actionIdCounter = 1;
    this.pendingActions = new Map();
    this.buffer = '';
    this.reconnectAttempts = 0;
  }

  connect() {
    if (this.socket) return;
    
    this.socket = new net.Socket();
    this.socket.setTimeout(10000);

    const host = this.config.amiHost || this.config.pbxHost || '10.3.2.16';
    const port = parseInt(this.config.amiPort || 5038, 10);

    console.log(`[AMI CLIENT] Connecting to ${host}:${port}...`);

    this.socket.connect(port, host, () => {
      console.log(`[AMI CLIENT] TCP Connected to ${host}:${port}`);
      // Authenticate
      this.sendAction({
        Action: 'Login',
        Username: this.config.amiUsername,
        Secret: process.env.KASHTRIX_AMI_SECRET || this.config.amiPassword
      }).then(res => {
        if (res.Response === 'Success' || res.Message === 'Authentication accepted') {
          console.log('[AMI CLIENT] Authentication successful');
          this.connected = true;
          this.reconnectAttempts = 0;
          this.startPing();
          this.emit('connected');
        } else {
          console.error('[AMI CLIENT] Authentication failed:', res.Message);
          this.disconnect();
        }
      }).catch(err => {
        console.error('[AMI CLIENT] Login action error:', err.message);
        this.disconnect();
      });
    });

    this.socket.on('data', (data) => {
      this.buffer += data.toString();
      this.processBuffer();
    });

    this.socket.on('error', (err) => {
      console.error('[AMI CLIENT] Socket error:', err.message);
      this.handleReconnect();
    });

    this.socket.on('close', () => {
      console.log('[AMI CLIENT] Socket closed');
      this.handleReconnect();
    });
  }

  processBuffer() {
    const packets = this.buffer.split('\r\n\r\n');
    this.buffer = packets.pop() || ''; // keep last incomplete packet

    for (const packet of packets) {
      if (!packet.trim()) continue;
      this.handlePacket(packet);
    }
  }

  handlePacket(packet) {
    const lines = packet.split('\r\n');
    const response = {};
    let commandOutput = [];
    let isCommandFollows = false;

    for (const line of lines) {
      if (line.startsWith('--END COMMAND--')) {
        continue;
      }
      const idx = line.indexOf(':');
      if (idx !== -1 && !isCommandFollows) {
        const key = line.slice(0, idx).trim();
        const val = line.slice(idx + 1).trim();
        response[key] = val;
        if (key === 'Response' && val === 'Follows') {
          isCommandFollows = true;
        }
      } else if (isCommandFollows) {
        commandOutput.push(line);
      }
    }

    if (commandOutput.length > 0) {
      response.Output = commandOutput.join('\n');
    }

    // Emit packet event
    this.emit('packet', response);

    if (response.ActionID) {
      const pending = this.pendingActions.get(response.ActionID);
      if (pending) {
        pending.resolve(response);
        this.pendingActions.delete(response.ActionID);
      }
    }

    // Emit asynchronous AMI events
    if (response.Event) {
      this.emit('event', response);
      this.emit(response.Event, response);
    }
  }

  sendAction(action) {
    return new Promise((resolve, reject) => {
      if (!this.socket || (!this.connected && action.Action !== 'Login')) {
        return reject(new Error('Socket not connected'));
      }
      const actionId = `act-${this.actionIdCounter++}`;
      action.ActionID = actionId;
      
      this.pendingActions.set(actionId, { resolve, reject });

      let payload = '';
      for (const [key, val] of Object.entries(action)) {
        payload += `${key}: ${val}\r\n`;
      }
      payload += '\r\n';
      this.socket.write(payload);

      // Timeout safety
      setTimeout(() => {
        if (this.pendingActions.has(actionId)) {
          this.pendingActions.delete(actionId);
          reject(new Error(`AMI action ${action.Action} timed out`));
        }
      }, 5000);
    });
  }

  async executeCommand(command) {
    const res = await this.sendAction({
      Action: 'Command',
      Command: command
    });
    return res.Output || res.Message || JSON.stringify(res);
  }

  async reloadDialplan() {
    return this.executeCommand('dialplan reload');
  }

  async reloadPjsip() {
    return this.executeCommand('pjsip reload');
  }

  async addDialplanExtension({ context, extension, priority, app, appData, replace = false }) {
    const dataPart = appData !== undefined && appData !== null ? `(${appData})` : '';
    const cmd = `dialplan add extension ${extension},${priority},${app}${dataPart} into ${context || 'internal'}${replace ? ' replace' : ''}`;
    return this.executeCommand(cmd);
  }

  async removeDialplanExtension({ context, extension }) {
    const cmd = `dialplan remove extension ${extension}@${context || 'internal'}`;
    return this.executeCommand(cmd);
  }

  sendActionWithEvents(action, eventName, completeEventName) {
    return new Promise((resolve, reject) => {
      const actionId = `act-${this.actionIdCounter++}`;
      action.ActionID = actionId;
      const events = [];

      const onPacket = (packet) => {
        if (packet.ActionID === actionId) {
          if (packet.Event === completeEventName || packet.Response === 'Error' || packet.Response === 'Fail') {
            this.off('packet', onPacket);
            if (packet.Response === 'Error' || packet.Response === 'Fail') {
              reject(new Error(packet.Message || 'Action failed'));
            } else {
              resolve(events);
            }
          } else if (
            packet.Event === eventName || 
            (Array.isArray(eventName) && eventName.includes(packet.Event))
          ) {
            events.push(packet);
          }
        }
      };

      this.on('packet', onPacket);

      this.sendAction(action).then(res => {
        if (res.Response === 'Error' || res.Response === 'Fail') {
          this.off('packet', onPacket);
          reject(new Error(res.Message || 'Action failed'));
        }
      }).catch(err => {
        this.off('packet', onPacket);
        reject(err);
      });

      // Max timeout
      setTimeout(() => {
        this.off('packet', onPacket);
        resolve(events);
      }, 5000);
    });
  }

  startPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (this.connected) {
        this.sendAction({ Action: 'Ping' }).catch(() => {});
      }
    }, 20000);
  }

  handleReconnect() {
    this.connected = false;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    if (!this.reconnectTimer) {
      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts++), 30000);
      console.log(`[AMI CLIENT] Scheduling reconnect in ${delay / 1000}s (Attempt ${this.reconnectAttempts})`);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, delay);
    }
  }

  disconnect() {
    this.connected = false;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.reconnectAttempts = 0;
  }
}

const amiConnections = new Map();

function getAmiClient(ispId, config) {
  if (!config || !config.amiHost || !config.amiUsername) return null;
  const key = `${ispId}`;
  if (!amiConnections.has(key)) {
    const client = new AsteriskAmiClient(config);
    client.connect();
    amiConnections.set(key, client);
  }
  return amiConnections.get(key);
}

module.exports = { getAmiClient, AsteriskAmiClient, amiConnections };
