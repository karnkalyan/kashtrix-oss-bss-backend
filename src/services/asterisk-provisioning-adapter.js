const fs = require('fs');
const path = require('path');
const net = require('net');
const { execFile, exec } = require('child_process');
const { NodeSSH } = require('node-ssh');

class AsteriskProvisioningAdapter {
  constructor(config, prisma) {
    this.config = config;
    this.prisma = prisma;
  }

  static create(config, prisma) {
    if (!config || !config.enabled || config.provisioningMode === 'disabled') {
      return new DisabledProvisioningAdapter(config, prisma);
    }
    if (config.provisioningMode === 'ssh') {
      return new SshProvisioningAdapter(config, prisma);
    }
    return new LocalProvisioningAdapter(config, prisma);
  }

  async testConnection() {
    throw new Error('Not implemented');
  }
  async readFile(filePath) {
    throw new Error('Not implemented');
  }
  async writeManagedFile(filePath, content) {
    throw new Error('Not implemented');
  }
  async fileExists(filePath) {
    throw new Error('Not implemented');
  }
  async runAsteriskCli(args) {
    throw new Error('Not implemented');
  }
  async reloadDialplan() {
    return this.runAsteriskCli(['dialplan', 'reload']);
  }
  async getServiceStatus(serviceName) {
    throw new Error('Not implemented');
  }
  async startService(serviceName) {
    throw new Error('Not implemented');
  }
  async stopService(serviceName) {
    throw new Error('Not implemented');
  }
  async restartService(serviceName) {
    throw new Error('Not implemented');
  }
  async isPortListening(host, port) {
    throw new Error('Not implemented');
  }

  async listAllowedServices() {
    const mainService = this.config.asteriskSystemdService || 'asterisk';
    const allowed = [mainService, 'kashtrix-voice-agent', 'gemini-voice-agent', 'kisannet-voice-agent'];
    const agents = await this.prisma.asteriskAiAgent.findMany({
      where: { ispId: this.config.ispId }
    });
    for (const agent of agents) {
      if (agent.serviceName) allowed.push(agent.serviceName);
      if (agent.systemdServiceName) allowed.push(agent.systemdServiceName);
    }
    return [...new Set(allowed.filter(Boolean))];
  }

  async validateServiceName(serviceName) {
    if (!/^[A-Za-z0-9_.@-]+$/.test(serviceName)) {
      throw new Error(`Invalid service name pattern: ${serviceName}`);
    }
    const allowed = await this.listAllowedServices();
    if (!allowed.includes(serviceName)) {
      throw new Error(`Service '${serviceName}' is not in the trusted allowlist`);
    }
  }
}

class DisabledProvisioningAdapter extends AsteriskProvisioningAdapter {
  async testConnection() {
    return { success: false, error: 'Provisioning is disabled' };
  }
  async readFile() {
    throw new Error('Provisioning is disabled');
  }
  async writeManagedFile() {
    throw new Error('Provisioning is disabled');
  }
  async fileExists() {
    return false;
  }
  async runAsteriskCli() {
    throw new Error('Provisioning is disabled');
  }
  async getServiceStatus() {
    return 'inactive';
  }
  async startService() {
    throw new Error('Provisioning is disabled');
  }
  async stopService() {
    throw new Error('Provisioning is disabled');
  }
  async restartService() {
    throw new Error('Provisioning is disabled');
  }
  async isPortListening() {
    return false;
  }
}

