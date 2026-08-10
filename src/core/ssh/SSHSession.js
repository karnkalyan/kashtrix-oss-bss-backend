// core/ssh/SSHSession.js
const { Client } = require('ssh2');

class SSHSession {
    constructor(config) {
        this.config = {
            host: config.host,
            port: config.port || 22,
            username: config.username,
            password: config.password,
            privateKey: config.privateKey,
            passphrase: config.passphrase,
            enablePassword: config.enablePassword,
            vendor: config.vendor,
            deviceType: config.deviceType,
            platform: config.platform,
            readyTimeout: config.timeout || config.readyTimeout || 20000,
            keepaliveInterval: config.keepaliveInterval || 5000,
            keepaliveCountMax: config.keepaliveCountMax || 3,
            // Allow overriding the generic prompt detection per device if needed
            promptRegex: config.promptRegex || /([>#]|\]:|:)\s?$/,
            algorithms: config.algorithms,
            tryKeyboard: Boolean(config.tryKeyboard),
            compress: Boolean(config.compression),
            hostHash: 'sha256',
            hostVerifier: fingerprint => { this.diagnostics.deviceFingerprint = fingerprint; return config.hostVerifier ? config.hostVerifier(fingerprint) : true; },
            debug: message => this.captureDebug(message)
        };
        if (!this.config.algorithms) delete this.config.algorithms;
        this.client = new Client();
        this.stream = null;
        this.commandTimeout = config.commandTimeout || 20000;
        this.commandQueue = Promise.resolve();
        this.profile = config.profile || 'modern';
        this.diagnostics = { profile:this.profile, sshBanner:null, sshProtocolVersion:null, deviceFingerprint:null, negotiation:{keyExchange:false,cipher:false,hostKey:false}, debug:[] };
    }

    captureDebug(message) {
        const text=String(message||'');
        if (!/handshake|kex|cipher|host key|server ident|ready/i.test(text)) return;
        const safe=text.replace(/(password|secret|private.?key)\s*[:=].*/ig,'$1 [removed]').slice(0,500);
        this.diagnostics.debug.push(safe);
        if (/server ident/i.test(text)) this.diagnostics.sshProtocolVersion=(text.match(/SSH-[\w.-]+/)||[])[0]||null;
        if (/kex.*(?:agree|selected)|key exchange.*(?:agree|selected)/i.test(text)) this.diagnostics.negotiation.keyExchange=true;
        if (/cipher.*(?:agree|selected)|(?:c->s|s->c).*cipher/i.test(text)) this.diagnostics.negotiation.cipher=true;
        if (/host key.*(?:agree|selected)/i.test(text)) this.diagnostics.negotiation.hostKey=true;
        if (this.diagnostics.debug.length>40) this.diagnostics.debug.shift();
    }

    async connect() {
        let kbAttempts = 0;
        return new Promise((resolve, reject) => {
            this.client
                .on('banner', banner => { this.diagnostics.sshBanner=String(banner||'').slice(0,500); })
                .on('keyboard-interactive', (_name, _instructions, _language, prompts, finish) => {
                    kbAttempts++;
                    if (kbAttempts > 2) {
                        return finish([]);
                    }
                    this.diagnostics.authenticationMethod='keyboard-interactive';
                    finish((prompts||[]).map(() => this.config.password || ''));
                })
                .on('ready', () => {
                    resolve(this.client);
                })
                .on('error', (err) => {
                    reject(err);
                })
                .connect(this.config);
        });
    }

    async createShell() {
        return new Promise((resolve, reject) => {
            this.client.shell((err, stream) => {
                if (err) return reject(err);
                this.stream = stream;
                if (this.isCisco()) return this.prepareCiscoShell().then(() => this.initializeInteractiveSession()).then(() => resolve(stream), reject);
                if (this.isHuawei()) return this.prepareHuaweiShell().then(() => resolve(stream), reject);
                this.prepareGenericShell().then(() => this.initializeInteractiveSession()).then(() => resolve(stream), reject);
            });
        });
    }

    isCisco() { return /cisco/i.test(`${this.config.vendor || ''} ${this.config.deviceType || ''}`); }
    isHuawei() { return /huawei/i.test(`${this.config.vendor || ''} ${this.config.deviceType || ''}`); }
    isNokia() { return /nokia|sros|sr os/i.test(`${this.config.vendor || ''} ${this.config.deviceType || ''} ${this.config.platform || ''}`); }

    async initializeInteractiveSession() {
        // These are session-scoped display settings; they do not change device configuration.
        const command=this.isNokia()?'environment no more':this.isCisco()?'terminal length 0':null;
        if(!command)return;
        try{await this._sendCommand(command,150);}catch(error){this.diagnostics.paginationInitializationError=String(error.message||error).slice(0,200);}
    }

    prepareGenericShell() {
        return new Promise((resolve,reject)=>{let buffer='',settled=false;const timeout=setTimeout(()=>finish(),Math.min(3000,this.commandTimeout));const cleanup=()=>{clearTimeout(timeout);this.stream?.removeListener('data',onData);this.stream?.removeListener('error',onError);};const finish=error=>{if(settled)return;settled=true;cleanup();error?reject(error):resolve();};const onError=error=>finish(error);const onData=data=>{buffer+=data.toString('utf8').replace(/\r/g,'');const prompt=buffer.match(/(?:^|\n)([^\n]{1,120}[#>$%])\s*$/);if(prompt){this.initialPrompt=prompt[1].trim();finish();}};this.stream.on('data',onData);this.stream.once('error',onError);});
    }

    prepareCiscoShell() {
        return new Promise((resolve, reject) => {
            let buffer = '', usernameSent = false, passwordSent = false, settled = false;
            const timeout = setTimeout(() => finish(Object.assign(new Error('Cisco CLI prompt was not detected after SSH authentication.'), { code: 'CISCO_PROMPT_NOT_DETECTED', status: 502 })), Math.min(this.commandTimeout, 10000));
            const cleanup = () => { clearTimeout(timeout); this.stream?.removeListener('data', onData); this.stream?.removeListener('error', onError); };
            const finish = error => { if (settled) return; settled = true; cleanup(); error ? reject(error) : resolve(); };
            const onError = error => finish(Object.assign(error, { code: error.code || 'CISCO_SESSION_CLOSED' }));
            const onData = data => {
                buffer += data.toString('utf8').replace(/\r/g, '');
                const tail = buffer.slice(-2000);
                if (/password\s+(?:authentication\s+)?failed|authentication failed|login invalid|access denied/i.test(tail)) return finish(Object.assign(new Error('Cisco CLI authentication failed after the SSH transport connected.'), { code: 'CISCO_LOGIN_AUTH_FAILED', status: 401 }));
                if (/(?:user ?name|login)\s*:\s*$/i.test(tail)) {
                    if (usernameSent) return finish(Object.assign(new Error('Cisco CLI repeatedly requested the username.'), { code: 'CISCO_LOGIN_AUTH_FAILED', status: 401 }));
                    usernameSent = true; this.stream.write(`${this.config.username}\r`); return;
                }
                if (/password\s*:\s*$/i.test(tail)) {
                    if (passwordSent) return finish(Object.assign(new Error('Cisco CLI rejected the supplied login credential.'), { code: 'CISCO_LOGIN_AUTH_FAILED', status: 401 }));
                    passwordSent = true; this.stream.write(`${this.config.password || ''}\r`); return;
                }
                const prompt = tail.match(/(?:^|\n)([\w().@:/-]+[>#])\s*$/);
                if (prompt) { this.initialPrompt = prompt[1]; this.privilegeLevel = prompt[1].endsWith('#') ? 'privileged' : 'user'; finish(); }
            };
            this.stream.on('data', onData);
            this.stream.once('error', onError);
        });
    }

    prepareHuaweiShell() {
        return new Promise((resolve, reject) => {
            let buffer = '', enableSent = false, passwordSent = false, settled = false;
            const timeout = setTimeout(() => finish(Object.assign(new Error('Huawei privileged CLI prompt was not detected.'), { code: 'HUAWEI_PROMPT_NOT_DETECTED', status: 502 })), Math.min(this.commandTimeout, 12000));
            const cleanup = () => { clearTimeout(timeout); this.stream?.removeListener('data', onData); this.stream?.removeListener('error', onError); };
            const finish = error => { if (settled) return; settled = true; cleanup(); error ? reject(error) : resolve(); };
            const onError = error => finish(Object.assign(error, { code: error.code || 'HUAWEI_SESSION_CLOSED' }));
            const onData = data => {
                buffer += data.toString('utf8').replace(/\r/g, '');
                const tail = buffer.slice(-2500);
                if (/password.*(?:error|incorrect|failed)|authentication failed|access denied/i.test(tail)) return finish(Object.assign(new Error('Huawei enable authentication failed.'), { code: 'HUAWEI_ENABLE_AUTH_FAILED', status: 401 }));
                if (/password\s*:\s*$/i.test(tail)) {
                    if (passwordSent) return finish(Object.assign(new Error('Huawei rejected the enable credential.'), { code: 'HUAWEI_ENABLE_AUTH_FAILED', status: 401 }));
                    passwordSent = true; this.stream.write(`${this.config.enablePassword || this.config.password || ''}\r`); return;
                }
                const prompt = tail.match(/(?:^|\n)([\w().@:/-]+[>#])\s*$/);
                if (!prompt) return;
                this.initialPrompt = prompt[1];
                if (prompt[1].endsWith('#')) { this.privilegeLevel = 'privileged'; return finish(); }
                if (!enableSent) { enableSent = true; buffer = ''; this.stream.write('enable\r'); }
            };
            this.stream.on('data', onData);
            this.stream.once('error', onError);
        });
    }

    /**
     * Sends a command and handles pagination/prompts automatically.
     * @param {string} cmd - Command to send
     * @param {number} waitMs - Time to wait for output stability (default 1200ms)
     */
    sendCommand(cmd, waitMs = 1200) {
        const job=this.commandQueue.then(()=>this._sendCommand(cmd,waitMs));
        this.commandQueue=job.catch(()=>undefined);
        return job;
    }

    _sendCommand(cmd, waitMs = 1200) {
        return new Promise((resolve, reject) => {
            if (!this.stream) return reject(new Error('No active shell session'));

            let buffer = '';
            let timer = null;
            let hardTimer = null;
            let confirmationSent = false;
            let pageCount = 0;
            let pagingTail = '';
            const cleanup = () => { clearTimeout(timer); clearTimeout(hardTimer); this.stream?.removeListener('data', onData); this.stream?.removeListener('error', onError); };
            const scheduleFinish = (delay=waitMs) => {
                clearTimeout(timer);
                timer = setTimeout(() => {
                    cleanup();
                    resolve(buffer);
                }, delay);
            };

            const onData = (data) => {
                const chunk = data.toString('utf8');
                buffer += chunk;

                // --- DYNAMIC PAGING HANDLER ---

                const plain=buffer.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g,'').replace(/\r/g,'');
                const chunkPlain=chunk.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g,'').replace(/\r/g,'');
                const paging=/---- More|--More--|Press any key to continue\s*\(Q to quit\)|More:\s*$/i;
                pagingTail=(pagingTail+chunkPlain).slice(-300);
                if (paging.test(pagingTail)) {
                    if(++pageCount>250){cleanup();return reject(Object.assign(new Error('Device output exceeded the safe pagination limit.'),{code:'DEVICE_OUTPUT_PAGE_LIMIT',partial:true}));}
                    pagingTail='';
                    this.stream.write(' '); // Space to scroll
                    clearTimeout(timer);
                    return;
                }

                // --- DYNAMIC INTERACTION HANDLER ---

                // Huawei: command options prompt { <cr>|... }
                if (chunk.includes('{ <cr>')) {
                    this.stream.write('\r\n');
                    clearTimeout(timer);
                    return;
                }

                // Generic Confirmation: (y/n)
                if (!confirmationSent && (buffer.toLowerCase().includes('(y/n)') || buffer.toLowerCase().includes('[y/n]'))) {
                    confirmationSent = true;
                    this.stream.write('y\r');
                    clearTimeout(timer);
                    return;
                }

                // Complete only after the actual device prompt, never merely because a page is quiet.
                const prompt=plain.match(/(?:^|\n)([^\n]{1,120}[#>$%])\s*$/);
                if(prompt){this.initialPrompt=this.initialPrompt||prompt[1].trim();scheduleFinish(Math.min(200,waitMs));}
            };
            const onError = error => { cleanup(); reject(error); };

            this.stream.on('data', onData);
            this.stream.once('error', onError);
            // Huawei confirmation prompts can consume the LF from CRLF as the
            // default "n" response. Send CR only for commands known to ask.
            // Huawei MA56xx/MA58xx interactive CLIs treat LF as an additional
            // keystroke.  After paged or option-prompt output that extra byte
            // can consume the first character/space of the following command.
            // A carriage return is the native line terminator for these OLTs.
            this.stream.write(cmd + (this.isHuawei() || /^load file tftp\s/i.test(cmd) ? '\r' : '\r\n'));
            hardTimer = setTimeout(() => { cleanup(); reject(Object.assign(new Error(`Command timeout after ${this.commandTimeout}ms`),{code:'COMMAND_TIMEOUT'})); }, this.commandTimeout);
        });
    }

    /**
     * Generic session wrapper.
     * Unlike the old 'runOLTSession', this does NOT inject 'enable' or 'config'.
     * It simply provides the 'send' function to the callback.
     */
    async runShellSession(callback) {
        if (!this.stream) await this.createShell();

        try {
            // Pass the bounded sendCommand to the callback
            const result = await callback(this.sendCommand.bind(this));
            return result;
        } catch (error) {
            throw error;
        }
    }

    close() {
        if (this.stream) { this.stream.removeAllListeners(); this.stream.end(); this.stream = null; }
        if (this.client) this.client.end();
    }

    getDiagnostics() { return { ...this.diagnostics, debug:undefined }; }
}

module.exports = SSHSession;