class LocalProvisioningAdapter extends AsteriskProvisioningAdapter {
  async testConnection() {
    try {
      const cliPath = this.config.asteriskCliPath || '/usr/sbin/asterisk';
      const exists = fs.existsSync(cliPath);
      return {
        success: true,
        cliAvailable: exists,
        message: exists ? 'Local provisioning available' : 'Local CLI not found'
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async readFile(filePath) {
    this.#assertSafePath(filePath);
    return fs.promises.readFile(filePath, 'utf-8');
  }

  async writeManagedFile(filePath, content) {
    this.#assertSafePath(filePath);
    // Atomic local write
    const dir = path.dirname(filePath);
    await fs.promises.mkdir(dir, { recursive: true });
    const tempFile = `${filePath}.tmp-${Date.now()}`;
    await fs.promises.writeFile(tempFile, content, 'utf-8');
    if (fs.existsSync(filePath)) {
      await fs.promises.copyFile(filePath, `${filePath}.${Date.now()}.bak`);
    }
    await fs.promises.rename(tempFile, filePath);
    return true;
  }

  async fileExists(filePath) {
    this.#assertSafePath(filePath);
    return fs.existsSync(filePath);
  }

  async runAsteriskCli(args) {
    if (process.platform === 'win32') {
      const showArg = args[2] || '';
      const ext = showArg.split('@')[0] || '';
      if (args[0] === 'dialplan' && args[1] === 'show' && ext) {
        try {
          const agent = await this.prisma.asteriskAiAgent.findFirst({
            where: { extension: ext }
          });
          const port = agent ? agent.audioSocketPort : 9020;
          return `exten => ${ext},1,AudioSocket(uuid,127.0.0.1:${port})`;
        } catch (e) {
          return `exten => ${ext},1,AudioSocket(uuid,127.0.0.1:9020)`;
        }
      }
      return 'Mock Asterisk CLI output on Windows';
    }
    const cliPath = this.config.asteriskCliPath || '/usr/sbin/asterisk';
    const finalArgs = ['-rx', args.join(' ')];
    return new Promise((resolve, reject) => {
      execFile(cliPath, finalArgs, (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || stdout || err.message));
        resolve(stdout);
      });
    });
  }

  async getServiceStatus(serviceName) {
    await this.validateServiceName(serviceName);
    if (process.platform === 'win32') {
      return 'active';
    }
    return new Promise((resolve) => {
      execFile('systemctl', ['is-active', serviceName], (err, stdout) => {
        resolve(stdout.trim());
      });
    });
  }

  async startService(serviceName) {
    await this.validateServiceName(serviceName);
    if (process.platform === 'win32') return { success: true };
    return new Promise((resolve, reject) => {
      execFile('systemctl', ['start', serviceName], (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || stdout || err.message));
        resolve({ success: true });
      });
    });
  }

  async stopService(serviceName) {
    await this.validateServiceName(serviceName);
    if (process.platform === 'win32') return { success: true };
    return new Promise((resolve, reject) => {
      execFile('systemctl', ['stop', serviceName], (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || stdout || err.message));
        resolve({ success: true });
      });
    });
  }

  async restartService(serviceName) {
    await this.validateServiceName(serviceName);
    if (process.platform === 'win32') return { success: true };
    return new Promise((resolve, reject) => {
      execFile('systemctl', ['restart', serviceName], (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || stdout || err.message));
        resolve({ success: true });
      });
    });
  }

  async isPortListening(host, port) {
    if (process.platform === 'win32') {
      return true; // Local simulation
    }
    // Perform local socket check or ss command
    return new Promise((resolve) => {
      execFile('ss', ['-lnt'], (err, stdout) => {
        if (err) {
          // Fallback to TCP check
          const socket = new net.Socket();
          socket.setTimeout(1000);
          socket.connect(port, host || '127.0.0.1', () => {
            socket.destroy();
            resolve(true);
          });
          socket.on('error', () => resolve(false));
          socket.on('timeout', () => {
            socket.destroy();
            resolve(false);
          });
        } else {
          resolve(stdout.includes(`:${port}`));
        }
      });
    });
  }

  #assertSafePath(filePath) {
    const resolved = path.resolve(filePath);
    const allowedBase = path.resolve(this.config.asteriskConfigDirectory || '/etc/asterisk');
    const allowedLocalScratch = path.resolve('./scratch');
    if (!resolved.startsWith(allowedBase) && !resolved.startsWith(allowedLocalScratch)) {
      throw new Error(`Path traversal attempt blocked: ${filePath}`);
    }
  }
}

class SshProvisioningAdapter extends AsteriskProvisioningAdapter {
  async testConnection() {
    const ssh = new NodeSSH();
    try {
      await this.#connectSsh(ssh);
      const cliPath = this.config.asteriskCliPath || '/usr/sbin/asterisk';
      const exists = await ssh.execCommand(`test -f ${cliPath}`);
      ssh.dispose();
      return {
        success: true,
        cliAvailable: exists.code === 0,
        message: exists.code === 0 ? 'SSH provisioning & CLI available' : 'SSH connected but Asterisk CLI not found'
      };
    } catch (err) {
      ssh.dispose();
      return { success: false, error: err.message };
    }
  }

  async readFile(filePath) {
    this.#assertSafePath(filePath);
    const ssh = new NodeSSH();
    await this.#connectSsh(ssh);
    try {
      const res = await ssh.execCommand(`cat ${filePath}`);
      if (res.code !== 0) throw new Error(res.stderr || `Failed to read file ${filePath}`);
      ssh.dispose();
      return res.stdout;
    } catch (err) {
      ssh.dispose();
      throw err;
    }
  }

  async writeManagedFile(filePath, content) {
    this.#assertSafePath(filePath);
    const ssh = new NodeSSH();
    await this.#connectSsh(ssh);
    try {
      const backupPath = `${filePath}.${Date.now()}.bak`;
      // Download or check file
      const exists = await ssh.execCommand(`test -f ${filePath}`);
      if (exists.code === 0) {
        // Backup
        await ssh.execCommand(`cp ${filePath} ${backupPath}`);
      }
      // Write temp file
      const tempPath = `${filePath}.tmp-${Date.now()}`;
      // Write content via cat EOF
      const safeContent = content.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');
      const writeCmd = `cat << 'EOF' > ${tempPath}\n${content}\nEOF`;
      const res = await ssh.execCommand(writeCmd);
      if (res.code !== 0) {
        throw new Error(`Failed to write temp file: ${res.stderr}`);
      }
      // Move temp file
      const mvRes = await ssh.execCommand(`mv ${tempPath} ${filePath}`);
      if (mvRes.code !== 0) {
        throw new Error(`Failed to apply config: ${mvRes.stderr}`);
      }
      ssh.dispose();
      return true;
    } catch (err) {
      ssh.dispose();
      throw err;
    }
  }

  async fileExists(filePath) {
    this.#assertSafePath(filePath);
    const ssh = new NodeSSH();
    await this.#connectSsh(ssh);
    const res = await ssh.execCommand(`test -f ${filePath}`);
    ssh.dispose();
    return res.code === 0;
  }

  async runAsteriskCli(args) {
    const cliPath = this.config.asteriskCliPath || '/usr/sbin/asterisk';
    const ssh = new NodeSSH();
    await this.#connectSsh(ssh);
    try {
      // Escape args
      const escaped = args.map(a => `"${a.replace(/"/g, '\\"')}"`).join(' ');
      const res = await ssh.execCommand(`${cliPath} -rx ${escaped}`);
      ssh.dispose();
      if (res.code !== 0) throw new Error(res.stderr || res.stdout);
      return res.stdout;
    } catch (err) {
      ssh.dispose();
      throw err;
    }
  }

  async getServiceStatus(serviceName) {
    await this.validateServiceName(serviceName);
    const ssh = new NodeSSH();
    await this.#connectSsh(ssh);
    try {
      const res = await ssh.execCommand(`systemctl is-active ${serviceName}`);
      ssh.dispose();
      return res.stdout.trim();
    } catch (err) {
      ssh.dispose();
      return 'unknown';
    }
  }

  async startService(serviceName) {
    await this.validateServiceName(serviceName);
    const ssh = new NodeSSH();
    await this.#connectSsh(ssh);
    try {
      const res = await ssh.execCommand(`systemctl start ${serviceName}`);
      ssh.dispose();
      if (res.code !== 0) throw new Error(res.stderr || res.stdout);
      return { success: true };
    } catch (err) {
      ssh.dispose();
      throw err;
    }
  }

  async stopService(serviceName) {
    await this.validateServiceName(serviceName);
    const ssh = new NodeSSH();
    await this.#connectSsh(ssh);
    try {
      const res = await ssh.execCommand(`systemctl stop ${serviceName}`);
      ssh.dispose();
      if (res.code !== 0) throw new Error(res.stderr || res.stdout);
      return { success: true };
    } catch (err) {
      ssh.dispose();
      throw err;
    }
  }

  async restartService(serviceName) {
    await this.validateServiceName(serviceName);
    const ssh = new NodeSSH();
    await this.#connectSsh(ssh);
    try {
      const res = await ssh.execCommand(`systemctl restart ${serviceName}`);
      ssh.dispose();
      if (res.code !== 0) throw new Error(res.stderr || res.stdout);
      return { success: true };
    } catch (err) {
      ssh.dispose();
      throw err;
    }
  }

  async isPortListening(host, port) {
    const ssh = new NodeSSH();
    await this.#connectSsh(ssh);
    try {
      const res = await ssh.execCommand(`ss -lnt | grep -E ':${port}\\b'`);
      ssh.dispose();
      return res.code === 0;
    } catch (err) {
      ssh.dispose();
      return false;
    }
  }

  async #connectSsh(ssh) {
    const privateKey = process.env.KASHTRIX_ASTERISK_SSH_KEY_PATH || this.config.sshPrivateKey || undefined;
    const sshPort = parseInt(this.config.provisioningPort || 22, 10);
    const connectionOpts = {
      host: this.config.provisioningHost || this.config.pbxHost,
      port: sshPort,
      username: this.config.provisioningUsername || this.config.username,
      password: this.config.sshPassword || undefined
    };

    if (privateKey) {
      if (fs.existsSync(privateKey)) {
        connectionOpts.privateKey = fs.readFileSync(privateKey, 'utf-8');
      } else {
        connectionOpts.privateKey = privateKey;
      }
    }

    await ssh.connect(connectionOpts);
  }

  #assertSafePath(filePath) {
    if (filePath.includes('..')) {
      throw new Error(`Path traversal attempt blocked: ${filePath}`);
    }
  }
}

module.exports = {
  AsteriskProvisioningAdapter,
  LocalProvisioningAdapter,
  SshProvisioningAdapter,
  DisabledProvisioningAdapter
};
